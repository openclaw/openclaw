// Memory Core tests cover MMR behavior through the production result adapter.
import { describe, expect, it } from "vitest";
import { mergeHybridResults } from "./hybrid.js";
import { applyMMRToHybridResults } from "./mmr.js";
import { prepareSimilarityText, preparedTextSimilarity } from "./tokenize.js";

describe("memory MMR", () => {
  it.each([{ text: "中文🙂今天", expected: ["中文", "今天", "中", "文", "今", "天"] }])(
    "tokenizes $text in stable term order",
    ({ text, expected }) => {
      expect([...prepareSimilarityText(text).tokens]).toEqual(expected);
    },
  );

  it("compares token sets and falls back to literal equality for empty token sets", () => {
    const similarity = (a: string, b: string) =>
      preparedTextSimilarity(prepareSimilarityText(a), prepareSimilarityText(b));
    expect(similarity("a b", "b c")).toBeCloseTo(1 / 3);
    expect(similarity("Привет мир", "Доброе утро")).toBe(0);
    expect(similarity("🦞🦞", "🦞🦞")).toBe(1);
  });

  it.each([
    {
      name: "diversifies NFC-equivalent kana",
      results: [
        ["/primary.md", 1, "が"],
        ["/duplicate.md", 0.98, "\u304b\u3099"],
        ["/diverse.md", 0.94, "な"],
        ["/tail.md", 0.4, "garden compost schedule"],
      ],
      expected: ["/primary.md", "/diverse.md", "/duplicate.md", "/tail.md"],
    },
    {
      name: "keeps input order as the tie breaker for equal relevance and diversity",
      results: [
        ["/first.md", 1, "alpha"],
        ["/second.md", 1, "beta"],
        ["/third.md", 1, "gamma"],
      ],
      expected: ["/first.md", "/second.md", "/third.md"],
    },
  ])("$name", ({ results, expected }) => {
    const candidates = results.map(([path, score, snippet]) => ({
      path: String(path),
      startLine: 1,
      endLine: 1,
      score: Number(score),
      snippet: String(snippet),
    }));
    const scores = new Map(candidates.map((result) => [result.path, result.score]));

    const reranked = applyMMRToHybridResults(candidates, 0.7);

    expect(reranked.map((result) => result.path)).toEqual(expected);
    expect(reranked.map((result) => result.score)).toEqual(
      expected.map((path) => scores.get(path)),
    );
    for (const result of reranked) {
      expect(result).toBe(candidates.find((candidate) => candidate.path === result.path));
    }
  });

  it.each([["server Москва резервная копия", "server Берлин погода сегодня"]])(
    "retains distinct mixed-script memories sharing an ASCII term: %s",
    (primary, distinct) => {
      const results = [
        { path: "/primary.md", startLine: 1, score: 1, snippet: primary },
        { path: "/distinct.md", startLine: 1, score: 0.98, snippet: distinct },
        { path: "/weak.md", startLine: 1, score: 0.9, snippet: "database connection pool" },
        { path: "/tail.md", startLine: 1, score: 0.1, snippet: "garden compost schedule" },
      ];

      expect(applyMMRToHybridResults(results, 0.7).map((entry) => entry.path)).toEqual([
        "/primary.md",
        "/distinct.md",
        "/weak.md",
        "/tail.md",
      ]);
    },
  );

  it.each([{ mmr: { enabled: true, lambda: 0.7 }, paths: ["/a", "/c", "/b", "/d"] }])(
    "applies configured hybrid MMR for $mmr",
    async ({ mmr, paths }) => {
      const results = [
        { path: "/a", startLine: 1, endLine: 1, score: 1, snippet: "same", source: "memory" },
        { path: "/b", startLine: 1, endLine: 1, score: 0.9, snippet: "same", source: "memory" },
        {
          path: "/c",
          startLine: 1,
          endLine: 1,
          score: 0.85,
          snippet: "different",
          source: "memory",
        },
        { path: "/d", startLine: 1, endLine: 1, score: 0.1, snippet: "tail", source: "memory" },
      ];

      const merged = await mergeHybridResults({
        vector: results.map((result) => ({
          ...result,
          id: result.path,
          vectorScore: result.score,
        })),
        keyword: [],
        vectorWeight: 1,
        textWeight: 0,
        mmr,
        temporalDecay: { enabled: false, halfLifeDays: 30 },
      });
      expect(merged).toEqual(
        paths.map((path) =>
          expect.objectContaining(results.find((result) => result.path === path)!),
        ),
      );
    },
  );
});
