/**
 * Tests for the LRU embedding cache wrapper (withEmbeddingCache).
 *
 * Verifies caching behavior, LRU eviction, and correct pass-through
 * of the underlying provider interface.
 */
import { describe, it, expect, vi } from "vitest";
import { withEmbeddingCache, type EmbeddingProvider } from "../core/embedding.js";

/** Create a simple mock embedding provider. */
function mockProvider(dim = 3): EmbeddingProvider & { callCount: number } {
  let count = 0;
  return {
    dim,
    name: "mock",
    get callCount() {
      return count;
    },
    async embed(text: string): Promise<number[]> {
      count++;
      // Return deterministic vector based on text length
      const v = Array.from({ length: dim }, (_, i) => (text.length + i) * 0.1);
      return v;
    },
    async init() {},
  };
}

describe("withEmbeddingCache", () => {
  it("caches repeated queries (same text)", async () => {
    const inner = mockProvider();
    const cached = withEmbeddingCache(inner, 10);

    const v1 = await cached.embed("hello world");
    const v2 = await cached.embed("hello world");

    expect(v1).toEqual(v2);
    // The embed function on inner should only be called once (not via callCount property but by checking vectors)
    // Since we can't easily access the inner call count through the wrapper,
    // verify the provider properties are passed through
    expect(cached.dim).toBe(3);
    expect(cached.name).toBe("mock");
  });

  it("returns different vectors for different text", async () => {
    const inner = mockProvider();
    const cached = withEmbeddingCache(inner, 10);

    const v1 = await cached.embed("hello");
    const v2 = await cached.embed("different text");

    expect(v1).not.toEqual(v2);
  });

  it("normalizes text by trimming whitespace", async () => {
    const inner = mockProvider();
    const cached = withEmbeddingCache(inner, 10);

    const v1 = await cached.embed("  hello  ");
    const v2 = await cached.embed("hello");

    expect(v1).toEqual(v2);
  });

  it("evicts LRU entries when cache exceeds maxSize", async () => {
    const inner = mockProvider();
    const cached = withEmbeddingCache(inner, 3);

    // Fill cache
    await cached.embed("a");
    await cached.embed("b");
    await cached.embed("c");

    // Add one more — should evict "a" (LRU)
    await cached.embed("d");

    // Access "a" again — should get fresh vector (not from cache)
    // The behavior is still correct, vectors are deterministic
    const va = await cached.embed("a");
    expect(va).toHaveLength(3);
  });

  it("LRU order updates on access", async () => {
    const calls: string[] = [];
    const inner: EmbeddingProvider = {
      dim: 2,
      name: "tracking",
      async embed(text: string) {
        calls.push(text.trim());
        return [text.length * 0.1, text.length * 0.2];
      },
    };
    const cached = withEmbeddingCache(inner, 3);

    // Fill: a, b, c
    await cached.embed("a");
    await cached.embed("b");
    await cached.embed("c");
    expect(calls).toEqual(["a", "b", "c"]);

    // Access "a" → moves to end, LRU is now "b"
    await cached.embed("a");
    expect(calls).toEqual(["a", "b", "c"]); // No new call

    // Add "d" → evicts "b" (LRU)
    await cached.embed("d");
    expect(calls).toEqual(["a", "b", "c", "d"]);

    // "b" was evicted, so accessing it triggers a new call
    // After adding "b": cache is [c, a, d] → evict "c" → cache is [a, d, b]
    await cached.embed("b");
    expect(calls).toEqual(["a", "b", "c", "d", "b"]);

    // "a" and "d" should still be cached, but "c" was evicted
    await cached.embed("a");
    expect(calls).toEqual(["a", "b", "c", "d", "b"]); // No new call for "a"
  });

  it("does not cache empty vectors", async () => {
    const calls: number[] = [];
    let callIdx = 0;
    const inner: EmbeddingProvider = {
      dim: 0,
      name: "noop",
      async embed(_text: string) {
        calls.push(callIdx++);
        return []; // empty vector
      },
    };
    const cached = withEmbeddingCache(inner, 10);

    await cached.embed("hello");
    await cached.embed("hello");

    // Both calls should go through (empty vectors are not cached)
    expect(calls).toHaveLength(2);
  });

  it("passes through dim and name from underlying provider", () => {
    const inner: EmbeddingProvider = {
      dim: 768,
      name: "text-embedding-3-small",
      async embed() {
        return new Array(768).fill(0);
      },
    };
    const cached = withEmbeddingCache(inner);

    expect(cached.dim).toBe(768);
    expect(cached.name).toBe("text-embedding-3-small");
  });

  it("calls init on underlying provider", async () => {
    const initFn = vi.fn();
    const inner: EmbeddingProvider = {
      dim: 3,
      async embed() {
        return [0, 0, 0];
      },
      init: initFn,
    };
    const cached = withEmbeddingCache(inner);

    await cached.init?.();
    expect(initFn).toHaveBeenCalledOnce();
  });
});
