import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Phase 0 — embedding-fallback.test.ts
 *
 * Verifies that when TransformerEmbedding fails to initialize,
 * the system gracefully falls back to HashEmbedding with consistent dimensions,
 * and the WarmStore remains functional (at least BM25 search works).
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

  it("HashEmbedding works standalone as a reliable fallback", async () => {
    const { HashEmbedding } = await import("../../../../src/agents/memory-context/embedding.js");
    const emb = new HashEmbedding(384);
    const vec = await emb.embed("test input");

    expect(vec).toHaveLength(384);
    expect(emb.dim).toBe(384);
    // Should be unit-normalized (L2 norm ~1)
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 1);
  });

  it("createEmbeddingProvider falls back to hash when transformer fails", async () => {
    const { createEmbeddingProvider } =
      await import("../../../../src/agents/memory-context/embedding.js");
    const warnSpy = vi.fn();

    // "transformer" mode with a non-existent model should fail and fall back
    const provider = await createEmbeddingProvider("transformer", 384, "nonexistent/model", {
      warn: warnSpy,
    });

    // Should have fallen back to HashEmbedding
    expect(provider.dim).toBe(384);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/falling back/i);

    // Should still produce valid embeddings
    const vec = await provider.embed("hello world");
    expect(vec).toHaveLength(384);
  });

  it("WarmStore remains functional with hash fallback (BM25 search works)", async () => {
    const { HashEmbedding } = await import("../../../../src/agents/memory-context/embedding.js");
    const { WarmStore } = await import("../../../../src/agents/memory-context/store.js");

    const store = new WarmStore({
      sessionId: "test",
      embedding: new HashEmbedding(64),
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
    const { createEmbeddingProvider } =
      await import("../../../../src/agents/memory-context/embedding.js");
    const { createVectorIndex } =
      await import("../../../../src/agents/memory-context/vector-index.js");

    const provider = await createEmbeddingProvider("transformer", 384, "nonexistent/model", {
      warn: () => {},
    });

    // Index dim must match provider dim
    const index = createVectorIndex("brute", provider.dim);
    const vec = await provider.embed("test");

    // Should not throw — dimensions match
    expect(() => index.add("t1", vec)).not.toThrow();
    expect(index.size).toBe(1);
  });
});
