import { describe, test, expect } from "vitest";
import { clusterBySimilarity, cosineSimilarity } from "./consolidate.js";

describe("cosineSimilarity", () => {
  test("identical vectors should return 1", () => {
    const v = [1, 0, 0, 1];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  test("opposite vectors should return -1", () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  test("orthogonal vectors should return 0", () => {
    const a = [1, 0];
    const b = [0, 1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0);
  });

  test("similar vectors should return high score", () => {
    const a = [1, 0.9, 0.1];
    const b = [0.95, 0.85, 0.15];
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
  });

  test("different length vectors should return 0", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  test("zero vectors should return 0", () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});

describe("clusterBySimilarity", () => {
  test("should cluster identical vectors", () => {
    const items = [
      { id: "a", text: "coffee", vector: [1, 0, 0] },
      { id: "b", text: "coffee too", vector: [1, 0, 0] },
      { id: "c", text: "tea", vector: [0, 1, 0] },
    ];

    const clusters = clusterBySimilarity(items, 0.9);
    expect(clusters.length).toBe(1);
    expect(clusters[0].length).toBe(2);
    expect(clusters[0].map((c) => c.id)).toContain("a");
    expect(clusters[0].map((c) => c.id)).toContain("b");
  });

  test("should not cluster dissimilar vectors", () => {
    const items = [
      { id: "a", text: "coffee", vector: [1, 0, 0] },
      { id: "b", text: "tea", vector: [0, 1, 0] },
      { id: "c", text: "code", vector: [0, 0, 1] },
    ];

    const clusters = clusterBySimilarity(items, 0.9);
    expect(clusters.length).toBe(0);
  });

  test("should handle single item", () => {
    const items = [{ id: "a", text: "alone", vector: [1, 0] }];
    const clusters = clusterBySimilarity(items, 0.9);
    expect(clusters.length).toBe(0);
  });

  test("should handle empty array", () => {
    const clusters = clusterBySimilarity([], 0.9);
    expect(clusters.length).toBe(0);
  });

  test("should form multiple clusters", () => {
    const items = [
      { id: "a1", text: "coffee1", vector: [1, 0, 0] },
      { id: "a2", text: "coffee2", vector: [0.99, 0.01, 0] },
      { id: "b1", text: "tea1", vector: [0, 1, 0] },
      { id: "b2", text: "tea2", vector: [0.01, 0.99, 0] },
    ];

    const clusters = clusterBySimilarity(items, 0.9);
    expect(clusters.length).toBe(2);
  });

  test("each item should only appear in one cluster", () => {
    const items = [
      { id: "a", text: "x", vector: [1, 0] },
      { id: "b", text: "y", vector: [0.95, 0.05] },
      { id: "c", text: "z", vector: [0.9, 0.1] },
    ];

    const clusters = clusterBySimilarity(items, 0.8);
    const allIds = clusters.flat().map((c) => c.id);
    const unique = new Set(allIds);
    expect(unique.size).toBe(allIds.length);
  });
});
