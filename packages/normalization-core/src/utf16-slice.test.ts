// Tests for Unicode-safe UTF-16 string slicing helpers.
import { describe, expect, it } from "vitest";
import {
  avoidTrailingGraphemeBreak,
  avoidTrailingHighSurrogateBreak,
  sliceUtf16Safe,
  truncateUtf16Safe,
  truncateWithMarker,
} from "./utf16-slice.js";

describe("avoidTrailingGraphemeBreak", () => {
  it.each([
    ["family emoji", "👨‍👩‍👧‍👦"],
    ["flag", "🇺🇸"],
    ["emoji modifier", "👋🏽"],
    ["combining sequence", "e\u0301"],
    ["Indic conjunct", "क्ष"],
  ])("moves a cut before a %s cluster", (_name, grapheme) => {
    const prefix = "ab";
    const firstCodePointLength = Array.from(grapheme)[0]?.length ?? 1;
    const text = `${prefix}${grapheme}z`;

    expect(
      avoidTrailingGraphemeBreak(
        text,
        0,
        prefix.length + firstCodePointLength,
        prefix.length + grapheme.length,
      ),
    ).toBe(prefix.length);
  });

  it("keeps the first cluster whole when it fits the hard window", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(avoidTrailingGraphemeBreak(`${family}z`, 0, 2, family.length)).toBe(family.length);
  });

  it("makes code-point progress when one cluster exceeds the hard window", () => {
    expect(avoidTrailingGraphemeBreak("👨‍👩‍👧‍👦z", 0, 5)).toBe(5);
  });
});

describe("avoidTrailingHighSurrogateBreak", () => {
  it("keeps ordinary and terminal boundaries unchanged", () => {
    expect(avoidTrailingHighSurrogateBreak("hello", 0, 3)).toBe(3);
    expect(avoidTrailingHighSurrogateBreak("hello", 0, 5)).toBe(5);
  });

  it("moves a split before a surrogate pair when room remains", () => {
    expect(avoidTrailingHighSurrogateBreak("a🤖b", 0, 2)).toBe(1);
  });

  it("includes the full pair when a one-unit chunk starts with it", () => {
    expect(avoidTrailingHighSurrogateBreak("🤖b", 0, 1)).toBe(2);
  });
});

describe("sliceUtf16Safe", () => {
  it.each<[string, Parameters<typeof sliceUtf16Safe>, string]>([
    ["slices ASCII string normally", ["hello world", 0, 5], "hello"],
    ["handles negative start", ["hello world", -5], "world"],
    ["handles negative end", ["hello world", 0, -6], "hello"],
    ["handles start beyond length", ["hello", 10], ""],
    ["handles end beyond length", ["hello", 0, 10], "hello"],
    ["returns empty when start > end, matching String.prototype.slice", ["hello", 3, 1], ""],
    ["preserves emoji with surrogate pairs", ["👨‍👩‍👧‍👦", 0], "👨‍👩‍👧‍👦"],
    ["returns empty string when slicing middle of surrogate pair", ["👨👩", 1, 3], ""],
    ["returns empty string when slicing at start of surrogate pair", ["👨👩", 0, 1], ""],
    ["handles empty string", ["", 0], ""],
    ["handles undefined end", ["hello", 2], "llo"],
  ])("%s", (_name, args, expected) => {
    expect(sliceUtf16Safe(...args)).toBe(expected);
  });
});

describe("truncateUtf16Safe", () => {
  it.each<[string, Parameters<typeof truncateUtf16Safe>, string]>([
    ["returns input when shorter than limit", ["hello", 10], "hello"],
    ["truncates when longer than limit", ["hello world", 5], "hello"],
    ["handles zero limit", ["hello", 0], ""],
    ["handles negative limit", ["hello", -1], ""],
    ["floors decimal limit", ["hello world", 5.7], "hello"],
    ["returns empty string when truncating at surrogate pair boundary", ["👨👩", 1], ""],
  ])("%s", (_name, args, expected) => {
    expect(truncateUtf16Safe(...args)).toBe(expected);
  });
});

describe("truncateWithMarker", () => {
  it.each([
    {
      name: "returns values at the boundary unchanged",
      value: "hello",
      max: 5,
      options: { marker: "...", reserve: 3, trimEnd: false },
      expected: "hello",
    },
    {
      name: "reserves marker width",
      value: "hello world",
      max: 8,
      options: { marker: "...", reserve: 3, trimEnd: false },
      expected: "hello...",
    },
    {
      name: "supports markers outside the limit",
      value: "hello world",
      max: 5,
      options: { marker: "...", reserve: 0, trimEnd: false },
      expected: "hello...",
    },
    {
      name: "trims only the truncated prefix",
      value: "hello   world",
      max: 9,
      options: { marker: "...", reserve: 3, trimEnd: true },
      expected: "hello...",
    },
    {
      name: "keeps surrogate pairs well formed",
      value: "ab🚀tail",
      max: 4,
      options: { marker: "…", reserve: 1, trimEnd: false },
      expected: "ab…",
    },
    {
      name: "preserves marker output at zero limits",
      value: "hello",
      max: 0,
      options: { marker: "…", reserve: 1, trimEnd: false },
      expected: "…",
    },
  ] as const)("$name", ({ value, max, options, expected }) => {
    expect(truncateWithMarker(value, max, options)).toBe(expected);
  });
});
