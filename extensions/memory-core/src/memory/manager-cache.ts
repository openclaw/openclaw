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
  // Tracks the number of in-flight operations currently using each cache
  // entry. Idle eviction must NOT close an entry whose count is > 0 even
  // if its lastAccessAt has aged past the idle threshold (e.g. a long
  // batch reindex that started before idleMs elapsed and is still
  // running). See acquireManagedCacheKey / isManagedCacheKeyBusy.
  inflightCount: Map<string, number>;
};

function isManagedCacheShape<T>(value: unknown): value is ManagedCache<T> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ManagedCache<T>>;
  return (
    candidate.cache instanceof Map &&
    candidate.pending instanceof Map &&
    candidate.lastAccessAt instanceof Map &&
    candidate.inflightCount instanceof Map
  );
}

export function resolveSingletonManagedCache<T>(cacheKey: symbol): ManagedCache<T> {
  const resolved = resolveGlobalSingleton<unknown>(cacheKey, () => ({
    cache: new Map<string, T>(),
    pending: new Map<string, Promise<T>>(),
    lastAccessAt: new Map<string, number>(),
    inflightCount: new Map<string, number>(),
  }));
  if (isManagedCacheShape<T>(resolved)) {
    return resolved;
  }
  // Older daemons may have placed an incompatible shape (e.g. missing
  // lastAccessAt or inflightCount) at this key. Re-seed a fresh cache so
  // callers get a consistent structure.
  const repaired: ManagedCache<T> = {
    cache: new Map<string, T>(),
    pending: new Map<string, Promise<T>>(),
    lastAccessAt: new Map<string, number>(),
    inflightCount: new Map<string, number>(),
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
  inflightCount?: Map<string, number>;
  onCloseError?: (err: unknown) => void;
}): Promise<void> {
  const pending = Array.from(params.pending.values());
  if (pending.length > 0) {
    await Promise.allSettled(pending);
  }
  const entries = Array.from(params.cache.values());
  params.cache.clear();
  params.lastAccessAt?.clear();
  // Full teardown is unconditional: by the time callers reach
  // closeManagedCacheEntries (process shutdown / agent close), they have
  // already decided to terminate work and any lingering refcounts are
  // stale. Drop them so subsequent test runs start clean.
  params.inflightCount?.clear();
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

// Mark a cache key as in-flight. Returns a release function the caller
// must invoke (typically in a try/finally) when the operation completes.
// While inflightCount[key] > 0, closeIdleManagedCacheEntries will skip
// the entry even if its lastAccessAt has aged past the idle threshold.
//
// The release function is idempotent. Both acquire() and release() also
// touch lastAccessAt so that a manager which was busy for the whole idle
// window gets a fresh idle countdown once it goes idle (avoiding an
// immediate eviction on the very next scan).
export function acquireManagedCacheKey<T>(cache: ManagedCache<T>, key: string): () => void {
  const current = cache.inflightCount.get(key) ?? 0;
  cache.inflightCount.set(key, current + 1);
  cache.lastAccessAt.set(key, Date.now());
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const c = cache.inflightCount.get(key) ?? 0;
    if (c <= 1) {
      cache.inflightCount.delete(key);
    } else {
      cache.inflightCount.set(key, c - 1);
    }
    cache.lastAccessAt.set(key, Date.now());
  };
}

export function isManagedCacheKeyBusy<T>(cache: ManagedCache<T>, key: string): boolean {
  return (cache.inflightCount.get(key) ?? 0) > 0;
}

