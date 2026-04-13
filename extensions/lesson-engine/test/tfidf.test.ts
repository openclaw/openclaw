import { describe, expect, test } from "vitest";
import { cosine, documentFrequency, termFrequency, tfidfVector, tokenize } from "../src/tfidf.js";

describe("tfidf helpers", () => {
  test("tokenize returns an empty array for empty input", () => {
    expect(tokenize("")).toEqual([]);
  });

  test("tokenize adds CJK bigrams for contiguous CJK tokens", () => {
    const tokens = tokenize("中文测试");
    expect(tokens).toContain("中文测试");
    expect(tokens).toContain("中文");
    expect(tokens).toContain("文测");
    expect(tokens).toContain("测试");
  });

  test("termFrequency and tfidfVector keep positive weights only", () => {
    const tf = termFrequency(["alpha", "alpha", "beta"]);
    expect(tf.get("alpha")).toBe(2);
    const df = documentFrequency([["alpha", "beta"], ["alpha"]]);
    const vec = tfidfVector(["alpha", "beta"], df, 2);
    expect(vec.get("beta")).toBeGreaterThan(0);
  });

  test("cosine returns 0 when either vector has zero magnitude", () => {
    expect(cosine(new Map(), new Map([["x", 1]]))).toBe(0);
  });
});
