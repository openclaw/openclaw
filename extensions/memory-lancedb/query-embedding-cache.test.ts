// Memory Lancedb tests cover the per-instance query-embedding cache primitives.
import { describe, expect, test, vi } from "vitest";
import {
  canonicalizeEmbeddingIdentity,
  isCacheableEmbeddingVector,
  QueryEmbeddingCache,
} from "./query-embedding-cache.js";

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

  test("preserves NESTED identity fields (headers) so they cannot collide", () => {
    // Regression guard for the replacer-array trap: a JSON.stringify replacer
    // array filters nested objects, erasing cacheKeyData.headers and letting two
    // distinct identities serialize identically. These two identities differ
    // ONLY in a nested header and must produce different keys.
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
    expect(withHeaderA).not.toBe(withHeaderB);
    expect(withHeaderA).toContain("token-a");
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
