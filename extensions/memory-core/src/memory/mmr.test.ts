import { expect, it } from "vitest";
import { applyMMRToHybridResults } from "./mmr.js";
import { prepareSimilarityText, preparedTextSimilarity } from "./tokenize.js";

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
    rows: [
      [1, "が"],
      [0.98, "\u304b\u3099"],
      [0.94, "な"],
      [0.4, "garden compost schedule"],
    ],
    order: [0, 2, 1, 3],
  },
  {
    name: "keeps input order for equal relevance and diversity",
    rows: [
      [1, "alpha"],
      [1, "beta"],
      [1, "gamma"],
    ],
    order: [0, 1, 2],
  },
  {
    name: "retains mixed-script memories sharing an ASCII term",
    rows: [
      [1, "server Москва резервная копия"],
      [0.98, "server Берлин погода сегодня"],
      [0.9, "database connection pool"],
      [0.1, "garden compost schedule"],
    ],
    order: [0, 1, 2, 3],
  },
] satisfies { name: string; rows: [number, string][]; order: number[] }[])(
  "$name",
  ({ rows, order }) => {
    const input = rows.map(([score, snippet], index) => ({ path: String(index), score, snippet }));
    const result = applyMMRToHybridResults(input, 0.7);
    expect(result.map((item) => item.path)).toEqual(order.map(String));
    expect(result.map((item) => item.score)).toEqual(order.map((index) => rows[index]![0]));
    result.forEach((item, index) => expect(item).toBe(input[order[index]!]));
  },
);
