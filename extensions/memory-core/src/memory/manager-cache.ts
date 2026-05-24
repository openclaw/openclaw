import { resolveGlobalSingleton } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";

type Closable = {
  close?: () => Promise<void> | void;
};

export type ManagedCache<T> = {
  cache: Map<string, T>;
  pending: Map<string, Promise<T>>;
  // Tracks last access time per cache key for idle-TTL eviction in
  // long-running daemons. Refreshed on cache hit and on initial set.
  lastAccessAt: Map<string, number>;
};

function isManagedCacheShape<T>(value: unknown): value is ManagedCache<T> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ManagedCache<T>>;
  return (
    candidate.cache instanceof Map &&
    candidate.pending instanceof Map &&
    candidate.lastAccessAt instanceof Map
  );
}

export function resolveSingletonManagedCache<T>(cacheKey: symbol): ManagedCache<T> {
  const resolved = resolveGlobalSingleton<unknown>(cacheKey, () => ({
    cache: new Map<string, T>(),
    pending: new Map<string, Promise<T>>(),
    lastAccessAt: new Map<string, number>(),
  }));
  if (isManagedCacheShape<T>(resolved)) {
    return resolved;
  }
  // Older daemons may have placed an incompatible shape (e.g. missing
  // lastAccessAt) at this key. Re-seed a fresh cache so callers get a
  // consistent structure.
  const repaired: ManagedCache<T> = {
    cache: new Map<string, T>(),
    pending: new Map<string, Promise<T>>(),
    lastAccessAt: new Map<string, number>(),
  };
  (globalThis as Record<PropertyKey, unknown>)[cacheKey] = repaired;
  return repaired;
}

function recordLastAccess(lastAccessAt: Map<string, number> | undefined, key: string): void {
  lastAccessAt?.set(key, Date.now());
}

export async function getOrCreateManagedCacheEntry<T>(params: {
  cache: Map<string, T>;
  pending: Map<string, Promise<T>>;
  key: string;
  bypassCache?: boolean;
  create: () => Promise<T> | T;
  // Optional last-access tracker. Callers that pass a ManagedCache should
  // forward its lastAccessAt map so idle-TTL eviction sees a fresh
  // timestamp on every cache hit.
  lastAccessAt?: Map<string, number>;
}): Promise<T> {
  if (params.bypassCache) {
    return await params.create();
  }
  const existing = params.cache.get(params.key);
  if (existing) {
    recordLastAccess(params.lastAccessAt, params.key);
    return existing;
  }
  const pending = params.pending.get(params.key);
  if (pending) {
    return pending;
  }
  const createPromise = (async () => {
    const refreshed = params.cache.get(params.key);
    if (refreshed) {
      recordLastAccess(params.lastAccessAt, params.key);
      return refreshed;
    }
    const entry = await params.create();
    params.cache.set(params.key, entry);
    recordLastAccess(params.lastAccessAt, params.key);
    return entry;
  })();
  params.pending.set(params.key, createPromise);
  try {
    return await createPromise;
  } finally {
    if (params.pending.get(params.key) === createPromise) {
      params.pending.delete(params.key);
    }
  }
}

export async function closeManagedCacheEntries<T extends Closable>(params: {
  cache: Map<string, T>;
  pending: Map<string, Promise<T>>;
  lastAccessAt?: Map<string, number>;
  onCloseError?: (err: unknown) => void;
}): Promise<void> {
  const pending = Array.from(params.pending.values());
  if (pending.length > 0) {
    await Promise.allSettled(pending);
  }
  const entries = Array.from(params.cache.values());
  params.cache.clear();
  params.lastAccessAt?.clear();
  for (const entry of entries) {
    if (typeof entry.close !== "function") {
      continue;
    }
    try {
      await entry.close();
    } catch (err) {
      params.onCloseError?.(err);
    }
  }
}

// Idle-TTL eviction for long-running daemons. Walks the lastAccessAt map and
// closes any entry whose last access happened more than `idleMs` ago. Each
// entry's close() is awaited sequentially so errors are isolated; a thrown
// error from one entry does not prevent later entries from being evicted.
//
// Entries can themselves remove their own cacheKey from cache.delete() during
// close() (e.g. MemoryIndexManager does this); this is intentional and
// idempotent because we capture the eviction list up-front and re-check the
// cache before deleting.
export async function closeIdleManagedCacheEntries<T extends Closable>(params: {
  cache: ManagedCache<T>;
  idleMs: number;
  now?: () => number;
  onCloseError?: (err: unknown) => void;
  onEvictKey?: (key: string) => void;
}): Promise<{ evicted: number; remaining: number }> {
  const now = (params.now ?? Date.now)();
  const cutoff = now - params.idleMs;
  const stale: Array<{ key: string; entry: T }> = [];
  for (const [key, lastAccess] of params.cache.lastAccessAt) {
    if (lastAccess > cutoff) {
      continue;
    }
    const entry = params.cache.cache.get(key);
    if (!entry) {
      // lastAccessAt drifted out of sync with cache; clean it up.
      params.cache.lastAccessAt.delete(key);
      continue;
    }
    stale.push({ key, entry });
  }
  let evicted = 0;
  for (const { key, entry } of stale) {
    // Drop the cache slot first so concurrent readers do not pick up a
    // closing entry. close() may itself attempt the same delete; that is
    // safe because Map.delete on a missing key is a no-op.
    if (params.cache.cache.get(key) === entry) {
      params.cache.cache.delete(key);
    }
    params.cache.lastAccessAt.delete(key);
    params.onEvictKey?.(key);
    if (typeof entry.close === "function") {
      try {
        await entry.close();
      } catch (err) {
        params.onCloseError?.(err);
      }
    }
    evicted += 1;
  }
  return { evicted, remaining: params.cache.cache.size };
}
