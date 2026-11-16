import { describe, expect, it, vi } from "vitest";
import {
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
      const segmented = segment.mock.calls.reduce((sum, [input]) => sum + String(input).length, 0);
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
