import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeIdleManagedCacheEntries,
  closeManagedCacheEntries,
  getOrCreateManagedCacheEntry,
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
