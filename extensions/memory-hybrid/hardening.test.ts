import { readFile, unlink, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, vi } from "vitest";
import { WorkingMemoryBuffer } from "./buffer.js";
import { GraphDB } from "./graph.js";
import { hybridScore, temporalRelevanceScore } from "./recall.js";

describe("Hardening & Peer Review Fixes (Verification)", () => {
  describe("Temporal Parser (Bug 1.4)", () => {
    test("should handle 'yesterday' in happenedAt and return high score", () => {
      const now = Date.now();
      const entryYesterday = {
        id: "1",
        text: "I bought milk yesterday",
        vector: [],
        importance: 0.5,
        category: "fact",
        createdAt: now,
        happenedAt: "yesterday",
      };

      const score = temporalRelevanceScore(entryYesterday as any);
      // "yesterday" should be parsed as ~24h ago, giving a high score (~0.8+)
      // instead of 0.5 (fallback for NaN) or 0 (remote past)
      expect(score).toBeGreaterThan(0.7);
    });
  });

  describe("Persistent Buffer (Bug 1.3)", () => {
    const testFile = join(tmpdir(), `buffer-test-${Date.now()}.jsonl`);

    test("should persist and reload buffer state", async () => {
      const buffer = new WorkingMemoryBuffer(10);
      buffer.add("test fact", 0.8, "fact");

      await buffer.save(testFile);

      const buffer2 = new WorkingMemoryBuffer(10);
      await buffer2.load(testFile);

      expect(buffer2.size).toBe(1);
      expect(buffer2.stats().total).toBe(1);

      await unlink(testFile);
    });
  });

  describe("Graph Concurrency (Bug 2.2)", () => {
    test("findEdgesForTexts should use the lock in new implementation", async () => {
      const tempPath = join(tmpdir(), `graph-concr-${Date.now()}`);
      await mkdir(tempPath, { recursive: true });

      try {
        const graph = new GraphDB(tempPath);
        // @ts-ignore - reaching into private for testing
        const spy = vi.spyOn(graph, "withLock");

        await graph.findEdgesForTexts(["test"]);

        expect(spy).toHaveBeenCalled();
      } finally {
        await rm(tempPath, { recursive: true, force: true });
      }
    });

    test("hybridScore should be awaitable and handle async graph calls", async () => {
      const tempPath = join(tmpdir(), `graph-recall-${Date.now()}`);
      await mkdir(tempPath, { recursive: true });

      try {
        const graph = new GraphDB(tempPath);
        const results = [
          { entry: { text: "hello", createdAt: Date.now(), importance: 0.5 } as any, score: 0.9 },
        ];

        const scored = await hybridScore(results, graph);
        expect(scored.length).toBe(1);
        expect(scored[0].finalScore).toBeGreaterThan(0);
      } finally {
        await rm(tempPath, { recursive: true, force: true });
      }
    });
  });
});
