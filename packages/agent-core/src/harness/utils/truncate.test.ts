import { describe, expect, it } from "vitest";
import { truncateHead, truncateLine, truncateTail } from "./truncate.js";

describe("truncate utilities", () => {
  it("does not count a trailing newline as an extra display line", () => {
    expect(truncateHead("alpha\nbeta\n").totalLines).toBe(2);
    expect(truncateTail("alpha\nbeta\n").totalLines).toBe(2);
    expect(truncateTail("alpha\nbeta\ngamma\n", { maxLines: 2 })).toMatchObject({
      content: "beta\ngamma",
      truncatedBy: "lines",
      outputLines: 2,
    });
  });

  it("preserves a leading BOM and NUL in a partial tail line", () => {
    expect(truncateTail("discarded-\uFEFFA\0B", { maxBytes: 6 })).toMatchObject({
      content: "\uFEFFA\0B",
      outputBytes: 6,
      outputLines: 1,
      lastLinePartial: true,
    });
  });

  it.each([
    { tail: "\uDC00\uD800\uDC00", maxBytes: 7, expected: "\uFFFD\uD800\uDC00" },
    { tail: "🙂\uD800", maxBytes: 7, expected: "🙂\uFFFD" },
  ])(
    "repairs only retained lone surrogates within $maxBytes bytes: $tail",
    ({ tail, maxBytes, expected }) => {
      const content = `discarded-${tail}`;
      expect(truncateTail(content, { maxBytes })).toEqual({
        content: expected,
        truncated: true,
        truncatedBy: "bytes",
        totalLines: 1,
        totalBytes: Buffer.byteLength(content),
        outputLines: 1,
        outputBytes: Buffer.byteLength(expected),
        lastLinePartial: true,
        firstLineExceedsLimit: false,
        maxLines: 2000,
        maxBytes,
      });
    },
  );

  it.each([
    ["\uD800x\uDC00\ndiscarded\n\uD800x\uDC00", 2, 7, "\uD800x\uDC00", "\uD800x\uDC00", 1, "bytes"],
    ["a\nb\nc", 1, 1, "a", "c", 1, "lines"],
    ["\n\n\n", 3, 2, "\n\n", "\n\n", 3, "bytes"],
  ] as const)(
    "preserves selected lines and limit metadata: %j",
    (content, maxLines, maxBytes, head, tail, outputLines, truncatedBy) => {
      for (const [truncate, expected] of [
        [truncateHead, head],
        [truncateTail, tail],
      ] as const) {
        expect(truncate(content, { maxLines, maxBytes })).toMatchObject({
          content: expected,
          totalLines: 3,
          totalBytes: Buffer.byteLength(content),
          outputLines,
          outputBytes: Buffer.byteLength(expected),
          truncated: true,
          truncatedBy,
          firstLineExceedsLimit: false,
          lastLinePartial: false,
        });
      }
    },
  );

  it("truncateLine keeps 500 characters and truncates longer lines by default", () => {
    const line = "x".repeat(500);
    expect(truncateLine(line)).toEqual({ text: line, wasTruncated: false });
    expect(truncateLine(`${line}y`)).toEqual({
      text: `${line}... [truncated]`,
      wasTruncated: true,
    });
  });

  it("truncateLine does not split a surrogate pair at the cut point", () => {
    expect(truncateLine("AB🤖CD", 3).text).toBe("AB... [truncated]");
    expect(truncateLine("🤖🤖🤖", 5).text).toBe("🤖🤖... [truncated]");
    expect(truncateLine("AB𠮷CD", 5).text).toBe("AB𠮷C... [truncated]");
  });
});
