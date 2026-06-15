const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();

app.use(cors());
app.use(express.json());

// --- Auto-update version from official JIMMY source ---

const SOURCE_INDEX_URL = 'https://jimmy-iota.vercel.app/index.json';
const SOURCE_MANIFEST_URL = 'https://jimmy-iota.vercel.app/manifest.json';
const UPDATE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const FALLBACK_VERSION = '2.0.0';

let currentVersion = FALLBACK_VERSION;
let currentCodeVersion = 200;

async function fetchSourceVersion() {
  try {
    const res = await withTimeout(fetch(SOURCE_INDEX_URL), 10000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data['category:modules']) {
      const jimmy = data['category:modules'].find(m => m.id === 'jimmy');
      if (jimmy && jimmy.version) {
        currentVersion = jimmy.version;
        currentCodeVersion = jimmy.code || 200;
        console.log(`[JIMMY] Version synced from source: v${currentVersion} (code ${currentCodeVersion})`);
        return;
      }
    }
  } catch (e) {
    console.warn('[JIMMY] index.json fetch failed, trying manifest.json:', e.message);
  }
  try {
    const res = await withTimeout(fetch(SOURCE_MANIFEST_URL), 10000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.version) {
      currentVersion = data.version;
      console.log(`[JIMMY] Version synced from manifest: v${currentVersion}`);
      return;
    }
  } catch (e) {
    console.warn('[JIMMY] manifest.json fetch failed, using fallback:', e.message);
  }
  console.log(`[JIMMY] Using fallback version: v${currentVersion}`);
}

function startAutoUpdate() {
  fetchSourceVersion();
  setInterval(fetchSourceVersion, UPDATE_INTERVAL_MS);
}

// --- Config (from JIMMY v1.6.16) ---

const QOBUZ = {
  appId: '312369995',
  userToken: 'XX7seyZt4OaHGPgksFUldL2Ig0cH6jqcKSAfOAiAGBzw1HosDl9vfQTGRQEo2zkkcwP9ADc3L20nYNaI0l7E4g',
  secret: 'e79f8b9be485692b0e5f9dd895826368',
  base: 'https://www.qobuz.com/api.json/0.2'
};

const TIDAL_SEARCH = 'https://monochrome-api.samidy.com';
const BACKEND_CACHE_BASE = 'https://lateralus-backend.onrender.com';
const BACKEND_CACHE_TOKEN = '230366616b3c69b13f3e11d07e633be855a36a4e9c9ec971152f50516dbee2ae';

const REQUEST_TIMEOUT_MS = 12000;

// --- Helpers ---

function normalize(s) {
  if (!s) return '';
  let out = String(s).toLowerCase();
  if (typeof out.normalize === 'function') {
    out = out.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  }
  return out
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/feat\.?|featuring|ft\.?|with\s+/gi, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = {};
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.substr(i, 2);
    bigrams[bg] = (bigrams[bg] || 0) + 1;
  }
  let hits = 0;
  for (let j = 0; j < b.length - 1; j++) {
    const bg2 = b.substr(j, 2);
    if (bigrams[bg2]) { bigrams[bg2]--; hits++; }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

function fetchJSON(url, opts, timeoutMs) {
  opts = opts || {};
  return withTimeout(
    fetch(url, opts).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
      return r.json();
    }),
    timeoutMs || REQUEST_TIMEOUT_MS
  );
}

// --- MD5 (Qobuz request signing) ---

function md5(str) {
  return crypto.createHash('md5').update(String(str)).digest('hex');
}

// --- Quality labels ---

