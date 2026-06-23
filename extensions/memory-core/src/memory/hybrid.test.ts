// Memory Core tests cover hybrid plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";

describe("memory hybrid helpers", () => {
  it("buildFtsQuery tokenizes and AND-joins", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" AND "world"');
    expect(buildFtsQuery("FOO_bar baz-1")).toBe('"FOO_bar" AND "baz" AND "1"');
    expect(buildFtsQuery("金银价格")).toBe('"金银价格"');
    expect(buildFtsQuery("価格 2026年")).toBe('"価格" AND "2026年"');
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("bm25RankToScore is monotonic and clamped", () => {
    expect(bm25RankToScore(0)).toBeCloseTo(1);
    expect(bm25RankToScore(1)).toBeCloseTo(0.5);
    expect(bm25RankToScore(10)).toBeLessThan(bm25RankToScore(1));
    expect(bm25RankToScore(-100)).toBeCloseTo(1, 1);
  });

  it("bm25RankToScore preserves FTS5 BM25 relevance ordering", () => {
    const strongest = bm25RankToScore(-4.2);
    const middle = bm25RankToScore(-2.1);
    const weakest = bm25RankToScore(-0.5);

    expect(strongest).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(weakest);
    expect(strongest).not.toBe(middle);
    expect(middle).not.toBe(weakest);
  });

  it("mergeHybridResults unions by id and combines weighted scores", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.9,
        },
      ],
      keyword: [
        {
          id: "b",
          path: "memory/b.md",
          startLine: 3,
          endLine: 4,
          source: "memory",
          snippet: "kw-b",
          textScore: 1,
        },
      ],
    });

    expect(merged).toHaveLength(2);
    const a = merged.find((r) => r.path === "memory/a.md");
    const b = merged.find((r) => r.path === "memory/b.md");
    expect(a?.score).toBeCloseTo(0.7 * 0.9);
    expect(a?.vectorScore).toBeCloseTo(0.9);
    expect(a?.textScore).toBe(0);
    expect(b?.score).toBeCloseTo(0.3 * 1);
    expect(b?.vectorScore).toBe(0);
    expect(b?.textScore).toBeCloseTo(1);
  });

  it("mergeHybridResults prefers keyword snippet when ids overlap", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.2,
        },
      ],
      keyword: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "kw-a",
          textScore: 1,
        },
      ],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.snippet).toBe("kw-a");
    expect(merged[0]?.score).toBeCloseTo(0.5 * 0.2 + 0.5 * 1);
    expect(merged[0]?.vectorScore).toBeCloseTo(0.2);
    expect(merged[0]?.textScore).toBeCloseTo(1);
  });

  describe("mergeHybridResults with injected reranker", () => {
    const mockReranker = vi.fn(
      async (items: Array<{ id: string; score: number; content: string }>, _lambda: number) => {
        // Sort by score descending (highest first)
        const sorted = [...items].toSorted((a, b) => b.score - a.score);
        return sorted;
      },
    );

    beforeEach(() => {
      mockReranker.mockClear();
    });

    it("single stage → reranker function called; result order matches mock return", async () => {
      const merged = await mergeHybridResults({
        vectorWeight: 0.7,
        textWeight: 0.3,
        vector: [
          {
            id: "a",
            path: "memory/a.md",
            startLine: 1,
            endLine: 2,
            source: "memory",
            snippet: "vec-a",
            vectorScore: 0.9,
          },
          {
            id: "b",
            path: "memory/b.md",
            startLine: 3,
            endLine: 4,
            source: "memory",
            snippet: "vec-b",
            vectorScore: 0.8,
          },
        ],
        keyword: [],
        rerank: { enabled: true, stages: [{ adapter: mockReranker, lambda: 0.7 }] },
      });

      expect(mockReranker).toHaveBeenCalledTimes(1);
      expect(merged).toHaveLength(2);
      // Mock returns sorted by score, so a (0.9) comes before b (0.8)
      expect(merged[0]?.path).toBe("memory/a.md");
      expect(merged[1]?.path).toBe("memory/b.md");
    });

    it("no stages → reranker function not called; score order preserved", async () => {
      const merged = await mergeHybridResults({
        vectorWeight: 0.7,
        textWeight: 0.3,
        vector: [
          {
            id: "a",
            path: "memory/a.md",
            startLine: 1,
            endLine: 2,
            source: "memory",
            snippet: "vec-a",
            vectorScore: 0.9,
          },
          {
            id: "b",
            path: "memory/b.md",
            startLine: 3,
            endLine: 4,
            source: "memory",
            snippet: "vec-b",
            vectorScore: 0.8,
          },
        ],
        keyword: [],
        rerank: { enabled: true, stages: [] },
        // No stages: simulates the manager resolving an empty or fully uninstalled pipeline
      });

      expect(mockReranker).not.toHaveBeenCalled();
      expect(merged).toHaveLength(2);
      // Score order preserved (0.9 > 0.8)
      expect(merged[0]?.path).toBe("memory/a.md");
      expect(merged[1]?.path).toBe("memory/b.md");
    });

    it("stage throws → next stage runs; error swallowed", async () => {
      const errorReranker = vi.fn(async () => {
        throw new Error("Primary reranker failed");
      });

      const fallbackReranker = vi.fn(
        async (items: Array<{ id: string; score: number; content: string }>, _lambda: number) => {
          // Sort by score descending
          const sorted = [...items].toSorted((a, b) => b.score - a.score);
          return sorted;
        },
      );

      const merged = await mergeHybridResults({
        vectorWeight: 0.7,
        textWeight: 0.3,
        vector: [
          {
            id: "a",
            path: "memory/a.md",
            startLine: 1,
            endLine: 2,
            source: "memory",
            snippet: "vec-a",
            vectorScore: 0.9,
          },
        ],
        keyword: [],
        rerank: {
          enabled: true,
          stages: [{ adapter: errorReranker }, { adapter: fallbackReranker }],
        },
      });

      expect(errorReranker).toHaveBeenCalledTimes(1);
      expect(fallbackReranker).toHaveBeenCalledTimes(1);
      expect(merged).toHaveLength(1);
      expect(merged[0]?.path).toBe("memory/a.md");
    });

    it("single remaining stage runs; score order from stage", async () => {
      const fallbackReranker = vi.fn(
        async (items: Array<{ id: string; score: number; content: string }>, _lambda: number) => {
          const sorted = [...items].toSorted((a, b) => b.score - a.score);
          return sorted;
        },
      );

      const merged = await mergeHybridResults({
        vectorWeight: 0.7,
        textWeight: 0.3,
        vector: [
          {
            id: "a",
            path: "memory/a.md",
            startLine: 1,
            endLine: 2,
            source: "memory",
            snippet: "vec-a",
            vectorScore: 0.9,
          },
          {
            id: "b",
            path: "memory/b.md",
            startLine: 3,
            endLine: 4,
            source: "memory",
            snippet: "vec-b",
            vectorScore: 0.8,
          },
        ],
        keyword: [],
        rerank: { enabled: true, stages: [{ adapter: fallbackReranker }] },
        // Manager drops the uninstalled primary stage, leaving only this stage.
      });

      expect(mockReranker).not.toHaveBeenCalled();
      expect(fallbackReranker).toHaveBeenCalledTimes(1);
      expect(merged).toHaveLength(2);
      expect(merged[0]?.path).toBe("memory/a.md");
      expect(merged[1]?.path).toBe("memory/b.md");
    });

    it("stage throws + no later stage → fail-open; returns score-ordered results (no throw)", async () => {
      const errorReranker = vi.fn(async () => {
        throw new Error("Primary reranker failed");
      });

      const merged = await mergeHybridResults({
        vectorWeight: 0.7,
        textWeight: 0.3,
        vector: [
          {
            id: "a",
            path: "memory/a.md",
            startLine: 1,
            endLine: 2,
            source: "memory",
            snippet: "vec-a",
            vectorScore: 0.9,
          },
          {
            id: "b",
            path: "memory/b.md",
            startLine: 3,
            endLine: 4,
            source: "memory",
            snippet: "vec-b",
            vectorScore: 0.8,
          },
        ],
        keyword: [],
        rerank: { enabled: true, stages: [{ adapter: errorReranker }] },
      });

      expect(errorReranker).toHaveBeenCalledTimes(1);
      // Fail-open: returns score-ordered results
      expect(merged).toHaveLength(2);
      expect(merged[0]?.path).toBe("memory/a.md");
      expect(merged[1]?.path).toBe("memory/b.md");
    });

    it("rerank enabled but no installed stages → fail-open; score-sorted results returned", async () => {
      // Simulates the upgrade case: rerank is enabled in config but the named
      // plugin is not installed, so the manager drops it and passes no stages.
      const merged = await mergeHybridResults({
        vectorWeight: 0.7,
        textWeight: 0.3,
        vector: [
          {
            id: "a",
            path: "memory/a.md",
            startLine: 1,
            endLine: 2,
            source: "memory",
            snippet: "vec-a",
            vectorScore: 0.9,
          },
          {
            id: "b",
            path: "memory/b.md",
            startLine: 3,
            endLine: 4,
            source: "memory",
            snippet: "vec-b",
            vectorScore: 0.8,
          },
        ],
        keyword: [],
        rerank: { enabled: true, stages: [] },
        // Manager drops stages whose plugin is not installed, leaving no stages.
      });

      expect(mockReranker).not.toHaveBeenCalled();
      expect(merged).toHaveLength(2);
      // Fail-open: score-ordered results, no error thrown
      expect(merged[0]?.path).toBe("memory/a.md");
      expect(merged[1]?.path).toBe("memory/b.md");
    });

    it("rerank enabled but all stages uninstalled → fail-open; score-sorted results returned", async () => {
      // Simulates: every configured stage names a plugin that is not installed
      // (e.g. after an incomplete upgrade or reload), so the manager passes none.
      const merged = await mergeHybridResults({
        vectorWeight: 0.7,
        textWeight: 0.3,
        vector: [
          {
            id: "a",
            path: "memory/a.md",
            startLine: 1,
            endLine: 2,
            source: "memory",
            snippet: "vec-a",
            vectorScore: 0.9,
          },
          {
            id: "b",
            path: "memory/b.md",
            startLine: 3,
            endLine: 4,
            source: "memory",
            snippet: "vec-b",
            vectorScore: 0.8,
          },
        ],
        keyword: [],
        rerank: { enabled: true, stages: [] },
        // Manager drops all stages whose plugins are not installed.
      });

      expect(mockReranker).not.toHaveBeenCalled();
      expect(merged).toHaveLength(2);
      // Fail-open: score-ordered results, no error thrown
      expect(merged[0]?.path).toBe("memory/a.md");
      expect(merged[1]?.path).toBe("memory/b.md");
    });

    it("reranker returning empty or invalid rerank results falls back to score order", async () => {
      const emptyReranker = vi.fn(
        async () => [] as Array<{ id: string; score: number; content: string }>,
      );
      const invalidIdReranker = vi.fn(
        async () =>
          [
            { id: "missing-a", score: 1, content: "missing-a" },
            { id: "missing-b", score: 0.5, content: "missing-b" },
          ] as Array<{ id: string; score: number; content: string }>,
      );

      const emptyFallback = await mergeHybridResults({
        vectorWeight: 0.7,
        textWeight: 0.3,
        vector: [
          {
            id: "a",
            path: "memory/a.md",
            startLine: 1,
            endLine: 2,
            source: "memory",
            snippet: "vec-a",
            vectorScore: 0.9,
          },
          {
            id: "b",
            path: "memory/b.md",
            startLine: 3,
            endLine: 4,
            source: "memory",
            snippet: "vec-b",
            vectorScore: 0.8,
          },
        ],
        keyword: [],
        rerank: { enabled: true, stages: [{ adapter: emptyReranker }] },
      });

      const invalidFallback = await mergeHybridResults({
        vectorWeight: 0.7,
        textWeight: 0.3,
        vector: [
          {
            id: "a",
            path: "memory/a.md",
            startLine: 1,
            endLine: 2,
            source: "memory",
            snippet: "vec-a",
            vectorScore: 0.9,
          },
          {
            id: "b",
            path: "memory/b.md",
            startLine: 3,
            endLine: 4,
            source: "memory",
            snippet: "vec-b",
            vectorScore: 0.8,
          },
        ],
        keyword: [],
        rerank: { enabled: true, stages: [{ adapter: invalidIdReranker }] },
      });

      expect(emptyReranker).toHaveBeenCalledTimes(1);
      expect(invalidIdReranker).toHaveBeenCalledTimes(1);
      expect(emptyFallback).toHaveLength(2);
      expect(invalidFallback).toHaveLength(2);
      expect(emptyFallback[0]?.path).toBe("memory/a.md");
      expect(emptyFallback[1]?.path).toBe("memory/b.md");
      expect(invalidFallback[0]?.path).toBe("memory/a.md");
      expect(invalidFallback[1]?.path).toBe("memory/b.md");
    });

    it("narrows survivors to topK between stages so later stages see a smaller set", async () => {
      const firstStage = vi.fn(
        async (items: Array<{ id: string; score: number; content: string }>, _lambda: number) =>
          [...items].toSorted((a, b) => b.score - a.score),
      );
      let secondStageInputSize = -1;
      const secondStage = vi.fn(
        async (items: Array<{ id: string; score: number; content: string }>, _lambda: number) => {
          secondStageInputSize = items.length;
          return [...items].toSorted((a, b) => b.score - a.score);
        },
      );

      const vector = Array.from({ length: 6 }, (_, i) => ({
        id: `id-${i}`,
        path: `memory/${i}.md`,
        startLine: 1,
        endLine: 2,
        source: "memory" as const,
        snippet: `vec-${i}`,
        vectorScore: 1 - i * 0.1,
      }));

      const merged = await mergeHybridResults({
        vectorWeight: 1,
        textWeight: 0,
        vector,
        keyword: [],
        rerank: {
          enabled: true,
          stages: [{ adapter: firstStage, topK: 2 }, { adapter: secondStage }],
        },
      });

      expect(firstStage).toHaveBeenCalledTimes(1);
      expect(secondStage).toHaveBeenCalledTimes(1);
      // First stage saw all 6; its topK=2 narrows what the second stage receives.
      expect(secondStageInputSize).toBe(2);
      expect(merged).toHaveLength(2);
      expect(merged[0]?.path).toBe("memory/0.md");
      expect(merged[1]?.path).toBe("memory/1.md");
    });

    it("failed stage with topK does not narrow → next stage sees full original input", async () => {
      // Stage 0 declares topK but throws. Its topK must be ignored so stage 1
      // receives the same input stage 0 received, not an arbitrary head-slice.
      const errorStage = vi.fn(async () => {
        throw new Error("stage-0 failed");
      });
      let secondStageInputSize = -1;
      const secondStage = vi.fn(
        async (items: Array<{ id: string; score: number; content: string }>, _lambda: number) => {
          secondStageInputSize = items.length;
          return [...items].toSorted((a, b) => b.score - a.score);
        },
      );

      const vector = Array.from({ length: 6 }, (_, i) => ({
        id: `id-${i}`,
        path: `memory/${i}.md`,
        startLine: 1,
        endLine: 2,
        source: "memory" as const,
        snippet: `vec-${i}`,
        vectorScore: 1 - i * 0.1,
      }));

      const merged = await mergeHybridResults({
        vectorWeight: 1,
        textWeight: 0,
        vector,
        keyword: [],
        rerank: {
          enabled: true,
          stages: [{ adapter: errorStage, topK: 2 }, { adapter: secondStage }],
        },
      });

      expect(errorStage).toHaveBeenCalledTimes(1);
      expect(secondStage).toHaveBeenCalledTimes(1);
      // topK from the failed stage must not be applied: stage 1 sees all 6.
      expect(secondStageInputSize).toBe(6);
      expect(merged).toHaveLength(6);
    });

    it("successful topK stage then failing last stage → returns prior topK-narrowed output", async () => {
      // Stage 0 succeeds and narrows to topK=2; stage 1 (last) fails. The pipeline
      // returns stage 0's filtered output unchanged.
      const firstStage = vi.fn(
        async (items: Array<{ id: string; score: number; content: string }>, _lambda: number) =>
          [...items].toSorted((a, b) => b.score - a.score),
      );
      const errorStage = vi.fn(async () => {
        throw new Error("last stage failed");
      });

      const vector = Array.from({ length: 6 }, (_, i) => ({
        id: `id-${i}`,
        path: `memory/${i}.md`,
        startLine: 1,
        endLine: 2,
        source: "memory" as const,
        snippet: `vec-${i}`,
        vectorScore: 1 - i * 0.1,
      }));

      const merged = await mergeHybridResults({
        vectorWeight: 1,
        textWeight: 0,
        vector,
        keyword: [],
        rerank: {
          enabled: true,
          stages: [{ adapter: firstStage, topK: 2 }, { adapter: errorStage }],
        },
      });

      expect(firstStage).toHaveBeenCalledTimes(1);
      expect(errorStage).toHaveBeenCalledTimes(1);
      // Stage 0 narrowed to 2; the failing last stage leaves that output intact.
      expect(merged).toHaveLength(2);
      expect(merged[0]?.path).toBe("memory/0.md");
      expect(merged[1]?.path).toBe("memory/1.md");
    });

    it("all stages fail with topK on first → returns full original input", async () => {
      // Every stage throws; the first declares topK. No stage succeeds, so no
      // narrowing is applied and the original score-ordered input passes through.
      const errorStageA = vi.fn(async () => {
        throw new Error("stage-0 failed");
      });
      const errorStageB = vi.fn(async () => {
        throw new Error("stage-1 failed");
      });

      const vector = Array.from({ length: 6 }, (_, i) => ({
        id: `id-${i}`,
        path: `memory/${i}.md`,
        startLine: 1,
        endLine: 2,
        source: "memory" as const,
        snippet: `vec-${i}`,
        vectorScore: 1 - i * 0.1,
      }));

      const merged = await mergeHybridResults({
        vectorWeight: 1,
        textWeight: 0,
        vector,
        keyword: [],
        rerank: {
          enabled: true,
          stages: [{ adapter: errorStageA, topK: 2 }, { adapter: errorStageB }],
        },
      });

      expect(errorStageA).toHaveBeenCalledTimes(1);
      expect(errorStageB).toHaveBeenCalledTimes(1);
      // No stage succeeded: full original input is returned, topK ignored.
      expect(merged).toHaveLength(6);
      expect(merged[0]?.path).toBe("memory/0.md");
      expect(merged[5]?.path).toBe("memory/5.md");
    });

    it("rerank disabled → stages skipped; score order preserved", async () => {
      const stage = vi.fn(
        async (items: Array<{ id: string; score: number; content: string }>, _lambda: number) =>
          [...items].toSorted((a, b) => a.score - b.score),
      );

      const merged = await mergeHybridResults({
        vectorWeight: 1,
        textWeight: 0,
        vector: [
          {
            id: "a",
            path: "memory/a.md",
            startLine: 1,
            endLine: 2,
            source: "memory",
            snippet: "vec-a",
            vectorScore: 0.9,
          },
          {
            id: "b",
            path: "memory/b.md",
            startLine: 3,
            endLine: 4,
            source: "memory",
            snippet: "vec-b",
            vectorScore: 0.8,
          },
        ],
        keyword: [],
        rerank: { enabled: false, stages: [{ adapter: stage }] },
      });

      expect(stage).not.toHaveBeenCalled();
      expect(merged[0]?.path).toBe("memory/a.md");
      expect(merged[1]?.path).toBe("memory/b.md");
    });
  });
});
