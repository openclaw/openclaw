import { expect, it } from "vitest";
import { chunkText, chunkTextRanges } from "./chunk-text.js";

it("keeps grapheme boundaries and progress for fractional and NaN limits in each mode", () => {
  const common = [
    { text: "aaaaaaaaaa👨‍👩‍👧‍👦Z", limit: 12, expected: ["aaaaaaaaaa", "👨‍👩‍👧‍👦Z"] },
    { text: "👨‍👩‍👧‍👦", limit: 4, expected: ["👨‍", "👩‍", "👧‍", "👦"] },
    { text: "abc", limit: 0.5, expected: ["a", "b", "c"] },
    { text: "😀😀", limit: 0.5, expected: ["😀", "😀"] },
    { text: "abc", limit: Number.NaN, expected: ["abc"] },
  ];
  for (const mode of ["plain", "hard", "preferred"] as const) {
    const whitespace =
      mode === "hard"
        ? []
        : [
            { text: "\u0600 \u0301abcd", limit: 4, expected: ["\u0600 \u0301a", "bcd"] },
            ...(mode === "preferred"
              ? [{ text: "ab \u0301cd", limit: 4, expected: ["ab", " \u0301cd"] }]
              : [
                  { text: "ab \u0301cd", limit: 2, expected: ["ab", " \u0301", "cd"] },
                  { text: "ab  \u0301cd", limit: 2, expected: ["ab", " \u0301", "cd"] },
                ]),
          ];
    for (const { text, limit, expected } of [...common, ...whitespace]) {
      const chunks =
        mode === "plain"
          ? chunkText(text, limit)
          : chunkTextRanges(text, { limit, mode }).map(({ start, end }) => text.slice(start, end));
      expect(chunks, `${mode}: ${text}`).toEqual(expected);
    }
  }
});
