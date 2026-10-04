// Memory Core tests cover MMR behavior through the production result adapter.
import { describe, expect, it } from "vitest";
import { mergeHybridResults } from "./hybrid.js";
import { applyMMRToHybridResults } from "./mmr.js";
import { prepareSimilarityText, preparedTextSimilarity } from "./tokenize.js";

describe("memory MMR", () => {
  it.each([
    {
      text: "Hello 今天讨论 hello",
      expected: ["hello", "今天", "天讨", "讨论", "今", "天", "讨", "论"],
    },
    { text: " Hello WORLD_42 hello! ", expected: ["hello", "world_42"] },
    { text: "Привет 🙂 العربية", expected: ["привет", "العربية"] },
    { text: "CAFÉ cafe\u0301", expected: ["café"] },
    { text: "server Москва резервная копия", expected: ["server", "москва", "резервная", "копия"] },
    { text: "दिल्ली संग्रहित प्रतियां", expected: ["दिल्ली", "संग्रहित", "प्रतियां"] },
    { text: "กรุงเทพ สำรอง ข้อมูล", expected: ["กรุงเทพ", "สำรอง", "ข้อมูล"] },
    { text: "Café中文العربية", expected: ["café", "العربية", "中文", "中", "文"] },
    { text: "🙂\uFE0F \u0301 !!!", expected: [] },
    { text: "中文🙂今天", expected: ["中文", "今天", "中", "文", "今", "天"] },
  ])("tokenizes $text in stable term order", ({ text, expected }) => {
    expect([...prepareSimilarityText(text).tokens]).toEqual(expected);
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
      name: "demotes a near duplicate below a relevant diverse result",
      results: [
        ["/primary.md", 1, "omada router vlan ten iot devices configured"],
        ["/duplicate.md", 0.98, "omada router vlan ten iot devices configuration"],
        ["/diverse.md", 0.94, "adguard dns resolver address local network"],
        ["/tail.md", 0.4, "garden compost schedule"],
      ],
      expected: ["/primary.md", "/diverse.md", "/duplicate.md", "/tail.md"],
    },
    {
      name: "preserves relevance for distinct scripts",
      results: [
        ["/arabic.md", 1, "إعداد الشبكة الرئيسي"],
        ["/cyrillic.md", 0.98, "резервная конфигурация сети"],
        ["/ascii.md", 0.9, "database connection pool"],
        ["/tail.md", 0.1, "garden compost schedule"],
      ],
      expected: ["/arabic.md", "/cyrillic.md", "/ascii.md", "/tail.md"],
    },
    {
      name: "diversifies normalized-equal Cyrillic snippets",
      results: [
        ["/primary.md", 1, "Привет мир"],
        ["/duplicate.md", 0.98, "  ПРИВЕТ МИР  "],
        ["/diverse.md", 0.94, "Доброе утро"],
        ["/tail.md", 0.4, "إعداد الشبكة الرئيسي"],
      ],
      expected: ["/primary.md", "/diverse.md", "/duplicate.md", "/tail.md"],
    },
    {
      name: "diversifies NFC-equivalent Hangul",
      results: [
        ["/primary.md", 1, "각"],
        ["/duplicate.md", 0.98, "\u1100\u1161\u11a8"],
        ["/diverse.md", 0.94, "나"],
        ["/tail.md", 0.4, "garden compost schedule"],
      ],
      expected: ["/primary.md", "/diverse.md", "/duplicate.md", "/tail.md"],
    },
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

  it.each([
    ["server Москва резервная копия", "server Берлин погода сегодня"],
    ["server القاهرة نسخة احتياطية", "server برلين توقعات الطقس"],
    ["server दिल्ली संग्रहित प्रतियां", "server मुंबई मौसम आज"],
  ])("retains distinct mixed-script memories sharing an ASCII term: %s", (primary, distinct) => {
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
  });

  it.each([
    { mmr: undefined, paths: ["/a", "/b", "/c", "/d"] },
    { mmr: { enabled: false }, paths: ["/a", "/b", "/c", "/d"] },
    { mmr: { enabled: true }, paths: ["/a", "/c", "/b", "/d"] },
  ])("applies hybrid MMR defaults for $mmr", async ({ mmr, paths }) => {
    const results = [
      { path: "/a", startLine: 1, endLine: 1, score: 1, snippet: "same", source: "memory" },
      { path: "/b", startLine: 1, endLine: 1, score: 0.9, snippet: "same", source: "memory" },
      { path: "/c", startLine: 1, endLine: 1, score: 0.85, snippet: "different", source: "memory" },
      { path: "/d", startLine: 1, endLine: 1, score: 0.1, snippet: "tail", source: "memory" },
    ];

    const merged = await mergeHybridResults({
      vector: results.map((result) => ({ ...result, id: result.path, vectorScore: result.score })),
      keyword: [],
      vectorWeight: 1,
      textWeight: 0,
      mmr,
    });
    expect(merged).toEqual(
      paths.map((path) => expect.objectContaining(results.find((result) => result.path === path)!)),
    );
  });

  it("preserves repeated result objects and locations without mutating inputs", () => {
    const primary = Object.freeze({ path: "/same.md", startLine: 1, score: 1, snippet: "alpha" });
    const duplicate = Object.freeze({ ...primary, score: 0.98 });
    const diverse = Object.freeze({ ...primary, score: 0.94, snippet: "beta" });
    const tail = Object.freeze({ ...primary, score: 0.4, snippet: "gamma" });
    const results = [primary, duplicate, diverse, primary, tail];
    Object.freeze(results);

    const reranked = applyMMRToHybridResults(results, 0.7);

    expect(reranked).toHaveLength(results.length);
    for (const [index, expected] of [primary, diverse, primary, duplicate, tail].entries()) {
      expect(reranked[index]).toBe(expected);
    }
  });

  it("preserves the reference MMR ranking while caching running similarities", () => {
    // Reference implementation: recomputes max-similarity-to-selected from
    // scratch on every selection round (the pre-optimization behavior). The
    // production path must produce an identical ranking.
    type Ref = { id: string; score: number; content: string };
    const referenceMmrRerank = (items: Ref[], lambda: number): Ref[] => {
      const tokenCache = new Map(
        items.map((item) => [item.id, prepareSimilarityText(item.content)]),
      );
      const maxScore = Math.max(...items.map((item) => item.score));
      const minScore = Math.min(...items.map((item) => item.score));
      const scoreRange = maxScore - minScore;
      const selected: Ref[] = [];
      const remaining = new Set(items);

      while (remaining.size > 0) {
        let bestItem: Ref | null = null;
        let bestScore = -Infinity;
        for (const candidate of remaining) {
          let maxSimilarity = 0;
          for (const selectedItem of selected) {
            maxSimilarity = Math.max(
              maxSimilarity,
              preparedTextSimilarity(
                tokenCache.get(candidate.id)!,
                tokenCache.get(selectedItem.id)!,
              ),
            );
          }
          const normalizedScore = scoreRange === 0 ? 1 : (candidate.score - minScore) / scoreRange;
          const score = lambda * normalizedScore - (1 - lambda) * maxSimilarity;
          if (
            score > bestScore ||
            (score === bestScore && candidate.score > (bestItem?.score ?? -Infinity))
          ) {
            bestItem = candidate;
            bestScore = score;
          }
        }
        if (!bestItem) {
          break;
        }
        selected.push(bestItem);
        remaining.delete(bestItem);
      }
      return selected;
    };

    const results = Array.from({ length: 24 }, (_, index) => ({
      path: `/doc-${index}.md`,
      startLine: index,
      endLine: index,
      score: 1 - index / 100,
      snippet: [
        `shared topic ${index % 5}`,
        index % 2 === 0 ? "alpha beta gamma" : "delta epsilon zeta",
        `distinct-${index}`,
      ].join(" "),
      source: "memory",
    }));

    for (const lambda of [0, 0.3, 0.5, 0.7, 0.95]) {
      const refItems: Ref[] = results.map((r) => ({
        id: r.path,
        score: r.score,
        content: r.snippet,
      }));
      const expected = referenceMmrRerank(refItems, lambda).map((item) => item.id);
      const actual = applyMMRToHybridResults(results, lambda).map((r) => r.path);
      expect(actual, `lambda=${lambda}`).toEqual(expected);
    }
  });
});
