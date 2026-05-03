import { describe, expect, it } from "vitest";
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
          textScore: 1.0,
        },
      ],
    });

    expect(merged).toHaveLength(2);
    const a = merged.find((r) => r.path === "memory/a.md");
    const b = merged.find((r) => r.path === "memory/b.md");
    expect(a?.score).toBeCloseTo(0.7 * 0.9);
    expect(a?.vectorScore).toBeCloseTo(0.9);
    expect(a?.textScore).toBe(0);
    expect(b?.score).toBeCloseTo(0.3 * 1.0);
    expect(b?.vectorScore).toBe(0);
    expect(b?.textScore).toBeCloseTo(1.0);
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
          textScore: 1.0,
        },
      ],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.snippet).toBe("kw-a");
    expect(merged[0]?.score).toBeCloseTo(0.5 * 0.2 + 0.5 * 1.0);
    expect(merged[0]?.vectorScore).toBeCloseTo(0.2);
    expect(merged[0]?.textScore).toBeCloseTo(1.0);
  });

  it("mergeHybridResults supports rrf fusion ordering", async () => {
    const merged = await mergeHybridResults({
      fusion: "rrf",
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
          vectorScore: 0.2,
        },
        {
          id: "b",
          path: "memory/b.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-b",
          vectorScore: 0.9,
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
          textScore: 0.1,
        },
      ],
    });

    expect(merged).toHaveLength(2);
    // "a" appears in both ranked lists, so it wins in RRF.
    expect(merged[0]?.path).toBe("memory/a.md");
    expect(merged[1]?.path).toBe("memory/b.md");
    const k = 60;
    const vw = 0.7;
    const tw = 0.3;
    expect(merged[0]?.score).toBeCloseTo(1, 6);
    expect(merged[0]?.score).toBeLessThanOrEqual(1);
    expect(merged[1]?.score).toBeCloseTo((vw / (k + 2)) * ((k + 1) / (vw + tw)), 6);
  });

  it("mergeHybridResults uses deterministic tie-breaking", async () => {
    const merged = await mergeHybridResults({
      fusion: "rrf",
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        {
          id: "a",
          path: "memory/z.md",
          startLine: 10,
          endLine: 20,
          source: "memory",
          snippet: "z",
          vectorScore: 1,
        },
      ],
      keyword: [
        {
          id: "b",
          path: "memory/a.md",
          startLine: 10,
          endLine: 20,
          source: "memory",
          snippet: "a",
          textScore: 1,
        },
      ],
      temporalDecay: { enabled: false },
      mmr: { enabled: false },
    });

    expect(merged).toHaveLength(2);
    // Equal score; path lexical tie-break applies.
    expect(merged[0]?.path).toBe("memory/a.md");
    expect(merged[1]?.path).toBe("memory/z.md");
  });
});
