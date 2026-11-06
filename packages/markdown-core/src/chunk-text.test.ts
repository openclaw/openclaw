import { expect, it } from "vitest";
import { chunkText, chunkTextRanges } from "./chunk-text.js";

it("normalizes positive fractional limits without emitting empty chunks", () => {
  expect(chunkText("abc", 0.5)).toEqual(["a", "b", "c"]);
  expect(chunkText("😀😀", 0.5)).toEqual(["😀", "😀"]);
});

it("preserves nonempty text when the limit is NaN instead of dropping it", () => {
  const text = "Hello from OpenClaw — this outbound message must never vanish.";
  // chunkText: NaN must return the full text as one chunk, not [""].
  expect(chunkText(text, NaN)).toEqual([text]);
  expect(chunkText("", NaN)).toEqual([]);
  // chunkTextRanges: NaN must return a single range covering the full text,
  // not [{ start: 0, end: NaN }] which slices to an empty string.
  expect(chunkTextRanges(text, { limit: NaN })).toEqual([{ start: 0, end: text.length }]);
  // A recalled nonempty chunk must not be empty when sliced back out.
  expect(chunkTextRanges(text, { limit: NaN }).map(({ start, end }) => text.slice(start, end))).toEqual([text]);
});

it("keeps grapheme boundaries and surrogate-safe progress in each chunking mode", () => {
  const common = [
    { text: "aaaaaaaaaa👨‍👩‍👧‍👦Z", limit: 12, expected: ["aaaaaaaaaa", "👨‍👩‍👧‍👦Z"] },
    { text: "👨‍👩‍👧‍👦", limit: 4, expected: ["👨‍", "👩‍", "👧‍", "👦"] },
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
