// Memory Host SDK tests cover read file shared behavior.
import { describe, expect, it } from "vitest";
import { buildMemoryReadResult, buildMemoryReadResultFromSlice } from "./read-file-shared.js";

describe("memory read result slicing", () => {
  it.each([
    {
      name: "a child section",
      content:
        "# Policy\n## Refunds\n30 days\n### Exceptions\nCustom orders excluded\n## Shipping\nNext",
      heading: "Refunds",
      from: 2,
      text: "## Refunds\n30 days\n### Exceptions\nCustom orders excluded",
    },
    {
      name: "Chinese text and closing markers",
      content: "# 规则\r\n## 退款 ###\r\n定制品除外\r\n# 其它\r\n",
      heading: "退款",
      from: 2,
      text: "## 退款 ###\r\n定制品除外\r",
    },
    {
      name: "fenced examples",
      content:
        "```md\n## Refunds\n```\n~~~\n## Refunds\n~~~\n## Refunds\nActual\n```\n# Example\n```\n# Next",
      heading: "Refunds",
      from: 7,
      text: "## Refunds\nActual\n```\n# Example\n```",
    },
    {
      name: "frontmatter and indented code",
      content: "---\n# Refunds\n---\n    ## Refunds\n## Refunds\nActual",
      heading: "Refunds",
      from: 5,
      text: "## Refunds\nActual",
    },
  ])(
    "reads $name with original line numbers and no sibling continuation",
    ({ content, heading, from, text }) => {
      expect(buildMemoryReadResult({ content, heading, relPath: "memory/policy.md" })).toEqual({
        status: "ok",
        path: "memory/policy.md",
        from,
        lines: text.split("\n").length,
        text,
      });
    },
  );

  it("keeps budgeted continuation inside the selected section", () => {
    const content = "# Policy\n## Refunds\n30 days\nCustom excluded\n## Shipping\nOther";
    const request = { content, heading: "Refunds", relPath: "memory/policy.md", maxChars: 12 };
    expect(buildMemoryReadResult(request)).toEqual({
      status: "ok",
      path: "memory/policy.md",
      from: 2,
      lines: 1,
      truncated: true,
      nextFrom: 3,
      text: "## Refunds\n\n[More content available. Use from=3 to continue.]",
    });
    expect(buildMemoryReadResult({ ...request, from: 3, maxChars: 100 })).toEqual({
      status: "ok",
      path: "memory/policy.md",
      from: 3,
      lines: 2,
      text: "30 days\nCustom excluded",
    });
    expect(buildMemoryReadResult({ ...request, lines: 2, maxChars: 100 })).toMatchObject({
      nextFrom: 4,
      truncated: true,
    });
    for (const from of [1, 5]) {
      expect(() => buildMemoryReadResult({ ...request, from })).toThrow("from must be within");
    }
  });

  it.each([
    { content: "# Policy\nNo heading", code: "MEMORY_HEADING_NOT_FOUND" },
    { content: "## Refunds\nOne\n## Refunds\nTwo", code: "MEMORY_HEADING_AMBIGUOUS" },
  ])("rejects $code without returning an unrelated excerpt", ({ content, code }) => {
    expect(() =>
      buildMemoryReadResult({ content, heading: "Refunds", relPath: "memory/policy.md" }),
    ).toThrow(expect.objectContaining({ code }));
  });

  it.each([
    {
      name: "a terminal newline",
      content: "one\ntwo\n",
      requestedLines: 2,
      text: "one\ntwo",
      lines: 2,
    },
    {
      name: "an empty file",
      content: "",
      requestedLines: 2,
      text: "",
      lines: 0,
    },
    {
      name: "one intentional trailing blank line",
      content: "one\n\n",
      requestedLines: 2,
      text: "one\n",
      lines: 2,
    },
    {
      name: "two intentional trailing blank lines",
      content: "one\n\n\n",
      requestedLines: 3,
      text: "one\n\n",
      lines: 3,
    },
  ])("does not expose a phantom continuation for $name", (fixture) => {
    expect(
      buildMemoryReadResult({
        content: fixture.content,
        relPath: "memory/test.md",
        lines: fixture.requestedLines,
      }),
    ).toEqual({
      status: "ok",
      text: fixture.text,
      path: "memory/test.md",
      from: 1,
      lines: fixture.lines,
    });
  });

  it("uses default line windows for non-finite from and lines values", () => {
    expect(
      buildMemoryReadResult({
        content: "one\ntwo\nthree",
        relPath: "memory/test.md",
        from: Number.NaN,
        lines: Number.NaN,
      }),
    ).toEqual({
      status: "ok",
      text: "one\ntwo\nthree",
      path: "memory/test.md",
      from: 1,
      lines: 3,
    });
  });

  it.each([
    { content: "ab\nc\n", maxChars: 2, text: "ab", lines: 1, nextFrom: 2 },
    { content: "a\n\nb\n", maxChars: 2, text: "a\n", lines: 2, nextFrom: 3 },
    { content: "ab\nc\n", maxChars: 4, text: "ab\nc", lines: 2 },
    { content: "\n\n", maxChars: 1, text: "\n", lines: 2 },
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

  it("uses the default character budget for non-finite maxChars values", () => {
    expect(
      buildMemoryReadResultFromSlice({
        selectedLines: ["one", "two"],
        relPath: "memory/test.md",
        startLine: Number.POSITIVE_INFINITY,
        maxChars: Number.NaN,
      }),
    ).toEqual({
      status: "ok",
      text: "one\ntwo",
      path: "memory/test.md",
      from: 1,
      lines: 2,
    });
  });

  it("does not split surrogate pairs when truncating a single line", () => {
    expect(
      buildMemoryReadResultFromSlice({
        selectedLines: ["abc🤖tail"],
        relPath: "memory/test.md",
        startLine: 1,
        maxChars: 4,
        suggestReadFallback: true,
      }),
    ).toEqual({
      status: "ok",
      text: "abc\n\n[More content available. Requested excerpt exceeded the default maxChars budget. If you need the full raw line, use read on the source file.]",
      path: "memory/test.md",
      from: 1,
      lines: 1,
      truncated: true,
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
