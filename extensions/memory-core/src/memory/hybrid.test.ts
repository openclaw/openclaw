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

    it("provider present → reranker function called; result order matches mock return", async () => {
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
        mmr: { enabled: true, lambda: 0.7, provider: "memory-mmr", fallback: "none" },
        reranker: mockReranker,
      });

      expect(mockReranker).toHaveBeenCalledTimes(1);
      expect(merged).toHaveLength(2);
      // Mock returns sorted by score, so a (0.9) comes before b (0.8)
      expect(merged[0]?.path).toBe("memory/a.md");
      expect(merged[1]?.path).toBe("memory/b.md");
    });

    it('provider "none" → reranker function not called; score order preserved', async () => {
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
        mmr: { enabled: true, lambda: 0.7, provider: "none", fallback: "none" },
        // No reranker adapter passed: simulates manager resolving provider "none" to undefined
      });

      expect(mockReranker).not.toHaveBeenCalled();
      expect(merged).toHaveLength(2);
      // Score order preserved (0.9 > 0.8)
      expect(merged[0]?.path).toBe("memory/a.md");
      expect(merged[1]?.path).toBe("memory/b.md");
    });

    it("reranker throws + fallbackReranker → fallback called; primary error swallowed", async () => {
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
        mmr: { enabled: true, lambda: 0.7, provider: "memory-mmr", fallback: "none" },
        reranker: errorReranker,
        fallbackReranker,
      });

      expect(errorReranker).toHaveBeenCalledTimes(1);
      expect(fallbackReranker).toHaveBeenCalledTimes(1);
      expect(merged).toHaveLength(1);
      expect(merged[0]?.path).toBe("memory/a.md");
    });

    it("primary provider absent + fallbackReranker → fallback called; score order from fallback", async () => {
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
        mmr: { enabled: true, lambda: 0.7, provider: "memory-mmr", fallback: "memory-mmr" },
        // No primary reranker adapter: simulates primary provider not registered
        fallbackReranker,
      });

      expect(mockReranker).not.toHaveBeenCalled();
      expect(fallbackReranker).toHaveBeenCalledTimes(1);
      expect(merged).toHaveLength(2);
      expect(merged[0]?.path).toBe("memory/a.md");
      expect(merged[1]?.path).toBe("memory/b.md");
    });

    it("reranker throws + no fallback → fail-open; returns score-ordered results (no throw)", async () => {
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
        mmr: { enabled: true, lambda: 0.7, provider: "memory-mmr", fallback: "none" },
        reranker: errorReranker,
      });

      expect(errorReranker).toHaveBeenCalledTimes(1);
      // Fail-open: returns score-ordered results
      expect(merged).toHaveLength(2);
      expect(merged[0]?.path).toBe("memory/a.md");
      expect(merged[1]?.path).toBe("memory/b.md");
    });
  });
});
