import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Phase 0 — embedding-fallback.test.ts
 *
 * Verifies that when the unified embedding system fails to find
 * a suitable remote/local/transformer provider, the memory-context
 * adapter gracefully degrades to hash or noop,
 * and the WarmStore remains functional (at least BM25 search works).
 *
 * Updated to use the new createEmbeddingProvider(cfg, type, logger)
 * adapter API that wraps the unified src/memory/embeddings.ts system.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("embedding fallback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "emb-fallback-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hash embedding works standalone as a reliable fallback", async () => {
    const { createEmbeddingProvider } = await import("../core/embedding.js");

    // "hash" type goes straight to the local hash implementation
    const provider = await createEmbeddingProvider(undefined, "hash");
    expect(provider.name).toBe("hash");

    const vec = await provider.embed("test input");
    expect(vec).toHaveLength(384);
    expect(provider.dim).toBe(384);

    // Should be unit-normalized (L2 norm ~1)
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 1);
  });

  it("createEmbeddingProvider falls back gracefully when providers unavailable", async () => {
    const { createEmbeddingProvider } = await import("../core/embedding.js");
    const warnSpy = vi.fn();

    // "auto" with no providers available → unified system returns noop → adapter
    // converts to dim=1 zero-vector or falls back to hash
    const provider = await createEmbeddingProvider(undefined, "auto", { warn: warnSpy });

    // Should have a valid provider regardless of fallback path
    expect(provider.dim).toBeGreaterThan(0);

    // Should still produce valid embeddings
    const vec = await provider.embed("hello world");
    expect(vec).toHaveLength(provider.dim);
  });

  it("WarmStore remains functional with hash fallback (BM25 search works)", async () => {
    const { createEmbeddingProvider } = await import("../core/embedding.js");
    const { WarmStore } = await import("../core/store.js");

    // Use hash provider directly as a reliable embedding source
    const hashProvider = await createEmbeddingProvider(undefined, "hash");

    const store = new WarmStore({
      sessionId: "test",
      embedding: hashProvider,
      coldStore: { path: tmpDir },
      maxSegments: 100,
    });

    await store.addSegment({ role: "user", content: "implement stripe webhook handler" });
    await store.addSegment({
      role: "assistant",
      content: "I created src/payment/webhook.ts with signature verification",
    });

    // BM25 search should work regardless of embedding quality
    const bm25Results = store.searchByBM25("webhook", 5);
    expect(bm25Results.length).toBeGreaterThan(0);
    expect(bm25Results.some((r) => r.score > 0)).toBe(true);
  });

  it("vector index dimension matches embedding dimension after fallback", async () => {
    const { createEmbeddingProvider } = await import("../core/embedding.js");
    const { createVectorIndex } = await import("../core/vector-index.js");

    // hash type is always stable → dim = 384
    const provider = await createEmbeddingProvider(undefined, "hash");

    // Index dim must match provider dim
    const index = createVectorIndex("brute", provider.dim);
    const vec = await provider.embed("test");

    // Should not throw — dimensions match
    expect(() => index.add("t1", vec)).not.toThrow();
    expect(index.size).toBe(1);
  });

  it("hash embedding is deterministic for same input", async () => {
    const { createEmbeddingProvider } = await import("../core/embedding.js");

    const provider = await createEmbeddingProvider(undefined, "hash");
    const v1 = await provider.embed("deterministic test");
    const v2 = await provider.embed("deterministic test");
    expect(v1).toEqual(v2);
  });

  it("hash embedding handles CJK/Unicode text", async () => {
    const { createEmbeddingProvider } = await import("../core/embedding.js");

    const provider = await createEmbeddingProvider(undefined, "hash");
    const vec = await provider.embed("你好世界 こんにちは 🎉");
    expect(vec).toHaveLength(384);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 1);
  });
});
