// Memory Lancedb tests cover the per-instance query-embedding cache primitives.
import { describe, expect, test, vi } from "vitest";
import {
  canonicalizeEmbeddingIdentity,
  isCacheableEmbeddingVector,
  QueryEmbeddingCache,
  queryCacheKey,
} from "./query-embedding-cache.js";

describe("queryCacheKey", () => {
  test("hashes the text component and never retains plaintext", () => {
    const secret = "super secret user recall query about salaries";
    const key = queryCacheKey("provider=openai;model=text-embedding-3-small", secret);

    // The raw user/memory text must not appear in the cache key.
    expect(key).not.toContain(secret);
    expect(key).not.toContain("salaries");
    // A SHA-256 hex digest is present instead of the plaintext.
    expect(key).toMatch(/[0-9a-f]{64}/);

    // Equality is preserved: identical identity + text map to the same key.
    expect(queryCacheKey("provider=openai;model=text-embedding-3-small", secret)).toBe(key);
    // Distinct text and distinct identity both produce distinct keys.
    expect(queryCacheKey("provider=openai;model=text-embedding-3-small", "other")).not.toBe(key);
    expect(queryCacheKey("provider=ollama;model=nomic-embed-text", secret)).not.toBe(key);
  });

  test("inFlightKey derived from queryCacheKey also contains no plaintext", () => {
    // The Embeddings classes build inFlightKey as JSON.stringify([key, policy]) where
    // key = queryCacheKey(...). Verify the full construction retains no user text.
    // This closes the residual security-boundary risk: even in-flight pending entries
    // are keyed only by hashes, not by raw recall/store/capture text.
    const sensitiveText = "What is my salary and home address?";
    const identity = "provider=openai;model=text-embedding-3-small";
    const settledKey = queryCacheKey(identity, sensitiveText);

    // Simulate the inFlightKey construction used in both Embeddings implementations.
    const timedInFlightKey = JSON.stringify([settledKey, "timeout:15000"]);
    const untimedInFlightKey = JSON.stringify([settledKey, "untimed"]);

    expect(timedInFlightKey).not.toContain(sensitiveText);
    expect(timedInFlightKey).not.toContain("salary");
    expect(timedInFlightKey).not.toContain("address");
    expect(untimedInFlightKey).not.toContain(sensitiveText);
    // Both contain the SHA-256 digest (still identifiable as a hash).
    expect(timedInFlightKey).toMatch(/[0-9a-f]{64}/);
    // Timed and untimed keys for the same text are distinct (different policy suffix).
    expect(timedInFlightKey).not.toBe(untimedInFlightKey);
  });
});

