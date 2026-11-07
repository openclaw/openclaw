import { expect, it } from "vitest";
import { chunkText, chunkTextRanges } from "./chunk-text.js";

it("normalizes positive fractional limits without emitting empty chunks", () => {
  expect(chunkText("abc", 0.5)).toEqual(["a", "b", "c"]);
  expect(chunkText("😀😀", 0.5)).toEqual(["😀", "😀"]);
});

it("treats a non-finite limit as unbounded instead of dropping the message", () => {
  // NaN bounds nothing: comparing text against it is always false, so the pre-fix range
  // ended at NaN and every caller slicing by it sent an empty string.
  const text = "Hello from OpenClaw — this outbound message must never vanish.";
  const whole = [{ start: 0, end: text.length }];
  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(chunkText(text, limit)).toEqual([text]);
    expect(chunkTextRanges(text, { limit })).toEqual(whole);
    expect(chunkTextRanges(text, { limit, mode: "preferred" })).toEqual(whole);
  }
  // A non-positive limit keeps its documented whole-text behavior.
  expect(chunkText(text, -1)).toEqual([text]);
  expect(chunkText("", Number.NaN)).toEqual([]);
  expect(chunkTextRanges("", { limit: Number.NaN })).toEqual([]);
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
