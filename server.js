// SoBe Rollers — admin server (runs on Render as a Web Service).
// Checks the admin password, saves website edits into the site's GitHub repo,
// stores uploaded pictures there, and asks Claude for "Describe a change".
// The website itself stays a fast static site; after each save this server
// asks Render to republish it (about a minute).
//
// Settings (Render → this service → Environment):
//   ADMIN_PASSWORD      the password for "Admin sign in"            (required)
//   GITHUB_TOKEN        token that can write to the site's repo     (required to save)
//   RENDER_DEPLOY_HOOK  the static site's Deploy Hook URL           (required to publish)
//   ANTHROPIC_API_KEY   turns on "Describe a change" + Run          (optional)
//   GITHUB_REPO         default andersonirmler/soberollers-site
//   GITHUB_BRANCH       default main
//   DATA_REPO           PRIVATE repo for registrations, default andersonirmler/soberollers-data
import http from 'node:http';
import crypto from 'node:crypto';

const ENV = process.env;
const REPO = ENV.GITHUB_REPO || 'andersonirmler/soberollers-site';
const BRANCH = ENV.GITHUB_BRANCH || 'main';
const GH = (ENV.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
const ANTHROPIC = (ENV.ANTHROPIC_API || 'https://api.anthropic.com').replace(/\/$/, '');
const DATA_REPO = ENV.DATA_REPO || 'andersonirmler/soberollers-data';
const PAGE = 'index.html';
const OPEN = '<script type="application/json" id="mim-content">';
const ORIGINS = (ENV.ALLOWED_ORIGINS || 'https://soberollers.com,https://www.soberollers.com,https://soberollers-site.onrender.com').split(',').map(s => s.trim()).filter(Boolean);
const MODELS = { quick: 'claude-haiku-5-5', default: 'claude-sonnet-5-5' };

/* ---------- sessions: signed token, 12 hours ---------- */
const secret = () => crypto.createHash('sha256').update('sbr-session|' + (ENV.SESSION_SECRET || '') + '|' + (ENV.ADMIN_PASSWORD || '')).digest();
function makeToken() {
  const exp = String(Date.now() + 12 * 3600 * 1000);
  return exp + '.' + crypto.createHmac('sha256', secret()).update(exp).digest('hex');
}
function checkToken(t) {
  if (!ENV.ADMIN_PASSWORD || typeof t !== 'string') return false;
  const [exp, sig] = t.split('.');
  if (!/^\d+$/.test(exp || '') || !/^[a-f0-9]{64}$/.test(sig || '') || Number(exp) < Date.now()) return false;
  const good = crypto.createHmac('sha256', secret()).update(exp).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function samePassword(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const tries = new Map(); // ip -> [timestamps]
function tooMany(ip) {
  const now = Date.now(), list = (tries.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  tries.set(ip, list); return list.length >= 10;
}

/* ---------- GitHub ---------- */
async function gh(path, opts = {}, repo = REPO) {
  const r = await fetch(GH + '/repos/' + repo + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + ENV.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'soberollers-admin', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }
  });
  return r;
}
async function getFile(path) {
  const r = await gh('/contents/' + path + '?ref=' + BRANCH);
  if (!r.ok) throw Object.assign(new Error('github read ' + r.status), { status: 502 });
  const j = await r.json();
  return { sha: j.sha, text: Buffer.from(j.content, 'base64').toString('utf8') };
}
async function putFile(path, buf, message, sha) {
  return gh('/contents/' + path, { method: 'PUT', body: JSON.stringify({ message, branch: BRANCH, content: Buffer.from(buf).toString('base64'), ...(sha ? { sha } : {}) }) });
}
async function redeploy() {
  if (!ENV.RENDER_DEPLOY_HOOK) return false;
  try { const r = await fetch(ENV.RENDER_DEPLOY_HOOK, { method: 'POST' }); return r.ok; } catch { return false; }
}

/* ---------- validation: text and pictures only, never HTML or code ---------- */
const clean = (s, max) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
const UPLOAD = /^\/uploads\/[a-f0-9-]{36}\.(webp|png|jpe?g|gif)$/;
function cleanSet(t, i, html) {
  const text = {}, img = {};
  for (const [k, v] of Object.entries((t && t.text) || {})) {
    if (!/^t\d{1,6}$/.test(k) || !v || typeof v.orig !== 'string' || typeof v.en !== 'string' || !v.en.trim()) throw new Error('bad text');
    text[k] = { orig: clean(v.orig, 4000), en: clean(v.en, 4000) };
  }
  for (const [k, v] of Object.entries((i && i.img) || {})) {
    if (typeof k !== 'string' || k.length > 800 || !html.includes(k.replace(/&/g, '&amp;')) && !html.includes(k)) throw new Error('bad picture key');
    if (!v || typeof v.src !== 'string' || !(UPLOAD.test(v.src) || html.includes(v.src) || html.includes(v.src.replace(/&/g, '&amp;')))) throw new Error('bad picture');
    if (/^\s*(javascript|data|vbscript):/i.test(v.src)) throw new Error('bad picture');
    img[k] = { src: v.src, alt: clean(v.alt || '', 300) };
  }
  return { text, img };
}
function cleanContent(c, html) {
  if (!c || typeof c !== 'object') throw new Error('bad content');
  const cur = cleanSet(c, c, html);
  const history = (Array.isArray(c.history) ? c.history : []).slice(0, 15).map(h => {
    const s = cleanSet(h, h, html);
    const at = new Date(h.at); if (isNaN(at)) throw new Error('bad date');
    return { at: at.toISOString(), label: clean(h.label || 'Update', 200), text: s.text, img: s.img };
  });
  return { v: 1, text: cur.text, img: cur.img, history, saved_at: new Date().toISOString() + '-' + crypto.randomBytes(3).toString('hex') };
}
function embed(html, content) {
  const i = html.indexOf(OPEN), j = html.indexOf('</script>', i);
  if (i < 0 || j < 0) throw Object.assign(new Error('page is missing the content block'), { status: 500 });
  // Escape "<" so nothing in an edit can ever end the script block
  const json = JSON.stringify(content).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return html.slice(0, i + OPEN.length) + json + html.slice(j);
}


/* ---------- registrations: one private file per skater, never deleted ---------- */
const REG_ID = /^SM27-[A-Z0-9]{4,16}-[A-Z0-9]{4}$/;
const REG_FIELDS = { pass: 10, first_name: 80, last_name: 80, email: 200, phone: 40, dob: 10, gender: 10, street: 200, city: 100, state: 100, zip: 20, country: 100, tshirt: 4, team: 120, discount_code: 60, ec_name: 120, ec_relationship: 80, ec_phone: 40, medical: 2000, guardian_name: 120, guardian_email: 200, guardian_phone: 40, agree_refund: 3, agree_waiver: 3, agree_rules: 3, signature: 120, guardian_signature: 120, signed_at: 40 };
const RANK = { started: 0, pending: 1, paid: 2 };
const regHits = new Map();
function regTooMany(ip) {
  const now = Date.now(), list = (regHits.get(ip) || []).filter(t => now - t < 60 * 60 * 1000);
  list.push(now); regHits.set(ip, list); return list.length > 120;
}
const dgh = (path, opts) => gh(path, opts, DATA_REPO);
async function readReg(id) {
  const r = await dgh('/contents/registrations/' + id + '.json?ref=' + BRANCH);
  if (r.status === 404) return null;
  if (!r.ok) throw Object.assign(new Error('data read ' + r.status), { status: 502 });
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) };
}
async function writeReg(id, change, message) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await readReg(id);
    const next = change(cur ? cur.data : null);
    if (!next) return cur && cur.data;
    const r = await dgh('/contents/registrations/' + id + '.json', { method: 'PUT', body: JSON.stringify({ message, branch: BRANCH, content: Buffer.from(JSON.stringify(next, null, 2)).toString('base64'), ...(cur ? { sha: cur.sha } : {}) }) });
    if (r.ok) { cache.set(id, next); return next; }
    if (r.status === 409 || r.status === 422) continue;
    throw Object.assign(new Error('data write ' + r.status), { status: 502 });
  }
  throw Object.assign(new Error('conflict'), { status: 409 });
}
const cache = new Map(); // id -> data, plus blob sha cache
const blobCache = new Map();
async function listRegs() {
  const r = await dgh('/git/trees/' + BRANCH + '?recursive=1');
  if (r.status === 404 || r.status === 409) return []; // empty repo
  if (!r.ok) throw Object.assign(new Error('data list ' + r.status), { status: 502 });
  const files = ((await r.json()).tree || []).filter(f => f.type === 'blob' && /^registrations\/SM27-[A-Z0-9-]+\.json$/.test(f.path));
  const out = [];
  for (let i = 0; i < files.length; i += 8) {
    out.push(...await Promise.all(files.slice(i, i + 8).map(async f => {
      if (blobCache.has(f.sha)) return blobCache.get(f.sha);
      const b = await dgh('/git/blobs/' + f.sha);
      if (!b.ok) return null;
      try { const d = JSON.parse(Buffer.from((await b.json()).content, 'base64').toString('utf8')); blobCache.set(f.sha, d); return d; } catch { return null; }
    })));
  }
  return out.filter(Boolean);
}