function qualityLabel(bit, sr, fmt, audioModes) {
  const fmtLower = String(fmt || 'flac').toLowerCase();
  if (fmtLower.indexOf('mp3') >= 0) return 'MP3 320kbps';
  if (fmtLower.indexOf('aac') >= 0) return 'AAC 320kbps';
  bit = parseInt(bit, 10) || 16;
  sr = parseFloat(sr) || 44.1;
  if (sr > 1000) sr = sr / 1000;
  const srStr = (sr === Math.floor(sr)) ? String(sr) : String(sr.toFixed(1));
  let hasAtmos = false;
  if (audioModes) {
    for (let i = 0; i < audioModes.length; i++) {
      if (String(audioModes[i]).toUpperCase() === 'DOLBY_ATMOS') { hasAtmos = true; break; }
    }
  }
  const prefix = (bit >= 24) ? 'HI-RES' : 'LOSSLESS';
  let label = prefix + ' ' + bit + '-bit/' + srStr + 'kHz';
  if (hasAtmos) label += ' ATMOS';
  return label;
}

// --- Tidal helpers ---

function tidalCoverUrl(uuid) {
  if (!uuid || typeof uuid !== 'string') return null;
  if (uuid.indexOf('http') === 0) return uuid;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) return uuid;
  return 'https://resources.tidal.com/images/' + uuid.replace(/-/g, '/') + '/640x640.jpg';
}

function tidalArtistPic(uuid) {
  if (!uuid || typeof uuid !== 'string') return null;
  if (uuid.indexOf('http') === 0) return uuid;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) return uuid;
  return 'https://resources.tidal.com/images/' + uuid.replace(/-/g, '/') + '/750x750.jpg';
}

function tidalMapTrack(t) {
  if (!t || !t.id) return null;
  const artistName = (t.artist && t.artist.name) ||
    (t.artists && t.artists[0] && t.artists[0].name) || 'Unknown Artist';
  const aq = String(t.audioQuality || 'LOSSLESS').toUpperCase();
  const modes = Array.isArray(t.audioModes) ? t.audioModes : [];
  let bit = 16, sr = 44.1, fmt = 'flac';
  if (aq === 'HI_RES_LOSSLESS') { bit = 24; sr = 96; fmt = 'flac'; }
  else if (aq === 'HI_RES') { bit = 24; sr = 48; fmt = 'mqa'; }
  else if (aq === 'LOSSLESS') { bit = 16; sr = 44.1; fmt = 'flac'; }
  else { bit = 16; sr = 44.1; fmt = 'aac'; }
  return {
    id: 'tidal:' + t.id,
    title: t.title || 'Unknown',
    artist: artistName,
    album: (t.album && t.album.title) || 'Unknown Album',
    artworkURL: tidalCoverUrl(t.album && t.album.cover),
    duration: t.duration || 0,
    isrc: t.isrc || null,
    format: fmt === 'mqa' ? 'flac' : fmt,
    audioQuality: qualityLabel(bit, sr, fmt, modes),
    _bit: bit, _sr: sr, _fmt: fmt, _modes: modes,
    _provider: 'Tidal'
  };
}

function tidalMapAlbum(a) {
  if (!a) return null;
  const aq = String(a.audioQuality || 'LOSSLESS').toUpperCase();
  let bit = 16, sr = 44.1;
  if (aq === 'HI_RES_LOSSLESS') { bit = 24; sr = 96; }
  return {
    id: 'tidal:' + a.id,
    title: a.title || 'Unknown',
    artist: (a.artist && a.artist.name) || 'Unknown Artist',
    artworkURL: tidalCoverUrl(a.cover),
    year: a.releaseDate ? a.releaseDate.substring(0, 4) : null,
    trackCount: a.numberOfTracks || 0,
    description: a.description || null,
    audioQuality: qualityLabel(bit, sr, 'flac', Array.isArray(a.audioModes) ? a.audioModes : [])
  };
}

function tidalMapArtist(a) {
  if (!a) return null;
  return {
    id: 'tidal:' + a.id,
    name: a.name || 'Unknown',
    artworkURL: tidalArtistPic(a.picture)
  };
}

// --- Qobuz helpers ---