describe("QueryEmbeddingCache", () => {
  test("collapses identical keys to one compute call", async () => {
    const cache = new QueryEmbeddingCache();
    const compute = vi.fn(async () => [0.1, 0.2, 0.3]);
    const first = await cache.getOrCompute("k", compute);
    const second = await cache.getOrCompute("k", compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(first).toEqual([0.1, 0.2, 0.3]);
    expect(second).toEqual(first);
    // A different key is a separate provider call.
    await cache.getOrCompute("other", compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  test("evicts the oldest entry past capacity", async () => {
    const cache = new QueryEmbeddingCache({ maxEntries: 2 });
    const make = (v: number) => vi.fn(async () => [v]);
    const a = make(1);
    const b = make(2);
    const c = make(3);
    await cache.getOrCompute("a", a); // [a]
    await cache.getOrCompute("b", b); // [a, b]
    await cache.getOrCompute("c", c); // overflow -> evict oldest "a" -> [b, c]
    // "a" was evicted, so recomputing it calls its factory again.
    await cache.getOrCompute("a", a);
    expect(a).toHaveBeenCalledTimes(2);
    // "c" is still resident -> served from cache, no recompute.
    await cache.getOrCompute("c", c);
    expect(c).toHaveBeenCalledTimes(1);
    // Recency is bumped on hit: read "c" then add a new key -> the older "a"
    // (not the just-read "c") is evicted next.
    const d = make(4);
    await cache.getOrCompute("c", c); // bump "c" to most-recent -> [a, c]... then read
    await cache.getOrCompute("d", d); // overflow -> evict oldest "a" -> [c, d]
    await cache.getOrCompute("c", c);
    expect(c).toHaveBeenCalledTimes(1); // "c" survived as most-recently-used
    await cache.getOrCompute("a", a);
    expect(a).toHaveBeenCalledTimes(3); // "a" was evicted again
  });

  test("does not memoize a thrown error and retries", async () => {
    const cache = new QueryEmbeddingCache();
    const compute = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce([0.5, 0.6]);
    await expect(cache.getOrCompute("k", compute)).rejects.toThrow("transient");
    // The failed entry must not be memoized: the next call retries the provider.
    await expect(cache.getOrCompute("k", compute)).resolves.toEqual([0.5, 0.6]);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  test("does not memoize empty or zero vectors", async () => {
    const cache = new QueryEmbeddingCache();
    const empty = vi.fn(async () => []);
    await cache.getOrCompute("empty", empty);
    await cache.getOrCompute("empty", empty);
    expect(empty).toHaveBeenCalledTimes(2);
    const zero = vi.fn(async () => [0, 0, 0]);
    await cache.getOrCompute("zero", zero);
    await cache.getOrCompute("zero", zero);
    expect(zero).toHaveBeenCalledTimes(2);
  });

  test("when disabled, never memoizes and recomputes every call", async () => {
    const cache = new QueryEmbeddingCache({ enabled: false });
    const compute = vi.fn(async () => [0.1, 0.2, 0.3]);
    const first = await cache.getOrCompute("k", compute);
    const second = await cache.getOrCompute("k", compute);
    // Disabled cache is a pass-through: identical keys still recompute.
    expect(compute).toHaveBeenCalledTimes(2);
    expect(first).toEqual([0.1, 0.2, 0.3]);
    expect(second).toEqual(first);
  });

  test("collapses concurrent identical embeds to one compute call", async () => {
    const cache = new QueryEmbeddingCache();
    // The value cached is the in-flight promise, so two embeds launched before
    // the first resolves still share a single compute.
    const compute = vi.fn(
      () =>
        new Promise<number[]>((resolve) => {
          setTimeout(() => resolve([1, 2]), 5);
        }),
    );
    const [a, b] = await Promise.all([
      cache.getOrCompute("k", compute),
      cache.getOrCompute("k", compute),
    ]);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  test("concurrent distinct-key flood stays within maxEntries bound", async () => {
    const maxEntries = 4;
    const cache = new QueryEmbeddingCache({ maxEntries });

    // Launch many distinct keys concurrently: more than the cache capacity.
    // After all settle, the cache must not retain more than maxEntries vectors.
    const keyCount = 12;
    const computes = Array.from({ length: keyCount }, (_, i) => vi.fn(async () => [i + 1, 0, 0]));
    await Promise.all(computes.map((compute, i) => cache.getOrCompute(`key-${i}`, compute)));

    // The cache is bounded: at most maxEntries entries can be resident after
    // all promises settle. Verify by requesting the last `maxEntries` keys —
    // they must be served from cache (compute not called again), while earlier
    // keys were evicted and would recompute (we don't assert which specific
    // keys survive since settle order is implementation-defined, but we assert
    // total distinct resident entries ≤ maxEntries).
    let cacheHits = 0;
    for (let i = 0; i < keyCount; i++) {
      const compute = computes[i];
      const callsBefore = compute.mock.calls.length;
      await cache.getOrCompute(`key-${i}`, compute);
      if (compute.mock.calls.length === callsBefore) {
        cacheHits += 1;
      }
    }
    // The number of keys still resident (cache hits) must not exceed the bound.
    expect(cacheHits).toBeLessThanOrEqual(maxEntries);
  });

  test("a fresh instance starts empty and does not share state with prior instances", async () => {
    // Two independent QueryEmbeddingCache instances must never share vectors.
    // This is the per-instance isolation invariant: a reconfigure that builds a
    // fresh embeddings object gets a clean cache.
    const computeA = vi.fn(async () => [1, 2, 3]);
    const computeB = vi.fn(async () => [4, 5, 6]);

    const cacheA = new QueryEmbeddingCache();
    const cacheB = new QueryEmbeddingCache();

    // Warm cacheA with "hello".
    await cacheA.getOrCompute("hello", computeA);
    expect(computeA).toHaveBeenCalledTimes(1);

    // cacheB is independent: a lookup for "hello" in cacheB must NOT find
    // cacheA's entry and must call its own compute.
    await cacheB.getOrCompute("hello", computeB);
    expect(computeB).toHaveBeenCalledTimes(1);

    // cacheA still serves its own entry without recomputing.
    await cacheA.getOrCompute("hello", computeA);
    expect(computeA).toHaveBeenCalledTimes(1); // still 1, served from cacheA's LRU
  });

  test("does not share timeout-bound in-flight work with untimed callers", async () => {
    const cache = new QueryEmbeddingCache();
    const timed = vi.fn(async () => {
      throw new Error("timed out");
    });
    const untimed = vi.fn(async () => [3, 4]);

    const timedResult = cache.getOrCompute("k", timed, { inFlightKey: "k:timeout:100" });
    const untimedResult = cache.getOrCompute("k", untimed, { inFlightKey: "k:untimed" });

    await expect(timedResult).rejects.toThrow("timed out");
    await expect(untimedResult).resolves.toEqual([3, 4]);
    expect(timed).toHaveBeenCalledTimes(1);
    expect(untimed).toHaveBeenCalledTimes(1);

    const afterSettled = vi.fn(async () => [5, 6]);
    await expect(
      cache.getOrCompute("k", afterSettled, { inFlightKey: "k:timeout:200" }),
    ).resolves.toEqual([3, 4]);
    expect(afterSettled).not.toHaveBeenCalled();
  });
});

describe("canonicalizeEmbeddingIdentity", () => {
  test("is stable across top-level key order", () => {
    const a = canonicalizeEmbeddingIdentity({ model: "m", provider: "p", dimensions: 3 });
    const b = canonicalizeEmbeddingIdentity({ dimensions: 3, provider: "p", model: "m" });
    expect(a).toBe(b);
  });

  test("distinguishes different models/dims so vectors never collide", () => {
    const modelA = canonicalizeEmbeddingIdentity({ provider: "p", model: "a", dimensions: 3 });
    const modelB = canonicalizeEmbeddingIdentity({ provider: "p", model: "b", dimensions: 3 });
    const dims4 = canonicalizeEmbeddingIdentity({ provider: "p", model: "a", dimensions: 4 });
    expect(modelA).not.toBe(modelB);
    expect(modelA).not.toBe(dims4);
  });

  test("distinguishes NESTED identity fields (headers) without retaining them", () => {
    // Regression guard for the replacer-array trap: a JSON.stringify replacer
    // array filters nested objects, erasing cacheKeyData.headers and letting two
    // distinct identities serialize identically. These two identities differ
    // ONLY in a nested header and must still produce different keys.
    const withHeaderA = canonicalizeEmbeddingIdentity({
      provider: "p",
      model: "m",
      headers: { authorization: "token-a" },
    });
    const withHeaderB = canonicalizeEmbeddingIdentity({
      provider: "p",
      model: "m",
      headers: { authorization: "token-b" },
    });
    // Separation is preserved: nested header difference still changes the digest.
    expect(withHeaderA).not.toBe(withHeaderB);
    // SECURITY: the canonical identity is a SHA-256 digest, so provider-owned
    // secret-shaped material (an authorization-like nested field) is NEVER
    // retained verbatim in the returned identity token.
    expect(withHeaderA).toMatch(/^[0-9a-f]{64}$/);
    expect(withHeaderA).not.toContain("token-a");
    expect(withHeaderA).not.toContain("authorization");
  });

  test("authorization-like identity material is absent from the composed cache key", () => {
    // End-to-end guard for the security-boundary finding: an authorization-like
    // nested field fed through canonicalizeEmbeddingIdentity -> queryCacheKey ->
    // inFlightKey must never appear in clear text in any retained key. distinct
    // tokens still separate (no collision) while the secret stays out of heap.
    const identityA = canonicalizeEmbeddingIdentity({
      provider: "openai",
      model: "text-embedding-3-small",
      headers: { authorization: "Bearer sk-super-secret-token" },
    });
    const identityB = canonicalizeEmbeddingIdentity({
      provider: "openai",
      model: "text-embedding-3-small",
      headers: { authorization: "Bearer sk-different-token" },
    });
    const text = "recall query about salaries";
    const keyA = queryCacheKey(identityA, text);
    const keyB = queryCacheKey(identityB, text);
    const inFlightKeyA = JSON.stringify([keyA, "untimed"]);

    // Distinct authorization material -> distinct keys (identity separation holds).
    expect(keyA).not.toBe(keyB);
    // The secret token never appears in the settled key or the in-flight key.
    for (const retained of [keyA, inFlightKeyA]) {
      expect(retained).not.toContain("sk-super-secret-token");
      expect(retained).not.toContain("Bearer");
      expect(retained).not.toContain("authorization");
    }
  });
});

describe("isCacheableEmbeddingVector", () => {
  test("accepts a genuine non-empty, finite, non-zero vector", () => {
    expect(isCacheableEmbeddingVector([0.1, 0, 0.2])).toBe(true);
  });

  test("rejects empty, all-zero, and non-finite vectors", () => {
    expect(isCacheableEmbeddingVector([])).toBe(false);
    expect(isCacheableEmbeddingVector([0, 0, 0])).toBe(false);
    expect(isCacheableEmbeddingVector([1, Number.NaN])).toBe(false);
    expect(isCacheableEmbeddingVector([Number.POSITIVE_INFINITY])).toBe(false);
  });
});