/* ---------- HTTP ---------- */
function send(res, status, data, origin) {
  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (origin && ORIGINS.includes(origin)) Object.assign(h, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
  res.writeHead(status, h); res.end(JSON.stringify(data));
}
function readJSON(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > max) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

const routes = {
  async 'POST /api/login'(b, ip) {
    if (!ENV.ADMIN_PASSWORD) return [503, { error: 'ADMIN_PASSWORD is not set on the server.' }];
    if (tooMany(ip)) return [429, { error: 'Too many tries. Wait a few minutes.' }];
    if (typeof b.password !== 'string' || !samePassword(b.password, ENV.ADMIN_PASSWORD)) { tries.get(ip).push(Date.now()); return [401, { error: 'wrong password' }]; }
    tries.delete(ip);
    return [200, { token: makeToken() }];
  },
  async 'POST /api/content'(b) {
    if (!checkToken(b.token)) return [401, { error: 'signed out' }];
    if (!ENV.GITHUB_TOKEN) return [503, { error: 'GITHUB_TOKEN is not set on the server.' }];
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = await getFile(PAGE);
      let content;
      try { content = cleanContent(b.content, page.text); } catch (e) { return [400, { error: e.message }]; }
      const label = (content.history[0] && content.history[0].label) || 'Website edit';
      const r = await putFile(PAGE, embed(page.text, content), 'Website edit: ' + label.slice(0, 120), page.sha);
      if (r.status === 409 || r.status === 422) continue; // someone saved at the same moment: try again on the newest version
      if (!r.ok) return [502, { error: 'github write ' + r.status }];
      const deployed = await redeploy();
      return [200, { ok: true, stamp: content.saved_at, deployed }];
    }
    return [409, { error: 'conflict' }];
  },
  async 'POST /api/upload'(b) {
    if (!checkToken(b.token)) return [401, { error: 'signed out' }];
    if (!ENV.GITHUB_TOKEN) return [503, { error: 'GITHUB_TOKEN is not set on the server.' }];
    const m = /^data:image\/(webp|png|jpeg|gif);base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUrl || '');
    if (!m) return [400, { error: 'not a picture' }];
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 6e6) return [400, { error: 'picture too big' }];
    const sig = { webp: [0x52, 0x49, 0x46, 0x46], png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], gif: [0x47, 0x49, 0x46] }[m[1]];
    if (!sig.every((v, i) => bytes[i] === v)) return [400, { error: 'not a picture' }];
    const path = 'uploads/' + crypto.randomUUID() + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    const r = await putFile(path, bytes, 'Upload picture');
    if (!r.ok) return [502, { error: 'github write ' + r.status }];
    return [200, { url: '/' + path }];
  },
  async 'POST /api/ai'(b) {
    if (!checkToken(b.token)) return [401, { error: 'signed out' }];
    if (!ENV.ANTHROPIC_API_KEY) return [503, { error: 'AI is not set up (ANTHROPIC_API_KEY).' }];
    if (typeof b.prompt !== 'string' || !b.prompt.trim() || b.prompt.length > 400000) return [400, { error: 'empty' }];
    const r = await fetch(ANTHROPIC + '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ENV.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ENV.ANTHROPIC_MODEL || MODELS[b.tier] || MODELS.default, max_tokens: 8000, messages: [{ role: 'user', content: b.prompt }] })
    });
    if (!r.ok) return [502, { error: 'AI error ' + r.status }];
    const d = await r.json();
    return [200, { text: (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('') }];
  },
  async 'POST /api/register'(b, ip) {
    if (!ENV.GITHUB_TOKEN) return [503, { error: 'not set up' }];
    if (regTooMany(ip)) return [429, { error: 'Too many saves. Wait a little.' }];
    const id = String(b.registration_id || '');
    if (!REG_ID.test(id)) return [400, { error: 'bad id' }];
    const status = b.status === 'pending' ? 'pending' : 'started';
    const step = Math.max(1, Math.min(5, parseInt(b.step, 10) || 1));
    const incoming = {};
    for (const [k, max] of Object.entries(REG_FIELDS)) if (b[k] != null && b[k] !== '') incoming[k] = clean(b[k], max);
    if (incoming.pass && !/^(full|thu|fri|sat|sun)$/.test(incoming.pass)) return [400, { error: 'bad pass' }];
    const age = Number(b.age_on_event_day); const price = Number(b.price);
    const now = new Date().toISOString();
    const saved = await writeReg(id, cur => {
      const base = cur || { registration_id: id, created_at: now, status: 'started', payment_status: 'unpaid', step: 0, history: [] };
      const next = { ...base, ...incoming, updated_at: now };
      if (Number.isFinite(age) && age >= 0 && age < 120) next.age_on_event_day = Math.floor(age);
      if (Number.isFinite(price) && price >= 0 && price < 10000) next.price = price;
      if ((RANK[status] || 0) > (RANK[base.status] || 0)) next.status = status;
      next.step = Math.max(base.step || 0, step);
      // keep every version ever typed in, newest first (memory of all info entered)
      const changed = Object.keys(incoming).filter(k => incoming[k] !== base[k]);
      if (changed.length) next.history = [{ at: now, step, values: Object.fromEntries(changed.map(k => [k, incoming[k]])) }, ...(base.history || [])].slice(0, 200);
      return next;
    }, 'Registration ' + id + ' (' + status + ', step ' + step + ')');
    return [200, { ok: true, registration_id: id, status: saved.status }];
  },
  async 'POST /api/registrations'(b) {
    if (!checkToken(b.token)) return [401, { error: 'signed out' }];
    if (!ENV.GITHUB_TOKEN) return [503, { error: 'GITHUB_TOKEN is not set on the server.' }];
    return [200, { registrations: await listRegs() }];
  },
  async 'POST /api/update'(b) {
    if (!checkToken(b.token)) return [401, { error: 'signed out' }];
    const id = String(b.registration_id || '');
    if (!REG_ID.test(id)) return [400, { error: 'bad id' }];
    const now = new Date().toISOString();
    const saved = await writeReg(id, cur => {
      if (!cur) return null;
      const next = { ...cur, updated_at: now };
      if (b.bib != null) next.bib = clean(b.bib, 12).trim();
      if (b.checked_in != null) { next.checked_in = !!b.checked_in; next.checked_in_at = b.checked_in ? now : null; }
      if (b.payment_status === 'paid' && cur.payment_status !== 'paid') { next.payment_status = 'paid'; next.status = 'paid'; next.amount_paid = cur.price; next.paid_at = now; }
      if (b.payment_status === 'pending' && cur.payment_status === 'paid') { next.payment_status = 'unpaid'; next.status = 'pending'; next.amount_paid = null; }
      return next;
    }, 'Admin update ' + id);
    if (!saved) return [404, { error: 'not found' }];
    return [200, { ok: true, registration: saved }];
  },
  async 'GET /api/health'() { return [200, { ok: true, password: !!ENV.ADMIN_PASSWORD, github: !!ENV.GITHUB_TOKEN, deployHook: !!ENV.RENDER_DEPLOY_HOOK, ai: !!ENV.ANTHROPIC_API_KEY, dataRepo: DATA_REPO }]; }
};

http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const path = req.url.split('?')[0].replace(/\/$/, '') || '/';
  if (req.method === 'OPTIONS') {
    const h = { 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
    if (origin && ORIGINS.includes(origin)) Object.assign(h, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    res.writeHead(204, h); return res.end();
  }
  if (path === '/') return send(res, 200, { service: 'SoBe Rollers admin', ok: true }, origin);
  const fn = routes[req.method + ' ' + path];
  if (!fn) return send(res, 404, { error: 'not found' }, origin);
  if (req.method === 'POST' && origin && !ORIGINS.includes(origin)) return send(res, 403, { error: 'origin' }, origin);
  try {
    const b = req.method === 'POST' ? await readJSON(req, path === '/api/upload' ? 9e6 : 1.5e6) : {};
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const [status, data] = await fn(b, ip);
    send(res, status, data, origin);
  } catch (e) {
    send(res, e.status || (/too big|bad json/.test(e.message) ? 400 : 500), { error: e.message }, origin);
  }
}).listen(Number(ENV.PORT) || 10000, () => console.log('SoBe Rollers admin server ready'));
