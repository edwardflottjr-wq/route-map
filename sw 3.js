/* Route Map — offline support.
   Keeps the app and the Leaflet map library cached so the app opens with no reception,
   and keeps a copy of every map tile you have viewed so those areas still show offline.
   Tiles are only cached as you view them (no bulk downloading — OpenStreetMap's and
   Esri's tile terms don't allow bulk pre-downloading). */
const APP_CACHE = 'routemap-app-v4';
const TILE_CACHE = 'routemap-tiles-v1';
const MAX_TILES = 6000;   // roughly 100–150 MB at most; oldest tiles are dropped first

const APP_FILES = [
  './',
  './route-map.html',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/layers.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/layers-2x.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    // add one at a time so a single missing file doesn't stop the rest
    await Promise.all(APP_FILES.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = [APP_CACHE, TILE_CACHE];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isTile = url =>
  /tile\.openstreetmap\.org$/.test(url.hostname) ||
  (url.hostname === 'server.arcgisonline.com' && url.pathname.includes('/tile/'));

let trimTimer = null;
function scheduleTrim(){
  if (trimTimer) return;
  trimTimer = setTimeout(async () => {
    trimTimer = null;
    const cache = await caches.open(TILE_CACHE);
    const keys = await cache.keys();          // insertion order = oldest first
    const extra = keys.length - MAX_TILES;
    for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
  }, 5000);
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles: use the saved copy if there is one, otherwise fetch and save it.
  if (isTile(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) { cache.put(req, res.clone()); scheduleTrim(); }
        return res;
      } catch (e) {
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })());
    return;
  }

  // The app page itself: try the network first (so updates arrive), fall back to the saved copy.
  if (req.mode === 'navigate' || (url.origin === self.location.origin && /\.html?$|\/$/.test(url.pathname))) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return (await cache.match(req, { ignoreSearch: true })) ||
               (await cache.match('./route-map.html')) ||
               (await cache.match('./')) ||
               new Response('Offline and the app has not been saved yet. Open it once with reception.', { status: 503 });
      }
    })());
    return;
  }

  // Leaflet library files and anything else: saved copy first, network as backup.
  if (url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })());
  }
  // Everything else (address lookups) goes straight to the network and simply fails offline.
});
