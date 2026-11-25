import { describe, expect, it } from "vitest";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";

describe("sanitizeAndNormalizeEmbedding", () => {
  it.each([
    { name: "unit length", input: [3, 4], expected: [0.6, 0.8] },
    {
      name: "nonfinite coordinates and signed zero",
      input: [Number.NaN, Infinity, -Infinity, 3, -4, -0],
      expected: [0, 0, 0, 0.6, -0.8, -0],
    },
    { name: "empty vector", input: [], expected: [] },
    { name: "zero magnitude", input: [0, -0], expected: [0, -0] },
    { name: "tiny magnitude", input: [3e-11, 4e-11], expected: [3e-11, 4e-11] },
    { name: "normalization threshold", input: [1e-10], expected: [1] },
    {
      name: "overflowed squared magnitude",
      input: [Number.MAX_VALUE, -Number.MAX_VALUE, -0],
      expected: [0, -0, -0],
    },
  ])("returns a fresh $name vector without changing the input", ({ input, expected }) => {
    const before = input.slice();
    const result = sanitizeAndNormalizeEmbedding(input);

    expect(result).toStrictEqual(expected);
    expect(result).not.toBe(input);
    expect(input).toStrictEqual(before);
  });

  it("preserves sparse coordinates without filling holes or changing the input", () => {
    const input: number[] = [];
    input[1] = 3;
    input[3] = 4;
    const before = input.slice();

    const result = sanitizeAndNormalizeEmbedding(input);

    expect(result).toHaveLength(4);
    expect(Object.keys(result)).toEqual(["1", "3"]);
    expect(result[1]).toBe(0.6);
    expect(result[3]).toBe(0.8);
    expect(result).not.toBe(input);
    expect(input).toStrictEqual(before);
  });
});
