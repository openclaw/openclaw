import { expect, it } from "vitest";
import { chunkText, chunkTextRanges } from "./chunk-text.js";
import { chunkMarkdownIR, markdownToIR } from "./ir.js";

it("normalizes positive fractional limits without emitting empty chunks", () => {
  expect(chunkText("abc", 0.5)).toEqual(["a", "b", "c"]);
  expect(chunkText("😀😀", 0.5)).toEqual(["😀", "😀"]);
});

it("preserves text and ranges when the limit does not impose a size cap", () => {
  const text = "😀 é\n\ntail ";
  const ir = markdownToIR("**😀Hi** [é](https://example.com)");
  for (const limit of [Number.NaN, Infinity, 0, -1, -Infinity]) {
    expect.soft(chunkText(text, limit)).toEqual([text]);
    for (const mode of ["hard", "preferred"] as const) {
      expect.soft(chunkTextRanges(text, { limit, mode })).toEqual([{ start: 0, end: text.length }]);
    }
    expect.soft(chunkMarkdownIR(ir, limit)).toMatchObject([
      {
        text: "😀Hi é",
        styles: [{ start: 0, end: 4, style: "bold" }],
        links: [{ start: 5, end: 7, href: "https://example.com" }],
      },
    ]);
    expect(chunkText("", limit)).toEqual([]);
    expect(chunkTextRanges("", { limit })).toEqual([]);
  }
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
