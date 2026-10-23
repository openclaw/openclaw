import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";

export function getOrCreateWeakOwnerMap<K extends object, V>(
  owners: WeakMap<K, Map<string, V>>,
  owner: K,
): Map<string, V> {
  let values = owners.get(owner);
  if (!values) {
    values = new Map();
    owners.set(owner, values);
  }
  return values;
}

/** LRU-touch read: move hit to newest so pruneMapToMaxSize keeps active keys. */
export function readLruMapEntry<T>(cache: Map<string, T>, cacheKey: string): T | undefined {
  const cached = cache.get(cacheKey);
  if (cached) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
  }
  return cached;
}

export function writeLruMapEntry<T>(
  cache: Map<string, T>,
  cacheKey: string,
  entry: T,
  maxEntries: number,
): void {
  cache.delete(cacheKey);
  cache.set(cacheKey, entry);
  pruneMapToMaxSize(cache, maxEntries);
}

export function pruneExpiredMapEntries<T extends { expiresAt: number }>(
  cache: Map<string, T>,
  now: number,
): void {
  // Cache clocks are process-owned Date.now() values, not external timestamps.
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}
