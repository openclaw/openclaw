import { describe, expect, it } from "vitest";
import { stripUnpairedSurrogates } from "./manager-embedding-ops.js";

describe("stripUnpairedSurrogates", () => {
  it("preserves text without surrogates", () => {
    expect(stripUnpairedSurrogates("hello world")).toBe("hello world");
  });

  it("preserves valid surrogate pairs (emoji, CJK Extension B)", () => {
    expect(stripUnpairedSurrogates("hi 🌸")).toBe("hi 🌸");
    expect(stripUnpairedSurrogates("\u{20000}")).toBe("\u{20000}");
  });

  it("replaces a lone high surrogate with U+FFFD", () => {
    // High surrogate of 🌸 (U+1F338) without its low partner.
    expect(stripUnpairedSurrogates("hi \uD83C")).toBe("hi \uFFFD");
  });

  it("replaces a lone low surrogate with U+FFFD", () => {
    // Low surrogate of 🌸 without its high partner.
    expect(stripUnpairedSurrogates("\uDF38 hi")).toBe("\uFFFD hi");
  });

  it("replaces both halves when a pair is reversed (low then high)", () => {
    expect(stripUnpairedSurrogates("\uDF38\uD83C")).toBe("\uFFFD\uFFFD");
  });

  it("handles empty / non-string inputs gracefully", () => {
    expect(stripUnpairedSurrogates("")).toBe("");
    // Non-string inputs return as-is — the embed call paths only pass strings,
    // but the helper guards against accidental misuse.
    expect(stripUnpairedSurrogates(undefined as unknown as string)).toBe(
      undefined as unknown as string,
    );
  });
});