// Idle-TTL eviction for long-running daemons. Walks the lastAccessAt map and
// closes any entry whose last access happened more than `idleMs` ago. Each
// entry's close() is awaited sequentially so errors are isolated; a thrown
// error from one entry does not prevent later entries from being evicted.
//
// Active-use protection: entries with inflightCount[key] > 0 are skipped
// regardless of how stale lastAccessAt looks. This is the safety net for
// long-running operations (batch reindex, async search-time sync, ...)
// whose runtime can exceed idleMs while only refreshing lastAccessAt at
// the start and end. They are surfaced through the optional onSkipBusy
// callback for observability, and reported back to callers via the
// `skippedBusy` count so periodic sidecars can log them.
//
// Scan-to-close race protection: between the survey loop and the close
// loop, a concurrent caller can refresh lastAccessAt (cache hit) or
// acquire the busy refcount on a key we already added to the eviction
// list. Before closing each entry we re-validate `lastAccessAt`
// freshness against the same cutoff, `isBusy`, and cache identity. An
// entry that no longer satisfies the original idle predicate is
// reported back via the new `skippedRevalidated` counter and left in
// the cache for the next scan to reconsider.
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
  onSkipBusy?: (key: string) => void;
  onSkipRevalidated?: (key: string) => void;
  // Test hook: invoked after the survey loop but before the close loop.
  // Allows regression tests to deterministically inject a cache hit or
  // busy acquire into the scan-to-close gap.
  testHookBeforeCloseLoop?: () => Promise<void> | void;
}): Promise<{
  evicted: number;
  skippedBusy: number;
  skippedRevalidated: number;
  remaining: number;
}> {
  const now = (params.now ?? Date.now)();
  const cutoff = now - params.idleMs;
  const stale: Array<{ key: string; entry: T }> = [];
  let skippedBusy = 0;
  let skippedRevalidated = 0;
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
    if (isManagedCacheKeyBusy(params.cache, key)) {
      // Active-use protection: a long-running operation currently holds
      // a reference to this entry. Defer eviction until the next scan
      // after release() fires (which will also refresh lastAccessAt).
      skippedBusy += 1;
      params.onSkipBusy?.(key);
      continue;
    }
    stale.push({ key, entry });
  }
  // Test hook: lets regression tests simulate the scan-to-close gap by
  // injecting a cache hit or busy acquire between survey and close.
  if (params.testHookBeforeCloseLoop) {
    await params.testHookBeforeCloseLoop();
  }
  let evicted = 0;
  for (const { key, entry } of stale) {
    // Re-validate state immediately before close to close the race
    // identified in PR #85972 review: between the survey loop and this
    // point a concurrent caller may have either refreshed lastAccessAt
    // (cache hit), acquired the busy refcount, or replaced the cache
    // entry with a new instance. Closing in any of those cases would
    // hand out a stale closed reference.
    const currentTs = params.cache.lastAccessAt.get(key);
    if (currentTs === undefined) {
      // Another path already evicted this key (e.g. close() racing with
      // a competing teardown). Nothing to do.
      skippedRevalidated += 1;
      params.onSkipRevalidated?.(key);
      continue;
    }
    if (currentTs > cutoff) {
      // Refreshed during the scan-to-close gap. Leave the entry in the
      // cache and let the next scan reconsider it against a fresher
      // cutoff. This is the merge-blocker case from the review.
      skippedRevalidated += 1;
      params.onSkipRevalidated?.(key);
      continue;
    }
    if (isManagedCacheKeyBusy(params.cache, key)) {
      // Busy was acquired during the gap; treat the same as the survey
      // loop skip so sidecar metrics stay consistent.
      skippedBusy += 1;
      params.onSkipBusy?.(key);
      continue;
    }
    const currentEntry = params.cache.cache.get(key);
    if (!currentEntry) {
      // Cache slot disappeared during the gap. Cleanup any orphan
      // lastAccessAt entry and move on.
      params.cache.lastAccessAt.delete(key);
      skippedRevalidated += 1;
      params.onSkipRevalidated?.(key);
      continue;
    }
    if (currentEntry !== entry) {
      // Cache identity changed (cache.set(key, newEntry) happened in the
      // gap). The new entry has its own fresh lastAccessAt and may be
      // in-flight; leave it for the next scan instead of closing it.
      skippedRevalidated += 1;
      params.onSkipRevalidated?.(key);
      continue;
    }
    // Drop the cache slot first so concurrent readers do not pick up a
    // closing entry. close() may itself attempt the same delete; that is
    // safe because Map.delete on a missing key is a no-op.
    if (params.cache.cache.get(key) === entry) {
      params.cache.cache.delete(key);
    }
    params.cache.lastAccessAt.delete(key);
    params.cache.inflightCount.delete(key);
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
  return {
    evicted,
    skippedBusy,
    skippedRevalidated,
    remaining: params.cache.cache.size,
  };
}
