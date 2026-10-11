// Memory Host SDK tests cover read file shared behavior.
import { describe, expect, it } from "vitest";
import { buildMemoryReadResult, buildMemoryReadResultFromSlice } from "./read-file-shared.js";

describe("memory read result slicing", () => {
  it.each([
    { content: "a\n\nb\n", maxChars: 2, text: "a\n", lines: 2, nextFrom: 3 },
    { content: "ab\nc\n", maxChars: 4, text: "ab\nc", lines: 2 },
  ])("preserves whole and blank lines at a $maxChars-character boundary", (fixture) => {
    const { content, maxChars, text, lines, nextFrom } = fixture;
    expect(buildMemoryReadResult({ content, maxChars, relPath: "memory/test.md" })).toEqual({
      status: "ok",
      path: "memory/test.md",
      from: 1,
      lines,
      text: nextFrom
        ? `${text}\n\n[More content available. Use from=${nextFrom} to continue.]`
        : text,
      ...(nextFrom ? { truncated: true, nextFrom } : {}),
    });
  });

  it("keeps the continuation notice when a leading surrogate pair is dropped", () => {
    expect(
      buildMemoryReadResultFromSlice({
        selectedLines: ["🤖tail"],
        relPath: "memory/test.md",
        startLine: 1,
        maxChars: 1,
        suggestReadFallback: true,
      }),
    ).toEqual({
      status: "ok",
      text: "\n\n[More content available. Requested excerpt exceeded the default maxChars budget. If you need the full raw line, use read on the source file.]",
      path: "memory/test.md",
      from: 1,
      lines: 1,
      truncated: true,
    });
  });
});
