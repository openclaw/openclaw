// Memory Core tests cover hybrid plugin behavior.
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

  it("keeps exact path identifiers ahead of weighted semantic matches", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [
        {
          id: "semantic",
          path: "memory/semantic.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "semantic",
          vectorScore: 0.99,
        },
      ],
      keyword: [
        {
          id: "exact-path",
          path: "memory/project-lantern.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "path",
          textScore: 0.01,
          exactPathSpecificity: 1,
        },
      ],
    });

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/project-lantern.md",
      "memory/semantic.md",
    ]);
    expect(merged[0]?.score).toBe(1);
    expect(merged[0]?.textScore).toBe(0.01);
    expect(merged[1]?.score).toBeCloseTo(0.7 * 0.99);
  });

  it("uses specificity across exact tiers and combined relevance within one tier", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        {
          id: "full",
          path: "memory/full.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "full",
          vectorScore: 0,
        },
        {
          id: "basename-weak",
          path: "memory/a/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "basename weak",
          vectorScore: 0.2,
        },
        {
          id: "basename-strong",
          path: "memory/z/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "basename strong",
          vectorScore: 0.9,
        },
        {
          id: "stem",
          path: "memory/foo.md.bak",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "stem",
          vectorScore: 1,
        },
      ],
      keyword: [
        {
          id: "full",
          path: "memory/full.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "full",
          textScore: 0,
          exactPathSpecificity: 3,
        },
        {
          id: "basename-weak",
          path: "memory/a/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "basename weak",
          textScore: 0.1,
          exactPathSpecificity: 2,
        },
        {
          id: "basename-strong",
          path: "memory/z/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "basename strong",
          textScore: 0.8,
          exactPathSpecificity: 2,
        },
        {
          id: "stem",
          path: "memory/foo.md.bak",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "stem",
          textScore: 1,
          exactPathSpecificity: 1,
        },
      ],
    });

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/full.md",
      "memory/z/foo.md",
      "memory/a/foo.md",
      "memory/foo.md.bak",
    ]);
    expect(merged.map((entry) => entry.score)).toEqual([1, 1, 1, 1]);
  });

  it("keeps exact path identifiers ahead after decay, oversized weights, and MMR", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 1,
      nowMs: Date.UTC(2026, 6, 11),
      temporalDecay: { enabled: true, halfLifeDays: 1 },
      mmr: { enabled: true, lambda: 0.5 },
      vector: [
        {
          id: "semantic",
          path: "memory/semantic.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "semantic neighbor",
          vectorScore: 1,
        },
      ],
      keyword: [
        {
          id: "semantic",
          path: "memory/semantic.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "semantic neighbor",
          textScore: 1,
        },
        {
          id: "exact-path",
          path: "memory/2020-01-01.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "dated exact path",
          textScore: 0.01,
          exactPathSpecificity: 1,
        },
      ],
    });

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/2020-01-01.md",
      "memory/semantic.md",
    ]);
    expect(merged[0]?.score).toBe(1);
    expect(merged[1]?.score).toBe(2);
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
});
