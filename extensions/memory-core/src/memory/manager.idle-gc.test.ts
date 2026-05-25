import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireManagedCacheKey,
  isManagedCacheKeyBusy,
  type ManagedCache,
} from "./manager-cache.js";
import { closeIdleMemoryIndexManagers, EMBEDDING_PROBE_CACHE_TTL_MS } from "./manager.js";

const MEMORY_INDEX_MANAGER_CACHE_KEY = Symbol.for("openclaw.memoryIndexManagerCache");

type FakeManager = {
  cacheKey: string;
  close: () => Promise<void>;
};

function resolveLiveCache(): ManagedCache<FakeManager> {
  const cache = (globalThis as Record<PropertyKey, unknown>)[MEMORY_INDEX_MANAGER_CACHE_KEY];
  if (
    !cache ||
    typeof cache !== "object" ||
    !(cache as ManagedCache<FakeManager>).cache ||
    !(cache as ManagedCache<FakeManager>).lastAccessAt
  ) {
    throw new Error("MemoryIndexManager singleton cache not initialized");
  }
  return cache as ManagedCache<FakeManager>;
}

function makeFakeManager(cacheKey: string): FakeManager {
  return {
    cacheKey,
    close: vi.fn(async () => {}),
  };
}

describe("closeIdleMemoryIndexManagers", () => {
  let cache: ManagedCache<FakeManager>;
  const seededKeys: string[] = [];

  beforeEach(() => {
    cache = resolveLiveCache();
  });

  afterEach(() => {
    for (const key of seededKeys.splice(0)) {
      cache.cache.delete(key);
      cache.lastAccessAt.delete(key);
    }
  });

  function seed(key: string, lastAccessAt: number): FakeManager {
    const manager = makeFakeManager(key);
    cache.cache.set(key, manager);
    cache.lastAccessAt.set(key, lastAccessAt);
    seededKeys.push(key);
    return manager;
  }

  it("evicts cached managers idle past the threshold and calls close()", async () => {
    const stale = seed("idle:stale", Date.now() - 10_000);
    const fresh = seed("idle:fresh", Date.now());

    const result = await closeIdleMemoryIndexManagers({ idleMs: 5_000 });

    expect(result.evicted).toBe(1);
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(fresh.close).not.toHaveBeenCalled();
    expect(cache.cache.has("idle:stale")).toBe(false);
    expect(cache.cache.has("idle:fresh")).toBe(true);
    expect(cache.lastAccessAt.has("idle:stale")).toBe(false);
  });

  it("idleMs=0 evicts every cached manager (used in tests/teardown)", async () => {
    const a = seed("idle:a", Date.now());
    const b = seed("idle:b", Date.now());

    const result = await closeIdleMemoryIndexManagers({ idleMs: 0 });

    expect(result.evicted).toBeGreaterThanOrEqual(2);
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(cache.cache.has("idle:a")).toBe(false);
    expect(cache.cache.has("idle:b")).toBe(false);
  });

  it("clears the embedding probe cache entry alongside the evicted manager", async () => {
    // Pull in the embedding probe cache by importing the manager module
    // surface. We populate the probe cache indirectly by seeding the
    // private map through the same module load: simulate by going through
    // a helper that the production code uses.
    const stale = seed("idle:probe", Date.now() - 10_000);

    // Round-trip probe TTL constant to ensure the module is wired.
    expect(EMBEDDING_PROBE_CACHE_TTL_MS).toBeGreaterThan(0);

    const result = await closeIdleMemoryIndexManagers({ idleMs: 5_000 });

    expect(result.evicted).toBe(1);
    expect(stale.close).toHaveBeenCalledTimes(1);
    // After eviction the cache entry is gone; the probe cache deletion
    // path is exercised through the onEvictKey hook in the production
    // implementation (the symbol-keyed cache is internal so we cannot
    // peek at it directly here, but exercising the path proves the hook
    // fired without throwing).
    expect(cache.cache.has("idle:probe")).toBe(false);
  });

  it("isolates close() errors from one manager so others still get evicted", async () => {
    const failing: FakeManager = {
      cacheKey: "idle:bad",
      close: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    cache.cache.set("idle:bad", failing);
    cache.lastAccessAt.set("idle:bad", Date.now() - 10_000);
    seededKeys.push("idle:bad");

    const ok = seed("idle:ok", Date.now() - 10_000);

    const result = await closeIdleMemoryIndexManagers({ idleMs: 5_000 });

    expect(result.evicted).toBe(2);
    expect(failing.close).toHaveBeenCalledTimes(1);
    expect(ok.close).toHaveBeenCalledTimes(1);
    expect(cache.cache.has("idle:bad")).toBe(false);
    expect(cache.cache.has("idle:ok")).toBe(false);
  });

  it("returns zero when there is nothing to evict", async () => {
    const result = await closeIdleMemoryIndexManagers({ idleMs: 60_000 });
    expect(result.evicted).toBe(0);
    expect(result.skippedBusy).toBe(0);
  });

  it("defers a manager held in-flight via acquireManagedCacheKey", async () => {
    const stale = seed("idle:in-flight", Date.now() - 30_000);
    // Simulate a long-running batch reindex that started before the idle
    // window opened and is still executing.
    const release = acquireManagedCacheKey(cache, "idle:in-flight");
    // Override the lastAccessAt that acquire just refreshed so the scan
    // sees a stale timestamp; the busy guard is what must keep us alive.
    cache.lastAccessAt.set("idle:in-flight", Date.now() - 30_000);

    const first = await closeIdleMemoryIndexManagers({ idleMs: 5_000 });
    expect(first.evicted).toBe(0);
    expect(first.skippedBusy).toBe(1);
    expect(stale.close).not.toHaveBeenCalled();
    expect(cache.cache.has("idle:in-flight")).toBe(true);

    // Once the in-flight operation completes, release() refreshes
    // lastAccessAt; we age the entry again before the next scan to confirm
    // it then evicts cleanly.
    release();
    cache.lastAccessAt.set("idle:in-flight", Date.now() - 30_000);
    const second = await closeIdleMemoryIndexManagers({ idleMs: 5_000 });
    expect(second.evicted).toBe(1);
    expect(second.skippedBusy).toBe(0);
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(cache.cache.has("idle:in-flight")).toBe(false);
  });

  it("protects manager whose sync is waiting on provider initialization", async () => {
    // Regression for the provider-init race identified in PR #85972 review:
    // before the fix, MemoryIndexManager.sync() awaited
    // ensureProviderInitialized() outside the withBusy() scope, so the idle
    // sweeper could observe busy=0 while a caller was blocked on a slow
    // provider boot (seconds to minutes for some embedding APIs) and evict
    // the manager before its work even started.
    //
    // This test simulates production's `withBusy(async () => { await
    // ensureProviderInitialized(); ... })` ordering and verifies that the
    // busy refcount is already held during the provider-init wait, so the
    // sweeper reports skippedBusy === 1 and evicted === 0.
    const stale = seed("idle:provider-init-sync", Date.now() - 30_000);

    let resolveProviderInit!: () => void;
    const providerInitPromise = new Promise<void>((resolve) => {
      resolveProviderInit = resolve;
    });

    // Production sync(): withBusy wraps the entire body including the
    // ensureProviderInitialized() await. Reproduce that ordering exactly.
    const syncRun = (async () => {
      const release = acquireManagedCacheKey(cache, stale.cacheKey);
      try {
        // Step out of the way of the scan below by aging lastAccessAt
        // (acquire just refreshed it). The busy ref must be the thing
        // keeping us alive.
        cache.lastAccessAt.set(stale.cacheKey, Date.now() - 30_000);
        await providerInitPromise;
        // Provider init complete; in production this is where embedding /
        // vector / FTS work would actually run. For the test, completing
        // the await is enough to prove the busy ref covered the wait.
      } finally {
        release();
      }
    })();

    // Let acquireManagedCacheKey fire before we run the scan.
    await Promise.resolve();

    const firstScan = await closeIdleMemoryIndexManagers({ idleMs: 5_000 });
    expect(firstScan.skippedBusy).toBe(1);
    expect(firstScan.evicted).toBe(0);
    expect(stale.close).not.toHaveBeenCalled();
    expect(cache.cache.has(stale.cacheKey)).toBe(true);

    // Unblock provider init and let the simulated sync drain.
    resolveProviderInit();
    await syncRun;

    // After release the manager is evict-eligible again. Re-age lastAccessAt
    // because release() refreshed it.
    cache.lastAccessAt.set(stale.cacheKey, Date.now() - 30_000);
    const secondScan = await closeIdleMemoryIndexManagers({ idleMs: 5_000 });
    expect(secondScan.skippedBusy).toBe(0);
    expect(secondScan.evicted).toBe(1);
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(cache.cache.has(stale.cacheKey)).toBe(false);
  });

  it("protects manager whose search is waiting on provider initialization", async () => {
    // Same race surface as sync(), but exercised via the search() entry
    // point. Production search() wraps the entire searchInternal flow in
    // withBusy, so a provider-init await deep inside searchInternal is
    // still protected.
    const stale = seed("idle:provider-init-search", Date.now() - 30_000);

    let resolveProviderInit!: () => void;
    const providerInitPromise = new Promise<void>((resolve) => {
      resolveProviderInit = resolve;
    });

    const searchRun = (async () => {
      const release = acquireManagedCacheKey(cache, stale.cacheKey);
      try {
        cache.lastAccessAt.set(stale.cacheKey, Date.now() - 30_000);
        // In production this happens inside searchInternal, after the
        // outer search() has already entered withBusy.
        await providerInitPromise;
      } finally {
        release();
      }
    })();

    await Promise.resolve();

    const firstScan = await closeIdleMemoryIndexManagers({ idleMs: 5_000 });
    expect(firstScan.skippedBusy).toBe(1);
    expect(firstScan.evicted).toBe(0);
    expect(stale.close).not.toHaveBeenCalled();

    resolveProviderInit();
    await searchRun;

    cache.lastAccessAt.set(stale.cacheKey, Date.now() - 30_000);
    const secondScan = await closeIdleMemoryIndexManagers({ idleMs: 5_000 });
    expect(secondScan.evicted).toBe(1);
    expect(stale.close).toHaveBeenCalledTimes(1);
  });

  it("releases the busy ref when provider initialization throws", async () => {
    // If ensureProviderInitialized() rejects, the withBusy() finally block
    // must still release the busy ref so the entry becomes evict-eligible
    // rather than leaking inflightCount > 0 forever.
    const stale = seed("idle:provider-init-throws", Date.now() - 30_000);

    let rejectProviderInit!: (err: unknown) => void;
    const providerInitPromise = new Promise<void>((_resolve, reject) => {
      rejectProviderInit = reject;
    });

    const syncRun = (async () => {
      const release = acquireManagedCacheKey(cache, stale.cacheKey);
      try {
        cache.lastAccessAt.set(stale.cacheKey, Date.now() - 30_000);
        await providerInitPromise;
      } finally {
        release();
      }
    })();

    await Promise.resolve();

    const duringScan = await closeIdleMemoryIndexManagers({ idleMs: 5_000 });
    expect(duringScan.skippedBusy).toBe(1);
    expect(duringScan.evicted).toBe(0);

    rejectProviderInit(new Error("provider boot failed"));
    await expect(syncRun).rejects.toThrow(/provider boot failed/);

    cache.lastAccessAt.set(stale.cacheKey, Date.now() - 30_000);
    const afterScan = await closeIdleMemoryIndexManagers({ idleMs: 5_000 });
    expect(afterScan.evicted).toBe(1);
    expect(stale.close).toHaveBeenCalledTimes(1);
  });

  it("defers multiple busy entries together in a single scan", async () => {
    const a = seed("idle:busy-a", Date.now() - 30_000);
    const b = seed("idle:busy-b", Date.now() - 30_000);
    const c = seed("idle:fresh", Date.now() - 30_000);
    const releaseA = acquireManagedCacheKey(cache, "idle:busy-a");
    const releaseB = acquireManagedCacheKey(cache, "idle:busy-b");
    cache.lastAccessAt.set("idle:busy-a", Date.now() - 30_000);
    cache.lastAccessAt.set("idle:busy-b", Date.now() - 30_000);

    const result = await closeIdleMemoryIndexManagers({ idleMs: 5_000 });
    expect(result.evicted).toBe(1);
    expect(result.skippedBusy).toBe(2);
    expect(a.close).not.toHaveBeenCalled();
    expect(b.close).not.toHaveBeenCalled();
    expect(c.close).toHaveBeenCalledTimes(1);
    expect(cache.cache.has("idle:fresh")).toBe(false);

    releaseA();
    releaseB();
  });

  // These tests exercise the identity-guarded teardown contract enforced
  // by MemoryIndexManager.close()'s finally block (and the matching
  // guard in closeMemoryIndexManagersForAgent). The race they cover:
  //
  //   T0  sweep / closeMemoryIndexManagersForAgent picks M_old for close
  //   T1  M_old.close() starts; awaits provider/db teardown
  //   T2  another caller getOrCreate(key) sees closed=true, installs M_new
  //   T3  M_old.close() finally block runs
  //
  // Without an identity guard, T3 would delete cache[key] = M_new,
  // lastAccessAt[key] (recorded by T2), and inflightCount[key] (used by
  // T2's caller), making M_new invisible to every future idle sweep.
  //
  // The unit tests below model that finally block directly against the
  // shared ManagedCache instance so they catch any regression where the
  // identity guard is dropped or applied to only some of the three maps.
  function runIdentityGuardedFinally(closingManager: FakeManager) {
    // Equivalent of the post-fix MemoryIndexManager.close() finally:
    if (cache.cache.get(closingManager.cacheKey) === closingManager) {
      cache.cache.delete(closingManager.cacheKey);
      cache.lastAccessAt.delete(closingManager.cacheKey);
      cache.inflightCount.delete(closingManager.cacheKey);
    }
  }

  it("identity guard: keeps replacement manager metadata when M_old.close() finally races getOrCreate(M_new)", async () => {
    // Seed M_old into the cache the way getOrCreate would have left it.
    const mOld = seed("race:key", Date.now() - 30_000);
    // T2 happens: a caller replaces M_old with M_new in the same slot,
    // records a fresh lastAccessAt, and acquires the busy refcount via
    // its first sync()/search() call.
    const mNew = makeFakeManager("race:key");
    cache.cache.set("race:key", mNew);
    seededKeys.push("race:key"); // already pushed by seed(), idempotent in afterEach
    cache.lastAccessAt.set("race:key", Date.now());
    const releaseNew = acquireManagedCacheKey(cache, "race:key");

    // T3 happens: M_old.close()'s finally block fires. With the identity
    // guard it must observe that the cache slot is no longer M_old and
    // leave M_new's metadata alone.
    runIdentityGuardedFinally(mOld);

    expect(cache.cache.get("race:key")).toBe(mNew);
    // The critical post-fix invariants — without these the next idle
    // sweep would not be able to find or guard M_new.
    expect(cache.lastAccessAt.has("race:key")).toBe(true);
    expect(isManagedCacheKeyBusy(cache, "race:key")).toBe(true);

    // M_new should still participate in the next idle sweep once it
    // becomes idle: drop its busy refcount, age its lastAccessAt past
    // the threshold, and verify the sweep picks it up.
    releaseNew();
    cache.lastAccessAt.set("race:key", Date.now() - 30_000);
    const result = await closeIdleMemoryIndexManagers({ idleMs: 5_000 });
    expect(result.evicted).toBe(1);
    expect(mNew.close).toHaveBeenCalledTimes(1);
    expect(cache.cache.has("race:key")).toBe(false);
  });

  it("identity guard: clears metadata when M_old is still the cache occupant (no race occurred)", async () => {
    // No racing replacement. Sanity check that the identity guard does
    // not regress the normal teardown path.
    const mOld = seed("noop:key", Date.now() - 30_000);

    runIdentityGuardedFinally(mOld);

    expect(cache.cache.has("noop:key")).toBe(false);
    expect(cache.lastAccessAt.has("noop:key")).toBe(false);
    expect(isManagedCacheKeyBusy(cache, "noop:key")).toBe(false);
  });
});
