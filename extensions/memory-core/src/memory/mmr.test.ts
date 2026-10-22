import { describe, expect, it } from "vitest";
import { mergeHybridResults } from "./hybrid.js";
import { applyMMRToHybridResults } from "./mmr.js";
import { prepareSimilarityText, preparedTextSimilarity } from "./tokenize.js";

function candidates(rows: [string, number, string][]) {
  return rows.map(([path, score, snippet]) => ({
    path,
    score,
    snippet,
    startLine: 1,
    endLine: 1,
    source: "memory",
  }));
}

describe("memory MMR", () => {
  it("tokenizes CJK in stable term order", () => {
    expect([...prepareSimilarityText("中文🙂今天").tokens]).toEqual([
      "中文",
      "今天",
      "中",
      "文",
      "今",
      "天",
    ]);
  });

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
  ] satisfies { name: string; results: [string, number, string][]; expected: string[] }[])(
    "$name",
    ({ results, expected }) => {
      const input = candidates(results);
      const reranked = applyMMRToHybridResults(input, 0.7);
      expect(reranked.map((result) => result.path)).toEqual(expected);
      for (const result of reranked) {
        expect(result).toBe(input.find((candidate) => candidate.path === result.path));
        expect(result.score).toBe(results.find(([path]) => path === result.path)![1]);
      }
    },
  );

  it("retains distinct mixed-script memories sharing an ASCII term", () => {
    const results = candidates([
      ["/primary.md", 1, "server Москва резервная копия"],
      ["/distinct.md", 0.98, "server Берлин погода сегодня"],
      ["/weak.md", 0.9, "database connection pool"],
      ["/tail.md", 0.1, "garden compost schedule"],
    ]);

    expect(applyMMRToHybridResults(results, 0.7).map((entry) => entry.path)).toEqual([
      "/primary.md",
      "/distinct.md",
      "/weak.md",
      "/tail.md",
    ]);
  });

  it("applies configured hybrid MMR", async () => {
    const results = candidates([
      ["/a", 1, "same"],
      ["/b", 0.9, "same"],
      ["/c", 0.85, "different"],
      ["/d", 0.1, "tail"],
    ]);
    const merged = await mergeHybridResults({
      vector: results.map((result) => ({
        ...result,
        id: result.path,
        vectorScore: result.score,
      })),
      keyword: [],
      vectorWeight: 1,
      textWeight: 0,
      mmr: { enabled: true, lambda: 0.7 },
      temporalDecay: { enabled: false, halfLifeDays: 30 },
    });
    expect(merged).toEqual(
      ["/a", "/c", "/b", "/d"].map((path) =>
        expect.objectContaining(results.find((result) => result.path === path)!),
      ),
    );
  });
});
