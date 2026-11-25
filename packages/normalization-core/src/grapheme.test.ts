import { describe, expect, it, vi } from "vitest";
import {
  createGraphemeChunkEndFinder,
  findGraphemeChunkEnd,
  skipWhitespaceGraphemes,
  trimEndWhitespaceGraphemes,
} from "./grapheme.js";

describe("findGraphemeChunkEnd", () => {
  it.each(["😀", "🇯🇵", "👨‍👩‍👧‍👦", "👍🏽"])("uses the full budget before another %s cluster", (cluster) => {
    expect(findGraphemeChunkEnd(cluster.repeat(3), 0, cluster.length * 2)).toBe(cluster.length * 2);
  });
});

describe("long text work volume", () => {
  it("segments a bounded window per chunk, not the remaining text", () => {
    const text = `${"a".repeat(3990)} `.repeat(300);
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
    try {
      let start = 0;
      while (start < text.length) {
        const end = findGraphemeChunkEnd(text, start, start + 4000, start + 3991);
        skipWhitespaceGraphemes(text, end, 1);
        trimEndWhitespaceGraphemes(text, end);
        start = end;
      }
      const segmented = segment.mock.calls.reduce((sum, [input]) => sum + input.length, 0);
      expect(segmented).toBeLessThan(text.length / 2);
    } finally {
      segment.mockRestore();
    }
  });

  it("keeps whitespace graphemes whole across a window edge", () => {
    const text = `${"x".repeat(10)}${" ".repeat(600)}\u0301y`;
    expect(trimEndWhitespaceGraphemes(text, text.length - 1)).toBe(text.slice(0, -1));
    expect(skipWhitespaceGraphemes(text, 10)).toBe(609);
    expect(trimEndWhitespaceGraphemes(`${"x".repeat(10)}${" ".repeat(600)}`)).toBe("x".repeat(10));
  });
});

it("resolves arbitrary and backwards cuts against the original regional indicators", () => {
  const text = "🇬🇭".repeat(2_500);
  const findEnd = createGraphemeChunkEndFinder(text);
  expect(findEnd(8_002, 8_006)).toBe(8_004);
  expect(findEnd(2, 6)).toBe(4);
  expect(findGraphemeChunkEnd("👩‍👩‍👦", 2, 5, 5, false)).toBe(2);
  const acrossWords = createGraphemeChunkEndFinder("α".repeat(31) + "β" + "\u0301".repeat(100));
  expect(acrossWords(100, 105, 105, false)).toBe(100);
  expect(acrossWords(0, 30.75)).toBe(30);
  expect(acrossWords(0, 31)).toBe(31);
  expect(acrossWords(0, 95)).toBe(31);
});

it("keeps supplementary marks and prepend characters whole at whitespace window edges", () => {
  expect(skipWhitespaceGraphemes(" ".repeat(255) + "\u{E0100}x")).toBe(254);
  expect(trimEndWhitespaceGraphemes("\u{110BD}" + " ".repeat(255))).toBe("\u{110BD} ");
});

it("does bounded total segmentation work across repeated partial cuts", () => {
  const text = ("a" + "\u0301".repeat(3_999)).repeat(4);
  const findEnd = createGraphemeChunkEndFinder(text);
  const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
  try {
    let start = 0;
    while (start < text.length) {
      start = findEnd(start, start + 16);
    }
    const volume = segment.mock.calls.reduce((sum, [input]) => sum + input.length, 0);
    expect(volume).toBeLessThan(text.length * 2);
  } finally {
    segment.mockRestore();
  }
});
