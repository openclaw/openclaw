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

  it("scores vector-only non-text media on its vector signal without text-weight discount", async () => {
    const imagePath = "memory/generated/images/photo.png";
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      isNonTextMediaPath: (path) => path === imagePath,
      vector: [
        {
          id: "image",
          path: imagePath,
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "Image file: generated/images/photo.png",
          vectorScore: 0.8,
        },
        {
          id: "text-no-keyword",
          path: "memory/notes.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "text-no-keyword",
          vectorScore: 0.8,
        },
      ],
      keyword: [
        {
          id: "text-keyword",
          path: "memory/topic.md",
          startLine: 3,
          endLine: 4,
          source: "memory",
          snippet: "text-keyword",
          textScore: 1,
        },
      ],
    });

    const image = merged.find((r) => r.path === imagePath);
    const textNoKeyword = merged.find((r) => r.path === "memory/notes.md");
    const textKeyword = merged.find((r) => r.path === "memory/topic.md");

    expect(image?.score).toBeCloseTo(0.8);
    expect(textNoKeyword?.score).toBeCloseTo(0.7 * 0.8);
    expect(textKeyword?.score).toBeCloseTo(0.3 * 1);
    expect(image?.score ?? 0).toBeGreaterThan(textNoKeyword?.score ?? 0);
  });

  it("leaves text-candidate scoring unchanged when a media predicate is supplied", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      isNonTextMediaPath: (path) => path.endsWith(".png"),
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

    expect(merged[0]?.score).toBeCloseTo(0.7 * 0.9 + 0.3 * 1);
  });

  it("preserves keyword-only media candidates instead of dropping them to zero", async () => {
    const mediaPath = "media/clip.wav";
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      isNonTextMediaPath: (path) => path.endsWith(".wav") || path.endsWith(".png"),
      vector: [],
      keyword: [
        {
          id: "media-kw-only",
          path: mediaPath,
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "Audio file: media/clip.wav",
          textScore: 0.9,
        },
      ],
    });

    const media = merged.find((r) => r.path === mediaPath);
    expect(media?.score).toBeCloseTo(0.3 * 0.9);
    expect(media?.score ?? 0).toBeGreaterThan(0);
  });

  it("keeps classified media scored under vectorWeight 0 when it has both vector and keyword results", async () => {
    const imagePath = "memory/generated/images/photo.png";
    const merged = await mergeHybridResults({
      vectorWeight: 0,
      textWeight: 1,
      isNonTextMediaPath: (path) => path === imagePath,
      vector: [
        {
          id: "image",
          path: imagePath,
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "Image file: generated/images/photo.png",
          vectorScore: 0.95,
        },
      ],
      keyword: [
        {
          id: "image",
          path: imagePath,
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "Image file: generated/images/photo.png",
          textScore: 0.8,
        },
      ],
    });

    const image = merged.find((r) => r.path === imagePath);
    expect(image?.score).toBeCloseTo(0.8);
    expect(image?.score ?? 0).toBeGreaterThan(0);
  });
});
