import { expect, it } from "vitest";
import { findGraphemeChunkEnd } from "./grapheme.js";
import * as utf16 from "./utf16-slice.js";

it.each<[string, number, number, number]>([
  ["hello", 0, 3, 3],
  ["hello", 0, 5, 5],
  ["a🤖b", 0, 2, 1],
  ["🤖b", 0, 1, 2],
  ["a🤖b", 1, 2, 3],
])("adjusts %j from %i to %i", (text, start, end, expected) => {
  expect(utf16.avoidTrailingHighSurrogateBreak(text, start, end)).toBe(expected);
});

it.each<[Parameters<typeof utf16.sliceUtf16Safe>, string]>([
  [["hello world", -5], "world"],
  [["hello world", 0, -6], "hello"],
  [["hello", 10], ""],
  [["hello", 0, 10], "hello"],
  [["hello", 3, 1], ""],
  [["👨‍👩‍👧‍👦", 0], "👨‍👩‍👧‍👦"],
  [["👨👩", 1, 3], ""],
  [["👨👩", 0, 1], ""],
  [["hello", 2], "llo"],
])("utf16.sliceUtf16Safe(%j)", (args, expected) => {
  expect(utf16.sliceUtf16Safe(...args)).toBe(expected);
});

it.each<[Parameters<typeof utf16.truncateUtf16Safe>, string]>([
  [["hello", 10], "hello"],
  [["hello", 0], ""],
  [["hello", -1], ""],
  [["hello world", 5.7], "hello"],
  [["👨👩", 1], ""],
])("utf16.truncateUtf16Safe(%j)", (args, expected) => {
  expect(utf16.truncateUtf16Safe(...args)).toBe(expected);
});

it.each<[string, number, string, number, boolean, string]>([
  ["hello", 5, "...", 3, false, "hello"],
  ["hello world", 8, "...", 3, false, "hello..."],
  ["hello world", 5, "...", 0, false, "hello..."],
  ["hello   world", 9, "...", 3, true, "hello..."],
  ["ab🚀tail", 4, "…", 1, false, "ab…"],
  ["hello", 0, "…", 1, false, "…"],
])("truncates %j at %i with %j/%i/%s", (text, max, marker, reserve, trimEnd, expected) => {
  expect(utf16.truncateWithMarker(text, max, { marker, reserve, trimEnd })).toBe(expected);
});

it.each(["👨‍👩‍👧‍👦", "🇺🇸", "👍🏽", "é", "क्षि", "\r\n", " ́", "。́", "؀ ́"])(
  "preserves a whole %j cluster",
  (cluster) => {
    const text = `a${cluster}b`;
    for (let end = 2; end < cluster.length + 1; end++) {
      expect(findGraphemeChunkEnd(text, 0, end)).toBe(1);
      expect(findGraphemeChunkEnd(text, 0, text.length, end)).toBe(1);
    }
    expect(findGraphemeChunkEnd(text, 0, cluster.length + 1)).toBe(cluster.length + 1);
  },
);

it.each<[Parameters<typeof findGraphemeChunkEnd>, number]>([
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
])("respects grapheme budget/policy %j", (args, expected) => {
  expect(findGraphemeChunkEnd(...args)).toBe(expected);
});