function qobuzApi(endpoint, params) {
  let url = QOBUZ.base + endpoint + '?app_id=' + QOBUZ.appId + '&user_auth_token=' + QOBUZ.userToken;
  if (params) {
    for (const k in params) {
      if (params[k] != null) url += '&' + k + '=' + encodeURIComponent(params[k]);
    }
  }
  return fetchJSON(url);
}

function qobuzMapTrack(t) {
  if (!t || !t.id) return null;
  const bit = t.maximum_bit_depth || 16;
  const sr = t.maximum_sampling_rate || 44.1;
  const perfName = (t.performer && t.performer.name) || '';
  const albArtistName = (t.album && t.album.artist && t.album.artist.name) || '';
  const artistName = perfName || albArtistName || 'Unknown Artist';
  const cover = (t.album && t.album.image && (t.album.image.large || t.album.image.small)) || null;
  return {
    id: 'qobuz:' + t.id,
    title: t.title || 'Unknown',
    artist: artistName,
    album: (t.album && t.album.title) || '',
    artworkURL: cover,
    duration: t.duration || 0,
    isrc: t.isrc || null,
    format: 'flac',
    audioQuality: qualityLabel(bit, sr, 'flac', []),
    _bit: bit, _sr: sr, _fmt: 'flac', _modes: [],
    _provider: 'Qobuz'
  };
}

function qobuzMapAlbum(a) {
  if (!a) return null;
  const cover = (a.image && (a.image.large || a.image.small)) || null;
  return {
    id: 'qobuz:' + a.id,
    title: a.title || 'Unknown',
    artist: (a.artist && a.artist.name) || 'Unknown Artist',
    artworkURL: cover,
    year: a.released_at ? String(new Date(a.released_at * 1000).getFullYear()) : null,
    trackCount: a.tracks_count || 0,
    description: a.description || a.catchline || null,
    audioQuality: qualityLabel(a.maximum_bit_depth || 16, a.maximum_sampling_rate || 44.1, 'flac', [])
  };
}

function qobuzMapArtist(a) {
  if (!a) return null;
  let pic = null;
  if (a.image && (a.image.large || a.image.medium || a.image.small)) {
    pic = a.image.large || a.image.medium || a.image.small;
  } else if (a.picture) pic = a.picture;
  return {
    id: 'qobuz:' + a.id,
    name: a.name || 'Unknown',
    artworkURL: pic,
    albumCount: a.albums_count || 0
  };
}

// --- Provider search ---

async function qobuzSearch(query, limit) {
  try {
    const data = await qobuzApi('/track/search', { query, limit: limit || 25 });
    const items = (data && data.tracks && data.tracks.items) || [];
    return items.map(qobuzMapTrack).filter(Boolean);
  } catch { return []; }
}

async function tidalSearch(query, limit) {
  try {
    const url = BACKEND_CACHE_BASE + '/search/?query=' + encodeURIComponent(query) +
      '&limit=' + (limit || 50) + '&type=tracks';
    const res = await withTimeout(
      fetch(url, { headers: { 'X-Cache-Token': BACKEND_CACHE_TOKEN } }),
      REQUEST_TIMEOUT_MS
    );
    if (!res.ok) return [];
    const data = await res.json();
    const items = (data && data.tracks) || [];
    return items.map(tidalMapTrack).filter(Boolean);
  } catch { return []; }
}

async function qobuzSearchAlbums(query, limit) {
  try {
    const data = await qobuzApi('/album/search', { query, limit: limit || 20 });
    const items = (data && data.albums && data.albums.items) || [];
    return items.map(qobuzMapAlbum).filter(Boolean);
  } catch { return []; }
}

async function tidalSearchAlbums(query, limit) {
  try {
    const url = TIDAL_SEARCH + '/search/?s=' + encodeURIComponent(query) +
      '&limit=' + (limit || 25) + '&type=albums';
    const data = await fetchJSON(url);
    const items = (data && data.data && (data.data.albums || data.data.items)) || [];
    return items.map(tidalMapAlbum).filter(Boolean);
  } catch { return []; }
}

