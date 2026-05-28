import { describe, expect, it } from "vitest";
import { normalizePositiveLimit } from "./limits.js";

describe("session tool limits", () => {
  it.each([
    [undefined, 500],
    [Number.NaN, 500],
    [Number.POSITIVE_INFINITY, 500],
    [0, 1],
    [-12, 1],
    [2.9, 2],
    [7, 7],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizePositiveLimit(input, 500)).toBe(expected);
  });
});
