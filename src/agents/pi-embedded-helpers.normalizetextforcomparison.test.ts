import { describe, expect, it } from "vitest";
import { normalizeTextForComparison } from "./pi-embedded-helpers.js";

describe("normalizeTextForComparison", () => {
  it("lowercases text", () => {
    expect(normalizeTextForComparison("Hello World")).toBe("hello world");
  });
  it("trims whitespace", () => {
    expect(normalizeTextForComparison("  hello  ")).toBe("hello");
  });
  it("collapses multiple spaces", () => {
    expect(normalizeTextForComparison("hello    world")).toBe("hello world");
  });
  it("strips emoji", () => {
    expect(normalizeTextForComparison("Hello 👋 World 🌍")).toBe("hello world");
  });
  it("handles mixed normalization", () => {
    expect(normalizeTextForComparison("  Hello 👋   WORLD  🌍  ")).toBe("hello world");
  });
});
