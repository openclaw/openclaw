import { expect, it } from "vitest";
import { chunkText, chunkTextRanges } from "./chunk-text.js";

it("normalizes positive fractional limits without emitting empty chunks", () => {
  expect(chunkText("abc", 0.5)).toEqual(["a", "b", "c"]);
  expect(chunkText("😀😀", 0.5)).toEqual(["😀", "😀"]);
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

it("treats a NaN limit as non-positive instead of emitting an empty chunk", () => {
  // NaN bounds nothing: every comparison against it is false, so the range ended at
  // NaN and slicing by it sent "" — the whole outbound message vanished.
  const text = "Hello from OpenClaw — this outbound message must never vanish.";
  expect(chunkText(text, Number.NaN)).toEqual([text]);
  expect(chunkTextRanges(text, { limit: Number.NaN })).toEqual([{ start: 0, end: text.length }]);
  expect(chunkTextRanges(text, { limit: Number.NaN, mode: "preferred" })).toEqual([
    { start: 0, end: text.length },
  ]);
});

it("keeps every unbounded limit path unchanged", () => {
  const text = "Hello from OpenClaw — this outbound message must never vanish.";
  for (const limit of [0, -5, Number.POSITIVE_INFINITY]) {
    expect(chunkText(text, limit)).toEqual([text]);
    expect(chunkTextRanges(text, { limit })).toEqual([{ start: 0, end: text.length }]);
  }
});
