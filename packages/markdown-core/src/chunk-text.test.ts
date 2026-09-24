// Markdown Core tests cover plain-text chunking behavior.
import { describe, expect, it } from "vitest";
import { chunkText, chunkTextRanges } from "./chunk-text.js";

describe("chunkText", () => {
  it("normalizes positive fractional limits without emitting empty chunks", () => {
    expect(chunkText("abc", 0.5)).toEqual(["a", "b", "c"]);
    expect(chunkText("😀😀", 0.5)).toEqual(["😀", "😀"]);
  });
});

describe("grapheme boundaries", () => {
  it.each(["plain", "hard", "preferred"] as const)("keeps clusters whole in %s chunks", (mode) => {
    const text = "aaaaaaaaaa👨‍👩‍👧‍👦Z";
    const chunks =
      mode === "plain"
        ? chunkText(text, 12)
        : chunkTextRanges(text, { limit: 12, mode }).map(({ start, end }) =>
            text.slice(start, end),
          );
    expect(chunks).toEqual(["aaaaaaaaaa", "👨‍👩‍👧‍👦Z"]);
  });

  it.each([
    { text: "ab \u0301cd", expected: ["ab", " \u0301cd"] },
    { text: "\u0600 \u0301abcd", expected: ["\u0600 \u0301a", "bcd"] },
  ])("keeps preferred whitespace boundaries outside clusters: $text", ({ text, expected }) => {
    const ranges = chunkTextRanges(text, { limit: 4, mode: "preferred" });
    expect(ranges.map(({ start, end }) => text.slice(start, end))).toEqual(expected);
  });

  it.each([
    { text: "\u0600 \u0301abcd", limit: 4, expected: ["\u0600 \u0301a", "bcd"] },
    { text: "ab \u0301cd", limit: 2, expected: ["ab", " \u0301", "cd"] },
    { text: "ab  \u0301cd", limit: 2, expected: ["ab", " \u0301", "cd"] },
  ])("keeps plain-text whitespace clusters intact: $text", ({ text, limit, expected }) => {
    expect(chunkText(text, limit)).toEqual(expected);
  });

  it.each(["plain", "hard", "preferred"] as const)(
    "makes surrogate-safe progress through oversized clusters in %s chunks",
    (mode) => {
      const text = "👨‍👩‍👧‍👦";
      const chunks =
        mode === "plain"
          ? chunkText(text, 4)
          : chunkTextRanges(text, { limit: 4, mode }).map(({ start, end }) =>
              text.slice(start, end),
            );
      expect(chunks).toEqual(["👨‍", "👩‍", "👧‍", "👦"]);
    },
  );
});
