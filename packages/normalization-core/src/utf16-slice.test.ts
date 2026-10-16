import { describe, expect, it } from "vitest";
import { findGraphemeChunkEnd } from "./grapheme.js";
import {
  avoidTrailingHighSurrogateBreak,
  sliceUtf16Safe,
  truncateUtf16Safe,
  truncateWithMarker,
} from "./utf16-slice.js";

describe("avoidTrailingHighSurrogateBreak", () => {
  it("keeps ordinary boundaries and complete surrogate pairs", () => {
    const cases: [string, number, number, number][] = [
      ["hello", 0, 3, 3],
      ["hello", 0, 5, 5],
      ["a🤖b", 0, 2, 1],
      ["🤖b", 0, 1, 2],
      ["a🤖b", 1, 2, 3],
    ];
    for (const [text, start, end, expected] of cases) {
      expect(avoidTrailingHighSurrogateBreak(text, start, end)).toBe(expected);
    }
  });
});

describe("sliceUtf16Safe", () => {
  it.each<[string, Parameters<typeof sliceUtf16Safe>, string]>([
    ["handles negative start", ["hello world", -5], "world"],
    ["handles negative end", ["hello world", 0, -6], "hello"],
    ["handles start beyond length", ["hello", 10], ""],
    ["handles end beyond length", ["hello", 0, 10], "hello"],
    ["returns empty when start > end, matching String.prototype.slice", ["hello", 3, 1], ""],
    ["preserves emoji with surrogate pairs", ["👨‍👩‍👧‍👦", 0], "👨‍👩‍👧‍👦"],
    ["returns empty string when slicing middle of surrogate pair", ["👨👩", 1, 3], ""],
    ["returns empty string when slicing at start of surrogate pair", ["👨👩", 0, 1], ""],
    ["handles undefined end", ["hello", 2], "llo"],
  ])("%s", (_name, args, expected) => {
    expect(sliceUtf16Safe(...args)).toBe(expected);
  });
});

describe("truncateUtf16Safe", () => {
  it.each<[string, Parameters<typeof truncateUtf16Safe>, string]>([
    ["returns input when shorter than limit", ["hello", 10], "hello"],
    ["handles zero limit", ["hello", 0], ""],
    ["handles negative limit", ["hello", -1], ""],
    ["floors decimal limit", ["hello world", 5.7], "hello"],
    ["returns empty string when truncating at surrogate pair boundary", ["👨👩", 1], ""],
  ])("%s", (_name, args, expected) => {
    expect(truncateUtf16Safe(...args)).toBe(expected);
  });
});

describe("truncateWithMarker", () => {
  it.each<[string, number, string, number, boolean, string]>([
    ["hello", 5, "...", 3, false, "hello"],
    ["hello world", 8, "...", 3, false, "hello..."],
    ["hello world", 5, "...", 0, false, "hello..."],
    ["hello   world", 9, "...", 3, true, "hello..."],
    ["ab🚀tail", 4, "…", 1, false, "ab…"],
    ["hello", 0, "…", 1, false, "…"],
  ])(
    "truncates %j at %i with marker %j (reserve=%i, trimEnd=%s)",
    (text, max, marker, reserve, trimEnd, expected) => {
      expect(truncateWithMarker(text, max, { marker, reserve, trimEnd })).toBe(expected);
    },
  );
});

describe("findGraphemeChunkEnd", () => {
  it.each([
    ["family ZWJ", "👨‍👩‍👧‍👦"],
    ["flag", "🇺🇸"],
    ["skin tone", "👍🏽"],
    ["combining mark", "e\u0301"],
    ["Indic conjunct", "\u0915\u094D\u0937\u093F"],
    ["CRLF", "\r\n"],
    ["whitespace with combining mark", " \u0301"],
    ["punctuation with combining mark", "。\u0301"],
    ["prepended whitespace with combining mark", "\u0600 \u0301"],
  ])("preserves a whole %s cluster", (_name, cluster) => {
    const text = `a${cluster}b`;
    for (let end = 2; end < cluster.length + 1; end++) {
      expect(findGraphemeChunkEnd(text, 0, end)).toBe(1);
      expect(findGraphemeChunkEnd(text, 0, text.length, end)).toBe(1);
    }
    expect(findGraphemeChunkEnd(text, 0, cluster.length + 1)).toBe(cluster.length + 1);
  });

  it("respects hard budgets, unusable preferences, and partial-cut policy", () => {
    const cases: [Parameters<typeof findGraphemeChunkEnd>, number][] = [
      [["a👨‍👩‍👧‍👦bc", 1, 13, 3, true], 13],
      [["a👨‍👩‍👧‍👦bc", 1, 13, 3, false], 13],
      [["a👨‍👩‍👧‍👦", 0, 3, Number.NaN], 1],
      [["👨‍👩‍👧‍👦", 0, 5], 5],
      [["👨‍👩‍👧‍👦", 0, 5, 5, false], 0],
      [["a👨‍👩‍👧‍👦b", 1, 5], 4],
      [["a👨‍👩‍👧‍👦b", 1, 5, 5, false], 1],
      [["a🤖b", 1, 2], 3],
      [["a🤖b", 1, 2, 2, false], 1],
      [["🤖", 0, 0], 0],
      [["abc", 1, 1], 1],
      [["abc", 0, 5], 3],
    ];
    for (const [args, expected] of cases) {
      expect(findGraphemeChunkEnd(...args)).toBe(expected);
    }
  });
});
