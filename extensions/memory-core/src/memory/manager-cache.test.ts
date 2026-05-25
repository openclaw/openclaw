import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireManagedCacheKey,
  closeIdleManagedCacheEntries,
  closeManagedCacheEntries,
  getOrCreateManagedCacheEntry,
  isManagedCacheKeyBusy,
  resolveSingletonManagedCache,
  type ManagedCache,
} from "./manager-cache.js";

type TestEntry = {
  id: string;
  close: () => Promise<void>;
};

function createTestCache(): ManagedCache<TestEntry> {
  return resolveSingletonManagedCache<TestEntry>(Symbol("openclaw.manager-cache.test"));
}

function createEntry(id: string): TestEntry {
  return {
    id,
    close: vi.fn(async () => {}),
  };
}

function createDeferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

describe("manager cache", () => {
  const cachesForCleanup: ManagedCache<TestEntry>[] = [];

  afterEach(async () => {
    await Promise.all(
      cachesForCleanup.splice(0).map((cache) =>
        closeManagedCacheEntries({
          cache: cache.cache,
          pending: cache.pending,
        }),
      ),
    );
  });

  it("repairs an invalid singleton cache shape", async () => {
    const cacheKey = Symbol("openclaw.manager-cache.corrupt-test");
    (globalThis as Record<PropertyKey, unknown>)[cacheKey] = {};

    const cache = resolveSingletonManagedCache<TestEntry>(cacheKey);
    cachesForCleanup.push(cache);
    const entry = await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      key: "same",
      create: async () => createEntry("repaired"),
    });

    expect(entry.id).toBe("repaired");
    expect(cache.cache).toBeInstanceOf(Map);
    expect(cache.pending).toBeInstanceOf(Map);
    delete (globalThis as Record<PropertyKey, unknown>)[cacheKey];
  });

  it("deduplicates concurrent creation for the same cache key", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    let createCalls = 0;

    const results = await Promise.all(
      Array.from(
        { length: 12 },
        async () =>
          await getOrCreateManagedCacheEntry({
            cache: cache.cache,
            pending: cache.pending,
            key: "same",
            create: async () => {
              createCalls += 1;
              await Promise.resolve();
              return createEntry("shared");
            },
          }),
      ),
    );

    expect(results).toHaveLength(12);
    expect(new Set(results).size).toBe(1);
    expect(createCalls).toBe(1);
  });

  it("waits for pending creation before global teardown closes cached entries", async () => {
    const cache = createTestCache();
    const first = createEntry("first");
    const second = createEntry("second");
    cachesForCleanup.push(cache);
    const gate = createDeferred<void>();

    const pendingFirst = getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      key: "same",
      create: async () => {
        await gate.promise;
        return first;
      },
    });

    const teardown = closeManagedCacheEntries({
      cache: cache.cache,
      pending: cache.pending,
    });
    gate.resolve();

    await teardown;
    expect(first.close).toHaveBeenCalledTimes(1);

    const resolvedFirst = await pendingFirst;
    const resolvedSecond = await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      key: "same",
      create: async () => second,
    });

    expect(resolvedFirst).toBe(first);
    expect(resolvedSecond).toBe(second);
    expect(resolvedSecond).not.toBe(resolvedFirst);
  });

  it("records lastAccessAt when forwarded to getOrCreateManagedCacheEntry", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const before = Date.now();
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "k",
      create: async () => createEntry("e"),
    });
    const recorded = cache.lastAccessAt.get("k");
    expect(recorded).toBeTypeOf("number");
    expect(recorded!).toBeGreaterThanOrEqual(before);
  });

  it("refreshes lastAccessAt on cache hit", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "k",
      create: async () => createEntry("e"),
    });
    const firstAccess = cache.lastAccessAt.get("k")!;
    // Advance time deterministically so the second access has a later
    // timestamp without depending on wall-clock granularity.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(firstAccess + 5_000);
    try {
      await getOrCreateManagedCacheEntry({
        cache: cache.cache,
        pending: cache.pending,
        lastAccessAt: cache.lastAccessAt,
        key: "k",
        create: async () => createEntry("never-called"),
      });
    } finally {
      nowSpy.mockRestore();
    }
    expect(cache.lastAccessAt.get("k")).toBe(firstAccess + 5_000);
  });

  it("closeIdleManagedCacheEntries evicts entries past the idle threshold", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const entry = createEntry("idle");
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "k",
      create: async () => entry,
    });
    // Make the entry look ancient.
    cache.lastAccessAt.set("k", Date.now() - 10_000);
    const evictedKeys: string[] = [];
    const result = await closeIdleManagedCacheEntries({
      cache,
      idleMs: 5_000,
      onEvictKey: (key) => evictedKeys.push(key),
    });
    expect(result.evicted).toBe(1);
    expect(result.remaining).toBe(0);
    expect(entry.close).toHaveBeenCalledTimes(1);
    expect(cache.cache.has("k")).toBe(false);
    expect(cache.lastAccessAt.has("k")).toBe(false);
    expect(evictedKeys).toEqual(["k"]);
  });

  it("closeIdleManagedCacheEntries leaves recently accessed entries alone", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const fresh = createEntry("fresh");
    const stale = createEntry("stale");
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "fresh",
      create: async () => fresh,
    });
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "stale",
      create: async () => stale,
    });
    cache.lastAccessAt.set("stale", Date.now() - 10_000);
    const result = await closeIdleManagedCacheEntries({ cache, idleMs: 5_000 });
    expect(result.evicted).toBe(1);
    expect(result.remaining).toBe(1);
    expect(fresh.close).not.toHaveBeenCalled();
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(cache.cache.has("fresh")).toBe(true);
    expect(cache.cache.has("stale")).toBe(false);
  });

  it("closeIdleManagedCacheEntries isolates close() errors and still evicts the rest", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const failing: TestEntry = {
      id: "failing",
      close: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const ok = createEntry("ok");
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "failing",
      create: async () => failing,
    });
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "ok",
      create: async () => ok,
    });
    cache.lastAccessAt.set("failing", Date.now() - 10_000);
    cache.lastAccessAt.set("ok", Date.now() - 10_000);
    const errors: unknown[] = [];
    const result = await closeIdleManagedCacheEntries({
      cache,
      idleMs: 5_000,
      onCloseError: (err) => errors.push(err),
    });
    expect(result.evicted).toBe(2);
    expect(failing.close).toHaveBeenCalledTimes(1);
    expect(ok.close).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(cache.cache.size).toBe(0);
  });

  it("acquireManagedCacheKey marks the key busy until release fires", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const entry = createEntry("busy");
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "k",
      create: async () => entry,
    });
    expect(isManagedCacheKeyBusy(cache, "k")).toBe(false);
    const release = acquireManagedCacheKey(cache, "k");
    expect(isManagedCacheKeyBusy(cache, "k")).toBe(true);
    release();
    expect(isManagedCacheKeyBusy(cache, "k")).toBe(false);
  });

  it("acquireManagedCacheKey refcounts nested acquires", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const release1 = acquireManagedCacheKey(cache, "k");
    const release2 = acquireManagedCacheKey(cache, "k");
    expect(cache.inflightCount.get("k")).toBe(2);
    release1();
    expect(cache.inflightCount.get("k")).toBe(1);
    expect(isManagedCacheKeyBusy(cache, "k")).toBe(true);
    release2();
    expect(cache.inflightCount.has("k")).toBe(false);
    expect(isManagedCacheKeyBusy(cache, "k")).toBe(false);
  });

  it("release is idempotent and never produces negative counts", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const release = acquireManagedCacheKey(cache, "k");
    release();
    release();
    release();
    expect(cache.inflightCount.has("k")).toBe(false);
  });

  it("acquire and release both refresh lastAccessAt", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const t0 = 1_700_000_000_000;
    const spy = vi.spyOn(Date, "now");
    try {
      spy.mockReturnValue(t0);
      const release = acquireManagedCacheKey(cache, "k");
      expect(cache.lastAccessAt.get("k")).toBe(t0);
      spy.mockReturnValue(t0 + 7_000);
      release();
      expect(cache.lastAccessAt.get("k")).toBe(t0 + 7_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("closeIdleManagedCacheEntries defers busy entries past idleMs", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const entry = createEntry("busy-stale");
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "k",
      create: async () => entry,
    });
    // Simulate a long-running operation acquiring the key while the cache
    // entry ages past idleMs without further refresh.
    const release = acquireManagedCacheKey(cache, "k");
    cache.lastAccessAt.set("k", Date.now() - 30_000);
    const skippedKeys: string[] = [];
    const first = await closeIdleManagedCacheEntries({
      cache,
      idleMs: 5_000,
      onSkipBusy: (key) => skippedKeys.push(key),
    });
    expect(first.evicted).toBe(0);
    expect(first.skippedBusy).toBe(1);
    expect(first.remaining).toBe(1);
    expect(entry.close).not.toHaveBeenCalled();
    expect(cache.cache.has("k")).toBe(true);
    expect(skippedKeys).toEqual(["k"]);

    // Release the in-flight operation. release() refreshes lastAccessAt, so
    // the next sweep is a no-op; we must age the entry again before it can
    // be evicted.
    release();
    expect(isManagedCacheKeyBusy(cache, "k")).toBe(false);
    const second = await closeIdleManagedCacheEntries({ cache, idleMs: 5_000 });
    expect(second.evicted).toBe(0);
    expect(entry.close).not.toHaveBeenCalled();

    cache.lastAccessAt.set("k", Date.now() - 30_000);
    const third = await closeIdleManagedCacheEntries({ cache, idleMs: 5_000 });
    expect(third.evicted).toBe(1);
    expect(third.skippedBusy).toBe(0);
    expect(entry.close).toHaveBeenCalledTimes(1);
    expect(cache.cache.has("k")).toBe(false);
  });

  it("closeIdleManagedCacheEntries evicts non-busy stale entries alongside busy deferrals", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const idle = createEntry("idle");
    const busy = createEntry("busy");
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "idle",
      create: async () => idle,
    });
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "busy",
      create: async () => busy,
    });
    const release = acquireManagedCacheKey(cache, "busy");
    cache.lastAccessAt.set("idle", Date.now() - 30_000);
    cache.lastAccessAt.set("busy", Date.now() - 30_000);
    const result = await closeIdleManagedCacheEntries({ cache, idleMs: 5_000 });
    expect(result.evicted).toBe(1);
    expect(result.skippedBusy).toBe(1);
    expect(result.remaining).toBe(1);
    expect(idle.close).toHaveBeenCalledTimes(1);
    expect(busy.close).not.toHaveBeenCalled();
    release();
  });

  it("closeIdleManagedCacheEntries clears inflightCount on eviction", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const entry = createEntry("e");
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "k",
      create: async () => entry,
    });
    // No in-flight refs; eviction should clean up an empty count entry too.
    cache.inflightCount.set("k", 0);
    cache.lastAccessAt.set("k", Date.now() - 30_000);
    await closeIdleManagedCacheEntries({ cache, idleMs: 5_000 });
    expect(cache.cache.has("k")).toBe(false);
    expect(cache.inflightCount.has("k")).toBe(false);
  });

  it("closeIdleManagedCacheEntries is idempotent when entry.close removes its own cache slot", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const entry: TestEntry = {
      id: "self-evict",
      close: vi.fn(async () => {
        // Simulate MemoryIndexManager.close() removing its own cache entry.
        cache.cache.delete("k");
        cache.lastAccessAt.delete("k");
      }),
    };
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "k",
      create: async () => entry,
    });
    cache.lastAccessAt.set("k", Date.now() - 10_000);
    const result = await closeIdleManagedCacheEntries({ cache, idleMs: 5_000 });
    expect(result.evicted).toBe(1);
    expect(entry.close).toHaveBeenCalledTimes(1);
    expect(cache.cache.size).toBe(0);
  });

  it("closeIdleManagedCacheEntries revalidates lastAccessAt before closing (race: cache hit during scan-to-close gap)", async () => {
    // Regression for PR #85972 ClawSweeper review:
    //   t0: scan collects toEvict[] based on stale lastAccessAt
    //   t1: a concurrent caller does INDEX_CACHE.get(K), refreshing
    //       lastAccessAt without acquiring busy refcount
    //   t2: close loop must NOT close K — the next .search() would hit a
    //       closed manager.
    // We use the deterministic testHookBeforeCloseLoop hook to model
    // the gap between survey and close.
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const entry = createEntry("refreshed-during-gap");
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "k",
      create: async () => entry,
    });
    const now = Date.now();
    cache.lastAccessAt.set("k", now - 30_000); // stale by survey time
    const skippedRevalidatedKeys: string[] = [];
    const result = await closeIdleManagedCacheEntries({
      cache,
      idleMs: 5_000,
      now: () => now,
      onSkipRevalidated: (key) => skippedRevalidatedKeys.push(key),
      testHookBeforeCloseLoop: () => {
        // Simulate a cache hit during the scan-to-close gap. The hit
        // path (getOrCreateManagedCacheEntry) bumps lastAccessAt to
        // `Date.now()` which is necessarily > our captured `now - idleMs`.
        cache.lastAccessAt.set("k", now);
      },
    });
    expect(result.evicted).toBe(0);
    expect(result.skippedRevalidated).toBe(1);
    expect(result.skippedBusy).toBe(0);
    expect(result.remaining).toBe(1);
    expect(entry.close).not.toHaveBeenCalled();
    expect(cache.cache.has("k")).toBe(true);
    expect(cache.lastAccessAt.get("k")).toBe(now);
    expect(skippedRevalidatedKeys).toEqual(["k"]);
  });

  it("closeIdleManagedCacheEntries respects busy state acquired during scan-to-close gap", async () => {
    // Companion test: same race window, but the gap action is
    // acquireManagedCacheKey() rather than a cache hit. Counts under
    // skippedBusy (consistent with the survey-loop busy skip).
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const entry = createEntry("acquired-during-gap");
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "k",
      create: async () => entry,
    });
    const now = Date.now();
    cache.lastAccessAt.set("k", now - 30_000);
    let release: (() => void) | undefined;
    const skippedBusyKeys: string[] = [];
    const result = await closeIdleManagedCacheEntries({
      cache,
      idleMs: 5_000,
      now: () => now,
      onSkipBusy: (key) => skippedBusyKeys.push(key),
      testHookBeforeCloseLoop: () => {
        // Acquire AFTER the survey loop already added the key to stale[].
        // acquireManagedCacheKey also refreshes lastAccessAt, so we reset
        // it to keep the busy branch (not the freshness branch) firing.
        release = acquireManagedCacheKey(cache, "k");
        cache.lastAccessAt.set("k", now - 30_000);
      },
    });
    try {
      expect(result.evicted).toBe(0);
      expect(result.skippedBusy).toBe(1);
      expect(result.skippedRevalidated).toBe(0);
      expect(result.remaining).toBe(1);
      expect(entry.close).not.toHaveBeenCalled();
      expect(cache.cache.has("k")).toBe(true);
      expect(skippedBusyKeys).toEqual(["k"]);
    } finally {
      release?.();
    }
  });

  it("closeIdleManagedCacheEntries treats cache identity replacement as revalidation skip", async () => {
    // If cache.set(key, newEntry) lands in the scan-to-close gap, the
    // captured entry no longer matches the cache slot. We must NOT
    // close either entry: the new one has its own fresh state and the
    // old one was already replaced by the swap caller.
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const original = createEntry("original");
    const replacement = createEntry("replacement");
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "k",
      create: async () => original,
    });
    const now = Date.now();
    cache.lastAccessAt.set("k", now - 30_000);
    const result = await closeIdleManagedCacheEntries({
      cache,
      idleMs: 5_000,
      now: () => now,
      testHookBeforeCloseLoop: () => {
        // Swap in a new instance and keep lastAccessAt stale so the
        // revalidation branch we hit is specifically the identity
        // mismatch one (not the freshness or busy ones).
        cache.cache.set("k", replacement);
      },
    });
    expect(result.evicted).toBe(0);
    expect(result.skippedRevalidated).toBe(1);
    expect(result.skippedBusy).toBe(0);
    expect(original.close).not.toHaveBeenCalled();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(cache.cache.get("k")).toBe(replacement);
  });

  it("closeIdleManagedCacheEntries handles disappearance of cache slot during gap", async () => {
    // Another caller fully tore down the entry during the scan-to-close
    // gap (e.g. a competing closeMemoryIndexManagersForAgent path). The
    // sweep should treat that as a revalidation skip — not crash, not
    // double-close.
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    const entry = createEntry("torn-down");
    await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      lastAccessAt: cache.lastAccessAt,
      key: "k",
      create: async () => entry,
    });
    const now = Date.now();
    cache.lastAccessAt.set("k", now - 30_000);
    const result = await closeIdleManagedCacheEntries({
      cache,
      idleMs: 5_000,
      now: () => now,
      testHookBeforeCloseLoop: () => {
        cache.cache.delete("k");
        // lastAccessAt intentionally not deleted yet — exercise the
        // currentEntry === undefined branch which also cleans it up.
      },
    });
    expect(result.evicted).toBe(0);
    expect(result.skippedRevalidated).toBe(1);
    expect(entry.close).not.toHaveBeenCalled();
    expect(cache.cache.has("k")).toBe(false);
    expect(cache.lastAccessAt.has("k")).toBe(false);
  });

  it("bypasses identity caching for status-only callers", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    let createCalls = 0;

    const first = await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      key: "same",
      bypassCache: true,
      create: async () => {
        createCalls += 1;
        return createEntry(`status-${createCalls}`);
      },
    });
    const second = await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      pending: cache.pending,
      key: "same",
      bypassCache: true,
      create: async () => {
        createCalls += 1;
        return createEntry(`status-${createCalls}`);
      },
    });

    expect(first).not.toBe(second);
    expect(createCalls).toBe(2);
    expect(cache.cache.size).toBe(0);
  });
});
