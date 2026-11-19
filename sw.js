/* GeoPortal · service worker: permite abrir la app y ver los mapas descargados sin internet.
   No toca Supabase, clima ni servicios satelitales (siempre van directo a la red). */
const VER = 'v5';
const APP = 'geoportal-app-' + VER;       // código de la aplicación y librerías
const TILES = 'geoportal-tiles-v1';       // mapas base y DEM (también los llena la propia página)
const LIBS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/togeojson/0.16.0/togeojson.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.0/proj4.js',
  'https://cdnjs.cloudflare.com/ajax/libs/proj4leaflet/1.0.2/proj4leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Turf.js/6.5.0/turf.min.js',
  'https://cdn.jsdelivr.net/npm/shpjs@4.0.4/dist/shp.min.js',
  'https://unpkg.com/geotiff@2.1.3/dist-browser/geotiff.js'
];
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-v2-192.png', 'icon-v2-512.png'];
const HOST_LIBS = /^(unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)$/;
const HOST_TILES = /^(server\.arcgisonline\.com|services\.arcgisonline\.com|s3\.amazonaws\.com)$/;
// PNG transparente 1x1 para teselas que no están guardadas (evita el ícono de imagen rota)
const VACIO = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

self.addEventListener('install', ev => {
  ev.waitUntil((async () => {
    const c = await caches.open(APP);
    await Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await Promise.all(LIBS.map(u => fetch(u, { mode: 'cors' }).then(r => r.ok ? c.put(u, r) : null).catch(() => {})));
    self.skipWaiting();
  })());
});
self.addEventListener('activate', ev => {
  ev.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k.indexOf('geoportal-app-') === 0 && k !== APP).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', ev => { if (ev.data === 'SKIP_WAITING') self.skipWaiting(); });

// Página principal: red primero (3 s) y, si no hay señal, la copia guardada
async function pagina(req) {
  const c = await caches.open(APP);
  try {
    const r = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('lento')), 3000))]);
    if (r && r.ok) { c.put(req.url.indexOf('index.html') >= 0 ? req : new Request(self.registration.scope), r.clone()); c.put('index.html', r.clone()); }
    return r;
  } catch (e) {
    return (await c.match(req, { ignoreSearch: true })) || (await c.match('index.html')) || (await c.match('./')) || Response.error();
  }
}
// Catálogo de capas (capas.json): red primero y, si no hay señal, la última copia guardada
async function catalogo(req) {
  const c = await caches.open(APP);
  try {
    const r = await fetch(req.url, { cache: 'no-store' });
    if (r && r.ok) c.put('capas.json', r.clone());
    return r;
  } catch (e) {
    return (await c.match('capas.json')) || Response.error();
  }
}
// Librerías (versión fija): copia guardada primero; si falta, red y se guarda
async function libreria(req) {
  const c = await caches.open(APP), hit = await c.match(req.url);
  if (hit) return hit;
  try { const r = await fetch(req.url, { mode: 'cors' }); if (r.ok) c.put(req.url, r.clone()); return r; } catch (e) { return Response.error(); }
}
// Teselas de mapa / DEM: copia guardada primero; si falta, red (y se guarda en segundo plano, sin hacer esperar a la imagen)
let _cT = null;
const abrirTiles = () => _cT || (_cT = caches.open(TILES));
async function tesela(req, esDEM, ev) {
  const c = await abrirTiles(), hit = await c.match(req.url);
  if (hit) return hit;
  for (let i = 0; i < 3; i++) {   // reintenta (hasta 3 veces): un fallo pasajero ya no deja la tesela en blanco/plomo
    try {
      const r = await fetch(req.url, { mode: 'cors' });
      if (r.ok) { const p = c.put(req.url, r.clone()).then(() => recortar(c)).catch(() => {}); try { ev.waitUntil(p); } catch (e) {} return r; }
      if (r.status >= 400 && r.status < 500) return r;
    } catch (e) {}
    await new Promise(res => setTimeout(res, 250 * (i + 1)));
  }
  // sin red tras reintentar: en línea se deja el error para que el mapa lo reintente; sin conexión, tesela vacía
  return (self.navigator && self.navigator.onLine === false && !esDEM) ? new Response(VACIO, { status: 200, headers: { 'Content-Type': 'image/png' } }) : Response.error();
}
let nPut = 0;
async function recortar(c) {   // límite de teselas guardadas automáticamente: si pasa de 25 000, borra las más antiguas
  if (++nPut % 300) return;
  const ks = await c.keys(); if (ks.length > 25000) await Promise.all(ks.slice(0, ks.length - 22000).map(k => c.delete(k)));
}
self.addEventListener('fetch', ev => {
  const req = ev.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === self.location.origin) {
    if (req.mode === 'navigate') { ev.respondWith(pagina(req)); return; }
    if (/\/capas\.json$/.test(u.pathname)) { ev.respondWith(catalogo(req)); return; }
    ev.respondWith(caches.open(APP).then(c => c.match(req, { ignoreSearch: true })).then(h => h || fetch(req)).catch(() => Response.error()));
    return;
  }
  if (HOST_LIBS.test(u.hostname)) { ev.respondWith(libreria(req)); return; }
  if (HOST_TILES.test(u.hostname) && /\/(tile|terrarium)\//.test(u.pathname)) { ev.respondWith(tesela(req, u.hostname === 's3.amazonaws.com', ev)); return; }
});