async function qobuzSearchArtists(query, limit) {
  try {
    const data = await qobuzApi('/artist/search', { query, limit: limit || 20 });
    const items = (data && data.artists && data.artists.items) || [];
    return items.map(qobuzMapArtist).filter(Boolean);
  } catch { return []; }
}

async function tidalSearchArtists(query, limit) {
  try {
    const url = TIDAL_SEARCH + '/search/?s=' + encodeURIComponent(query) +
      '&limit=' + (limit || 25) + '&type=artists';
    const data = await fetchJSON(url);
    const items = (data && data.data && (data.data.artists || data.data.items)) || [];
    return items.map(tidalMapArtist).filter(Boolean);
  } catch { return []; }
}

// --- Dedup helpers ---

function trackKey(t) {
  return normalize(t.title) + '|' + normalize(t.artist) + '|' + (t.duration || 0);
}

function mergeTracks(arrays) {
  const seen = new Map();
  const out = [];
  for (const arr of arrays) {
    for (const t of arr) {
      const key = trackKey(t);
      if (seen.has(key)) {
        const existing = seen.get(key);
        if (t._bit > existing._bit || (t._bit === existing._bit && t._sr > existing._sr)) {
          existing.id = t.id;
          existing.audioQuality = t.audioQuality;
          existing._provider = t._provider;
          existing._bit = t._bit;
          existing._sr = t._sr;
          existing.isrc = t.isrc || existing.isrc;
          existing.artworkURL = t.artworkURL || existing.artworkURL;
        }
      } else {
        const clone = Object.assign({}, t);
        delete clone._bit; delete clone._sr; delete clone._fmt;
        delete clone._modes; delete clone._provider;
        seen.set(key, t);
        out.push(clone);
      }
    }
  }
  return out;
}

function mergeAlbums(arrays) {
  const seen = new Map();
  const out = [];
  for (const arr of arrays) {
    for (const a of arr) {
      const key = normalize(a.title) + '|' + normalize(a.artist);
      if (!seen.has(key)) {
        seen.set(key, true);
        out.push(a);
      }
    }
  }
  return out;
}

function mergeArtists(arrays) {
  const seen = new Map();
  const out = [];
  for (const arr of arrays) {
    for (const a of arr) {
      const key = normalize(a.name);
      if (!seen.has(key)) {
        seen.set(key, true);
        out.push(a);
      }
    }
  }
  return out;
}

// --- Landing Page ---

