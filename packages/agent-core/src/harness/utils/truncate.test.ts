import { describe, expect, it } from "vitest";
import { truncateHead } from "./truncate.js";

describe("truncate utilities", () => {
  it("does not count a trailing newline as an extra display line", () => {
    expect(truncateHead("alpha\nbeta\n", 50 * 1024).totalLines).toBe(2);
  });

  it("keeps oversized head lines byte-limited", () => {
    expect(truncateHead("long\nx", 2)).toEqual({
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines: 2,
      totalBytes: 6,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines: 2000,
      maxBytes: 2,
    });
  });

  it.each([
    ["\uD800x\uDC00\ndiscarded\n\uD800x\uDC00", 7, "\uD800x\uDC00", 1],
    ["a\nb\nc", 1, "a", 1],
    ["\n\n\n", 2, "\n\n", 3],
  ] as const)(
    "preserves selected head lines and byte-limit metadata: %j",
    (content, maxBytes, expected, outputLines) => {
      expect(truncateHead(content, maxBytes)).toMatchObject({
        content: expected,
        totalLines: 3,
        totalBytes: Buffer.byteLength(content),
        outputLines,
        outputBytes: Buffer.byteLength(expected),
        truncated: true,
        truncatedBy: "bytes",
        firstLineExceedsLimit: false,
        lastLinePartial: false,
      });
    },
  );

  it("keeps the fixed 2000-line ceiling independently of the byte budget", () => {
    expect(truncateHead(`${"x\n".repeat(2000)}last`, 50 * 1024)).toMatchObject({
      content: `${"x\n".repeat(1999)}x`,
      truncated: true,
      truncatedBy: "lines",
      totalLines: 2001,
      outputLines: 2000,
      outputBytes: 3999,
      maxLines: 2000,
      maxBytes: 50 * 1024,
    });
  });
});
