import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Phase 1 -- store infrastructure tests
 *
 * Covers: deduplication, maxSegments cap, timeline eviction performance.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEmbeddingProvider } from "../core/embedding.js";
import { WarmStore } from "../core/store.js";

describe("store dedup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "store-dedup-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("same content + same session + same role is stored only once", async () => {
    const store = new WarmStore({
      sessionId: "sess1",
      embedding: await createEmbeddingProvider(undefined, "hash"),
      coldStore: { path: tmpDir },
      maxSegments: 100,
    });

    const s1 = await store.addSegment({ role: "user", content: "hello world" });
    const s2 = await store.addSegment({ role: "user", content: "hello world" });

    expect(store.stats().count).toBe(1);
    // Should return the existing segment
    expect(s2!.id).toBe(s1!.id);
  });

  it("same content but different role is stored as separate segments", async () => {
    const store = new WarmStore({
      sessionId: "sess1",
      embedding: await createEmbeddingProvider(undefined, "hash"),
      coldStore: { path: tmpDir },
      maxSegments: 100,
    });

    await store.addSegment({ role: "user", content: "hello world" });
    await store.addSegment({ role: "assistant", content: "hello world" });

    expect(store.stats().count).toBe(2);
  });

  it("different content is stored as separate segments", async () => {
    const store = new WarmStore({
      sessionId: "sess1",
      embedding: await createEmbeddingProvider(undefined, "hash"),
      coldStore: { path: tmpDir },
      maxSegments: 100,
    });

    await store.addSegment({ role: "user", content: "hello there friend" });
    await store.addSegment({ role: "user", content: "world is great today" });

    expect(store.stats().count).toBe(2);
  });
});

describe("store maxSegments", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "store-max-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("evicts oldest segments when exceeding maxSegments", async () => {
    const store = new WarmStore({
      sessionId: "sess1",
      embedding: await createEmbeddingProvider(undefined, "hash"),
      coldStore: { path: tmpDir },
      maxSegments: 5,
    });

    for (let i = 0; i < 10; i++) {
      await store.addSegment({ role: "user", content: `message ${i}`, timestamp: i });
    }

    expect(store.stats().count).toBe(5);

    // Should have kept the most recent 5 (messages 5-9)
    const allSegments = [...store.getAllSegments()];
    const contents = allSegments.map((s) => s.content);
    expect(contents).not.toContain("message 0");
    expect(contents).toContain("message 9");
  });
});

describe("store timeline performance", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "store-perf-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("eviction with many segments completes within reasonable time", async () => {
    const store = new WarmStore({
      sessionId: "sess1",
      embedding: await createEmbeddingProvider(undefined, "hash"),
      coldStore: { path: tmpDir },
      maxSegments: 50,
      vectorPersist: false,
    });

    // Insert 200 segments (forces 150 evictions)
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      await store.addSegment({ role: "user", content: `msg ${i}`, timestamp: i });
    }
    const elapsed = performance.now() - start;

    expect(store.stats().count).toBe(50);
    // Should complete in under 5 seconds even with 200 inserts + evictions
    expect(elapsed).toBeLessThan(5000);
  });
});