function landingPage(baseUrl) {
  const addonUrl = baseUrl + '/manifest.json';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JIMMY x Eclipse — Hear the piracy.</title>
<meta name="description" content="JIMMY — Hear the piracy. Hi-fidelity hybrid Eclipse addon pulling Qobuz + Tidal back-to-back. Lossless / Hi-Res / 192kHz / Dolby Atmos.">
<meta property="og:title" content="JIMMY x Eclipse — Hear the piracy.">
<meta property="og:description" content="Hi-fi hybrid pulling Qobuz + Tidal back-to-back. Lossless, Hi-Res, Dolby Atmos streaming for Eclipse Music.">
<meta property="og:image" content="https://jimmy-iota.vercel.app/icon.png">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{background:#000;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
  body{min-height:100vh;display:flex;flex-direction:column;line-height:1.5}
  nav{padding:24px 32px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #0e0e0e}
  nav .brand{font-size:12px;letter-spacing:2.5px;font-weight:900;color:#666;text-transform:uppercase}
  nav .brand b{color:#fff;font-weight:900}
  nav .brand i{font-style:normal;color:#444;margin:0 6px}
  nav a{color:#666;text-decoration:none;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;font-weight:800}
  nav a:hover{color:#fff}
  main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;gap:32px}
  .card{background:linear-gradient(180deg,#0c0c0c 0%,#080808 100%);border:1px solid #1a1a1a;border-radius:24px;padding:48px 32px;max-width:520px;width:100%;text-align:center;position:relative;overflow:hidden}
  .card::before{content:'';position:absolute;top:-1px;left:50%;transform:translateX(-50%);width:60%;height:1px;background:linear-gradient(90deg,transparent 0%,rgba(255,80,80,.4) 50%,transparent 100%)}
  .card .icon{width:200px;height:200px;margin:0 auto 28px;display:block;object-fit:contain;filter:drop-shadow(0 24px 48px rgba(255,80,80,.28)) drop-shadow(0 2px 0 rgba(255,255,255,.04))}
  .card h1{font-family:'Arial Black','Helvetica Neue',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:60px;letter-spacing:-2px;font-weight:900;line-height:1;margin-bottom:10px;text-transform:uppercase;-webkit-text-stroke:1px #fff}
  .card h1 sup{font-size:18px;letter-spacing:0;font-weight:700;vertical-align:super;color:#bbb;-webkit-text-stroke:0;margin-left:4px;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif}
  .card .meta{font-size:11px;color:#666;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:24px;font-weight:800}
  .card .meta b{color:#bbb;font-weight:800}
  .card .meta i{font-style:normal;color:#333;margin:0 8px}
  .card .slogan{font-size:20px;color:#fff;font-weight:800;letter-spacing:-.4px;margin-bottom:14px;font-style:italic}
  .card .desc{font-size:14px;color:#9a9a9a;max-width:420px;margin:0 auto 28px;line-height:1.65}
  .card .tags{display:flex;gap:6px;justify-content:center;flex-wrap:wrap}
  .card .tag{font-size:10px;padding:7px 12px;background:#111;border:1px solid #1f1f1f;border-radius:99px;color:#a0a0a0;letter-spacing:1.5px;font-weight:800;text-transform:uppercase}
  .cta{text-align:center;max-width:520px;width:100%}
  .cta .button{display:inline-flex;align-items:center;justify-content:center;gap:10px;background:#fff;color:#000;font-weight:900;font-size:14px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;padding:20px 36px;border-radius:14px;width:100%;max-width:320px;transition:transform .15s ease,box-shadow .15s ease;box-shadow:0 8px 32px -8px rgba(255,255,255,.18)}
  .cta .button:hover{transform:translateY(-1px);box-shadow:0 14px 44px -8px rgba(255,255,255,.28)}
  .cta .button:active{transform:translateY(0)}
  .cta p{font-size:14px;color:#888;margin-top:24px;line-height:1.6;max-width:380px;margin-left:auto;margin-right:auto}
  .url-box{display:flex;gap:0;max-width:420px;width:100%;margin:0 auto;border:1px solid #1f1f1f;border-radius:12px;overflow:hidden;background:#0a0a0a}
  .url-box input{flex:1;background:transparent;border:none;color:#ccc;font-size:13px;padding:14px 16px;font-family:'SF Mono','Fira Code','Cascadia Code',monospace;outline:none;min-width:0}
  .url-box input::selection{background:rgba(255,80,80,.3)}
  .copy-btn{background:#fff;color:#000;border:none;border-radius:12px;padding:12px 22px;font-size:13px;font-weight:700;cursor:pointer;transition:all .25s ease;white-space:nowrap}
  .copy-btn:hover{background:#f0f0f0;transform:translateY(-1px)}
  .copy-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#22c55e;color:#000;padding:8px 20px;border-radius:8px;font-size:13px;font-weight:600;opacity:0;transition:opacity .3s;pointer-events:none;z-index:100}
  .copy-toast.show{opacity:1}
  footer{padding:32px 24px 24px;text-align:center;color:#444;font-size:12px;letter-spacing:.3px;border-top:1px solid #0e0e0e}
  footer a{color:#777;text-decoration:none}
  footer a:hover{color:#fff}
  footer .links{display:flex;gap:10px;justify-content:center;align-items:center;flex-wrap:wrap}
  footer .sep{color:#222}
  footer .discord{color:#777}
  footer .discord b{color:#bbb;font-weight:700}
  footer .disclaimer{margin-top:10px;color:#2a2a2a;font-size:10px;letter-spacing:.2px}
  @media(max-width:600px){
    nav{padding:18px 20px}
    nav a.gh{display:none}
    main{padding:32px 16px}
    .card{padding:36px 24px;border-radius:20px}
    .card h1{font-size:48px;letter-spacing:-1.5px}
    .card h1 sup{font-size:14px}
    .card .icon{width:160px;height:160px;margin-bottom:24px}
    .cta .button{padding:18px 28px;font-size:13px}
  }
</style>
</head>
<body>
<nav>
  <div class="brand"><b>Eclipse</b><i>x</i><b>JIMMY</b></div>
  <a href="https://github.com/bacard1i" class="gh">GitHub</a>
</nav>

<main>
  <section class="card">
    <img src="https://jimmy-iota.vercel.app/icon.png" class="icon" alt="JIMMY">
    <h1>JIMMY<sup>&reg;</sup></h1>
    <div class="meta"><b>v${currentVersion}</b><i>·</i>by Lateralus</div>
    <p class="slogan">Hear the piracy.</p>
    <p class="desc">Jimmy's a high fidelity hybrid music module, which uses both Qobuz &amp; Tidal altogether. Main philosophy of jimmy is Quality audio rather than GSD ASAP. jimmy has Apple music metadata built-in &amp; is compatible with Eclipse, delivering every track flawlessly. Jimmy is what Quality convenience every user should experience, enjoy ;)</p>
    <div class="tags">
      <span class="tag">Hi-Res</span>
      <span class="tag">Lossless</span>
      <span class="tag">Hi-Res 192kHz</span>
      <span class="tag">Dolby Atmos</span>
    </div>
  </section>

  <section class="cta">
    <div class="url-box">
      <input type="text" value="${addonUrl}" readonly id="manifestUrl" onclick="this.select()">
      <button onclick="copyManifestUrl('${addonUrl}')" class="copy-btn">Copy Manifest URL</button>
    </div>
    <p>Paste the URL above into Eclipse &rarr; Settings &rarr; Cloud Storage &rarr; Add Connection &rarr; Addons.</p>
  </section>
</main>

<footer>
  <div class="links">
    <a href="https://github.com/bacard1i">github.com/bacard1i</a>
    <span class="sep">&middot;</span>
    <span class="discord">Discord <b>.bacardii.</b></span>
    <span class="sep">&middot;</span>
    <span>MIT</span>
  </div>
  <p class="disclaimer">Not affiliated with 8SPINE, Eclipse, or their creators.</p>
</footer>
<div id="copy-toast" class="copy-toast">Copied!</div>
<script>
function copyManifestUrl(url){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(showToast,fallbackCopy);
  }else{
    fallbackCopy();
  }
  function fallbackCopy(){
    var ta=document.createElement('textarea');
    ta.value=url;
    ta.style.position='fixed';
    ta.style.left='-9999px';
    document.body.appendChild(ta);
    ta.select();
    try{document.execCommand('copy');}catch(e){}
    document.body.removeChild(ta);
    showToast();
  }
}
function showToast(){
  var t=document.getElementById('copy-toast');
  t.classList.add('show');
  setTimeout(function(){t.classList.remove('show');},1800);
}
</script>
</body>
</html>`;
}

app.get('/', (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const baseUrl = protocol + '://' + host;
  res.set('Content-Type', 'text/html');
  res.send(landingPage(baseUrl));
});

// --- Eclipse Endpoints ---

// 1. Manifest
app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'com.lateralus.jimmy',
    name: 'JIMMY',
    version: currentVersion,
    description: 'Just an Incredible Music Module, Yup! — Qobuz + Tidal high-res streaming for Eclipse',
    icon: 'https://jimmy-iota.vercel.app/icon.png',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist'],
    contentType: 'music'
  });
});

// 2. Search
app.get('/search', async (req, res) => {
  const query = req.query.q || '';
  const limit = parseInt(req.query.limit) || 20;

  if (!query) {
    return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  }

  try {
    const [qTracks, tTracks, qAlbums, tAlbums, qArtists, tArtists] = await Promise.all([
      qobuzSearch(query, limit),
      tidalSearch(query, limit),
      qobuzSearchAlbums(query, limit),
      tidalSearchAlbums(query, limit),
      qobuzSearchArtists(query, limit),
      tidalSearchArtists(query, limit)
    ]);

    res.json({
      tracks: mergeTracks([qTracks, tTracks]),
      albums: mergeAlbums([qAlbums, tAlbums]),
      artists: mergeArtists([qArtists, tArtists]),
      playlists: []
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// 3. Stream resolution
app.get('/stream/:id', async (req, res) => {
  const id = req.params.id;

  try {
    if (id.startsWith('tidal:')) {
      const rawId = id.split(':')[1];
      // Use the backend for Tidal stream resolution
      const url = BACKEND_CACHE_BASE + '/track/' + encodeURIComponent(rawId);
      const data = await withTimeout(
        fetch(url, { headers: { 'X-Cache-Token': BACKEND_CACHE_TOKEN } }),
        REQUEST_TIMEOUT_MS
      ).then(r => r.json());

      res.json({
        url: data.streamUrl || data.url,
        format: 'flac',
        quality: data.audioQuality || 'LOSSLESS',
        expiresAt: Math.floor(Date.now() / 1000) + 600
      });
    } else if (id.startsWith('qobuz:')) {
      const rawId = id.split(':')[1];
      const formatId = req.query.quality === 'MP3' ? 5 : 27;
      const ts = Math.floor(Date.now() / 1000);
      const sig = md5('trackgetFileUrl' + 'format_id' + formatId + 'intentstream' +
        'track_id' + rawId + ts + QOBUZ.secret);
      const url = QOBUZ.base + '/track/getFileUrl?app_id=' + QOBUZ.appId +
        '&user_auth_token=' + QOBUZ.userToken +
        '&track_id=' + rawId + '&format_id=' + formatId +
        '&intent=stream&request_ts=' + ts + '&request_sig=' + sig;
      const data = await fetchJSON(url);

      if (data.sample === true) {
        return res.status(403).json({ error: 'Preview only - subscription required' });
      }

      res.json({
        url: data.url,
        format: 'flac',
        quality: qualityLabel(data.bit_depth || 24, data.sampling_rate || data.sample_rate || 96, 'flac', []),
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });
    } else {
      res.status(400).json({ error: 'Unknown provider' });
    }
  } catch (err) {
    console.error('Stream error:', err);
    res.status(500).json({ error: 'Stream resolution failed' });
  }
});

// 4. Album details
app.get('/album/:id', async (req, res) => {
  const id = req.params.id;

  try {
    if (id.startsWith('tidal:')) {
      const rawId = id.split(':')[1];
      const url = TIDAL_SEARCH + '/album/?id=' + rawId;
      const data = await fetchJSON(url);
      if (!data) return res.status(404).json({ error: 'Album not found' });

      const album = tidalMapAlbum(data);
      const cover = album.artworkURL;
      const tracks = ((data.tracks && data.tracks.items) ||
        (data.media && data.media[0] && data.media[0].tracks) || [])
        .map(t => {
          const tt = tidalMapTrack(t);
          if (!tt) return null;
          return {
            id: tt.id,
            title: tt.title,
            artist: tt.artist,
            album: album.title,
            duration: tt.duration,
            artworkURL: cover,
            format: tt.format || 'flac'
          };
        }).filter(Boolean);

      album.tracks = tracks;
      res.json(album);
    } else {
      const rawId = id.replace(/^qobuz:/, '');
      const data = await qobuzApi('/album/get', { album_id: rawId });
      if (!data) return res.status(404).json({ error: 'Album not found' });

      const album = qobuzMapAlbum(data);
      const cover = album.artworkURL;
      const tracks = ((data.tracks && data.tracks.items) || [])
        .map(t => {
          const tt = qobuzMapTrack(t);
          if (!tt) return null;
          return {
            id: tt.id,
            title: tt.title,
            artist: tt.artist,
            album: album.title,
            duration: tt.duration,
            artworkURL: cover,
            format: 'flac'
          };
        }).filter(Boolean);

      album.tracks = tracks;
      res.json(album);
    }
  } catch (err) {
    console.error('Album error:', err);
    res.status(500).json({ error: 'Failed to get album' });
  }
});

// 5. Artist details
app.get('/artist/:id', async (req, res) => {
  const id = req.params.id;

  try {
    if (id.startsWith('tidal:')) {
      const rawId = id.split(':')[1];
      const url = TIDAL_SEARCH + '/artist/?id=' + rawId;
      const data = await fetchJSON(url);
      if (!data) return res.status(404).json({ error: 'Artist not found' });

      const artist = tidalMapArtist(data);
      const topTracks = ((data.tracks && data.tracks.items) || [])
        .map(t => {
          const tt = tidalMapTrack(t);
          if (!tt) return null;
          return {
            id: tt.id,
            title: tt.title,
            artist: tt.artist,
            album: tt.album,
            duration: tt.duration,
            artworkURL: tt.artworkURL,
            format: tt.format || 'flac'
          };
        }).filter(Boolean);
      const albums = ((data.albums && data.albums.items) || [])
        .map(tidalMapAlbum).filter(Boolean);

      artist.topTracks = topTracks;
      artist.albums = albums;
      res.json(artist);
    } else {
      const rawId = id.replace(/^qobuz:/, '');
      const data = await qobuzApi('/artist/get', {
        artist_id: rawId,
        extra: 'albums,playlists,tracks'
      });
      if (!data) return res.status(404).json({ error: 'Artist not found' });

      const artist = qobuzMapArtist(data);
      artist.bio = (data.biography && (data.biography.content || data.biography.summary)) || null;
      const topTracks = ((data.top_tracks && data.top_tracks.items) ||
        (data.tracks && data.tracks.items) || [])
        .map(t => {
          const tt = qobuzMapTrack(t);
          if (!tt) return null;
          return {
            id: tt.id,
            title: tt.title,
            artist: tt.artist,
            album: tt.album,
            duration: tt.duration,
            artworkURL: tt.artworkURL,
            format: 'flac'
          };
        }).filter(Boolean);
      const albums = ((data.albums && data.albums.items) || [])
        .map(qobuzMapAlbum).filter(Boolean);

      artist.topTracks = topTracks;
      artist.albums = albums;
      res.json(artist);
    }
  } catch (err) {
    console.error('Artist error:', err);
    res.status(500).json({ error: 'Failed to get artist' });
  }
});

// 8SPINE module catalog
app.get('/index.json', (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const baseUrl = protocol + '://' + host;
  res.json({
    'category:modules': [{
      id: 'jimmy',
      name: 'JIMMY',
      pkg: 'com.lateralus.module.jimmy',
      file: 'jimmy.js',
      download: baseUrl + '/jimmy.js',
      version: currentVersion,
      code: currentCodeVersion,
      type: 'MODULE',
      author: 'Lateralus',
      description: 'Hear the piracy.',
      tags: ['DOLBY-ATMOS', 'LOSSLESS', 'HI-RES', 'HI-RES(192kHz)'],
      size: 91361,
      sizeLabel: '89 KB',
      logo: 'https://jimmy-iota.vercel.app/icon.png',
      icon: 'https://jimmy-iota.vercel.app/icon.png',
      sources: [{ name: 'Lateralus', lang: 'all', id: 'lateralus', baseUrl: '.' }],
      lastUpdated: new Date().toISOString().slice(0, 10)
    }]
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', module: 'jimmy', version: currentVersion });
});

startAutoUpdate();

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`JIMMY Eclipse addon running on http://0.0.0.0:${PORT}`);
  });
}
