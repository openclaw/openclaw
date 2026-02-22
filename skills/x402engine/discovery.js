// Fetch and cache the service catalog from /.well-known/x402.json.
// The catalog is the source of truth for intent routing — new services
// added to the gateway are automatically discoverable without code changes.

export const DEFAULT_DISCOVERY_URL = 'https://x402engine.app/.well-known/x402.json';
export const DEFAULT_DISCOVERY_TTL_MS = 60_000;

let _cache = null;

function ttlMs() {
  const raw = Number(process.env.X402_DISCOVERY_REFRESH_MS ?? DEFAULT_DISCOVERY_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DISCOVERY_TTL_MS;
}

/**
 * Fetch the service catalog.
 *
 * @param {object} opts
 * @param {boolean}  opts.force       - bypass cache
 * @param {number}   opts.nowMs       - current timestamp (for testing)
 * @param {Function} opts.fetchImpl   - fetch implementation (for testing)
 * @param {string}   opts.discoveryUrl - override discovery URL
 * @returns {{ baseUrl: string, services: object[], source: string }}
 */
export async function fetchCatalog({
  force = false,
  nowMs = Date.now(),
  fetchImpl = globalThis.fetch,
  discoveryUrl = process.env.X402_DISCOVERY_URL || DEFAULT_DISCOVERY_URL,
} = {}) {
  // If origin is explicitly set, return a minimal stub.
  if (process.env.X402ENGINE_ORIGIN) {
    return {
      baseUrl: String(process.env.X402ENGINE_ORIGIN).trim(),
      services: _cache?.catalog?.services || [],
      source: 'env',
    };
  }

  const ttl = ttlMs();
  if (!force && _cache && (nowMs - _cache.atMs) <= ttl) {
    return _cache.catalog;
  }

  let res;
  try {
    res = await fetchImpl(discoveryUrl, { method: 'GET' });
  } catch (err) {
    // Network failure — return stale cache if available.
    if (_cache) return _cache.catalog;
    throw new Error(`Discovery fetch failed: ${err.message}`);
  }

  if (!res.ok) {
    if (_cache) return _cache.catalog;
    throw new Error(`Discovery returned HTTP ${res.status}`);
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    if (_cache) return _cache.catalog;
    throw new Error('Discovery doc is not valid JSON');
  }

  const baseUrl = String(json?.baseUrl || '').trim();
  if (!baseUrl) {
    if (_cache) return _cache.catalog;
    throw new Error('Discovery doc missing baseUrl');
  }

  // Normalize: accept both { services: [...] } and { endpoints: {...} } shapes.
  let services = [];
  if (Array.isArray(json.services)) {
    services = json.services;
  } else if (json.endpoints && typeof json.endpoints === 'object') {
    // Flatten endpoint map to array for uniform processing.
    services = Object.entries(json.endpoints).map(([id, ep]) => ({
      id,
      ...(typeof ep === 'string' ? { path: ep } : ep),
    }));
  }

  const catalog = { baseUrl, services, source: 'remote' };
  _cache = { atMs: nowMs, catalog };
  return catalog;
}

/** Force-clear the in-memory cache (useful in tests). */
export function resetCache() {
  _cache = null;
}

/** Return cached catalog if available, without network. */
export function getCachedCatalog() {
  return _cache?.catalog || null;
}

/**
 * List services from the catalog in a human-readable summary.
 * @returns {{ services: { id, name, description, price, path, method }[] }}
 */
export async function listServices(opts) {
  const catalog = await fetchCatalog(opts);
  return catalog.services.map((s) => ({
    id: s.id,
    name: s.name || s.id,
    description: s.description || '',
    price: s.price || 'unknown',
    path: s.path || '',
    method: s.method || 'GET',
  }));
}
