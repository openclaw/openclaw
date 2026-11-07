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
    ...[" ", "   ", "\t"].map((indent) => ({
      name: `an indented horizontal rule, not frontmatter (${JSON.stringify(indent)})`,
      content: `${indent}---\n## Refunds\n30 days\n---\n## Next`,
      heading: "Refunds",
      from: 2,
      text: "## Refunds\n30 days\n---",
    })),
    {
      name: "column-zero frontmatter with a BOM, trailing whitespace and CRLF",
      content: "\uFEFF--- \t\r\n# Refunds\r\n---\r\n## Refunds\r\nActual\r\n",
      heading: "Refunds",
      from: 4,
      text: "## Refunds\r\nActual\r",
    },
    {
      name: "frontmatter closed only by the canonical horizontal-rule delimiter",
      content: "---\ntitle: Notes\n...\n# Refunds\n---\n# Refunds\nBody",
      heading: "Refunds",
      from: 6,
      text: "# Refunds\nBody",
    },
    {
      name: "an ellipsis without a canonical frontmatter close",
      content: "---\ntitle: Notes\n...\n# Refunds\nBody",
      heading: "Refunds",
      from: 4,
      text: "# Refunds\nBody",
    },
    ...[
      { name: "list fences", open: "- ~~~md", body: "  # Example", close: "  ~~~" },
      { name: "numbered list fences", open: "10. ```md", body: "    # Example", close: "    ```" },
      { name: "quoted fences", open: "> ~~~md", body: "> # Example", close: "> ~~~" },
      {
        name: "nested list/quote fences",
        open: "- > ```md",
        body: "  > # Example",
        close: "  > ```",
      },
    ].map(({ name, open, body, close }) => ({
      name,
      content: `${open}\n${body}\n${close}\n\n## Refunds\n30 days`,
      heading: "Refunds",
      from: 5,
      text: "## Refunds\n30 days",
    })),
    {
      name: "a BOM-prefixed first heading",
      content: "\uFEFF## Refunds\n30 days",
      heading: "Refunds",
      from: 1,
      text: "\uFEFF## Refunds\n30 days",
    },
    {
      name: "a leading horizontal rule without a frontmatter close",
      content: "---\n\n## Refunds\n30 days",
      heading: "Refunds",
      from: 3,
      text: "## Refunds\n30 days",
    },
    {
      name: "an unterminated list fence whose container ended",
      content: "- ~~~md\n  # Example\n\n## Refunds\n30 days",
      heading: "Refunds",
      from: 4,
      text: "## Refunds\n30 days",
    },
    {
      name: "an unterminated quote fence whose container ended",
      content: "> ```md\n> # Example\n\n## Refunds\n30 days",
      heading: "Refunds",
      from: 4,
      text: "## Refunds\n30 days",
    },
    {
      name: "a heading on a list continuation line",
      content: "- note\n  ## Refunds\n  Example only\n\n## Refunds\n30 days",
      heading: "Refunds",
      from: 5,
      text: "## Refunds\n30 days",
    },
    {
      name: "a section containing a list continuation heading",
      content: "## Refunds\n30 days\n- note\n  ## Shipping\n  Example only\n\n## Next\nOther",
      heading: "Refunds",
      from: 1,
      text: "## Refunds\n30 days\n- note\n  ## Shipping\n  Example only\n",
    },
    {
      name: "a list continuation fence whose container ended",
      content: "- item\n  ~~~md\n  # Example\n\n## Refunds\n30 days",
      heading: "Refunds",
      from: 5,
      text: "## Refunds\n30 days",
    },
    {
      name: "a list fence after a lazy paragraph continuation",
      content: "- note\ncontinued\n  ~~~md\n  # Example\n\n## Refunds\n30 days",
      heading: "Refunds",
      from: 6,
      text: "## Refunds\n30 days",
    },
    {
      name: "a list heading after a lazy paragraph continuation",
      content: "- note\ncontinued\n  ## Refunds\n  Example only\n\n## Refunds\n30 days",
      heading: "Refunds",
      from: 6,
      text: "## Refunds\n30 days",
    },
    {
      name: "a paragraph outside a list after a blank line",
      content: "- note\n\nOutside\n  ## Refunds\n30 days",
      heading: "Refunds",
      from: 4,
      text: "  ## Refunds\n30 days",
    },
    ...["* * *", "- - -"].flatMap((rule) => [
      {
        name: `a section ending after the ${rule} thematic break`,
        content: `## Refunds\nText\n${rule}\n  ## Shipping\nOther`,
        heading: "Refunds",
        from: 1,
        text: `## Refunds\nText\n${rule}`,
      },
      {
        name: `a heading after the ${rule} thematic break`,
        content: `## Refunds\nText\n${rule}\n  ## Shipping\nOther`,
        heading: "Shipping",
        from: 4,
        text: "  ## Shipping\nOther",
      },
    ]),
    ...[
      { marker: "-", indent: "  " },
      { marker: "1.", indent: "   " },
    ].flatMap(({ marker, indent }) => [
      {
        name: `an empty ${marker} list item`,
        content: `## Refunds\n\n${marker}\n${indent}## Shipping\n${indent}Example only\n\n## Next`,
        heading: "Refunds",
        from: 1,
        text: `## Refunds\n\n${marker}\n${indent}## Shipping\n${indent}Example only\n`,
      },
      {
        name: `a paragraph not interrupted by an empty ${marker} marker`,
        content: `Text\n${marker}\n${indent}## Refunds\n30 days`,
        heading: "Refunds",
        from: 3,
        text: `${indent}## Refunds\n30 days`,
      },
    ]),
    {
      name: "an empty list item inside a quote",
      content: "> -\n>   ~~~md\n>   # Example\n\n## Refunds\n30 days",
      heading: "Refunds",
      from: 5,
      text: "## Refunds\n30 days",
    },
    {
      name: "an empty nested list item",
      content: "-\n  1.\n     ~~~md\n     # Example\n\n## Refunds\n30 days",
      heading: "Refunds",
      from: 6,
      text: "## Refunds\n30 days",
    },
    {
      name: "an empty list item after indented code",
      content: "## Refunds\n    Code\n-\n  ## Shipping\n  Example only\n\n## Next",
      heading: "Refunds",
      from: 1,
      text: "## Refunds\n    Code\n-\n  ## Shipping\n  Example only\n",
    },
    {
      name: "a paragraph not interrupted by an ordered list starting at two",
      content: "## Refunds\nNotes\n2. example\n   ## Shipping\nOther",
      heading: "Refunds",
      from: 1,
      text: "## Refunds\nNotes\n2. example",
    },
    {
      name: "a paragraph interrupted by an ordered list starting at one",
      content: "## Refunds\nNotes\n1. example\n   ## Shipping\nOther",
      heading: "Refunds",
      from: 1,
      text: "## Refunds\nNotes\n1. example\n   ## Shipping\nOther",
    },
    {
      name: "an ordered list starting at two after a blank line",
      content: "## Refunds\nNotes\n\n2. example\n   ## Shipping\nOther",
      heading: "Refunds",
      from: 1,
      text: "## Refunds\nNotes\n\n2. example\n   ## Shipping\nOther",
    },
    ...["2.", "2)"].map((marker) => ({
      name: `a narrower sibling ordered marker ${marker}`,
      content: `10. item\n${marker} note\n   ## Refunds\n   Example only\n\n## Refunds\n30 days`,
      heading: "Refunds",
      from: 6,
      text: "## Refunds\n30 days",
    })),
    {
      name: "a wider sibling ordered marker ending its old indentation",
      content: "2. item\n10. note\n   ## Refunds\n30 days",
      heading: "Refunds",
      from: 3,
      text: "   ## Refunds\n30 days",
    },
    {
      name: "a section containing a narrower sibling ordered marker",
      content: "## Refunds\n10. item\n2. note\n   ## Shipping\n\n## Next",
      heading: "Refunds",
      from: 1,
      text: "## Refunds\n10. item\n2. note\n   ## Shipping\n",
    },
    ...[
      { marker: "-", indent: "  " },
      { marker: "1.", indent: "   " },
    ].map(({ marker, indent }) => ({
      name: `a heading outside a ${marker} list with tab padding`,
      content: `${marker}\tExample\n${indent}## Refunds\n30 days`,
      heading: "Refunds",
      from: 2,
      text: `${indent}## Refunds\n30 days`,
    })),
    {
      name: "a heading with a literal tab in its title",
      content: "## Refund\tpolicy\n30 days",
      heading: "Refund\tpolicy",
      from: 1,
      text: "## Refund\tpolicy\n30 days",
    },
    {
      name: "a section containing a multiline HTML comment",
      content: "## Refunds\n30 days\n<!--\n## Shipping\n-->\nMore refund details\n## Next",
      heading: "Refunds",
      from: 1,
      text: "## Refunds\n30 days\n<!--\n## Shipping\n-->\nMore refund details",
    },
    {
      name: "a CommonMark comment not closed by the browser-only bang terminator",
      content: "## Refunds\n<!--\n--!>\n## Shipping\n-->\nMore refund details\n## Next",
      heading: "Refunds",
      from: 1,
      text: "## Refunds\n<!--\n--!>\n## Shipping\n-->\nMore refund details",
    },
    ...[
      { name: "comment", open: "<!--", close: "-->", from: 4 },
      { name: "script", open: "<script>", close: "</script>", from: 4 },
      { name: "pre", open: "<pre>", close: "</pre>", from: 4 },
      { name: "style", open: "<style>", close: "</style>", from: 4 },
      { name: "textarea", open: "<textarea>", close: "</textarea>", from: 4 },
      { name: "CDATA", open: "<![CDATA[", close: "]]>", from: 4 },
      { name: "processing instruction", open: "<?target", close: "?>", from: 4 },
      { name: "declaration", open: "<!DOCTYPE", close: ">", from: 4 },
      { name: "block tag", open: "<div>", close: "</div>\n", from: 5 },
      {
        name: "complete custom tag",
        open: '<custom-tag title="a>b">',
        close: "</custom-tag>\n",
        from: 5,
      },
    ].map(({ name, open, close, from }) => ({
      name: `a heading after an HTML ${name} block`,
      content: `${open}\n## Refunds\n${close}\n## Refunds\n30 days`,
      heading: "Refunds",
      from,
      text: "## Refunds\n30 days",
    })),
    ...[
      {
        name: "a comment inside a fence",
        content: "```html\n<!--\n```\n## Refunds\n30 days",
        from: 4,
      },
      {
        name: "a fence inside a comment",
        content: "<!--\n```md\n-->\n## Refunds\n30 days",
        from: 4,
      },
      {
        name: "a comment whose list container ended",
        content: "- <!--\n  ## Example\n\n## Refunds\n30 days",
        from: 4,
      },
      {
        name: "a comment whose quote container ended",
        content: "> <!--\n> ## Example\n\n## Refunds\n30 days",
        from: 4,
      },
      { name: "indented comment-like code", content: "    <!--\n## Refunds\n30 days", from: 2 },
      {
        name: "a same-line closed comment",
        content: "<!-- closed -->\n## Refunds\n30 days",
        from: 2,
      },
      {
        name: "a custom tag continuing a paragraph",
        content: "Text\n<custom-tag>\n## Refunds\n30 days",
        from: 3,
      },
      {
        name: "a block tag interrupting a lazy paragraph",
        content: "- note\n<div>\n## Refunds\n\n## Refunds\n30 days",
        from: 5,
      },
      {
        name: "a custom tag continuing a lazy paragraph",
        content: "- note\n<custom-tag>\n  ## Example\n\n## Refunds\n30 days",
        from: 5,
      },
    ].map(({ name, content, from }) => ({
      name,
      content,
      from,
      heading: "Refunds",
      text: "## Refunds\n30 days",
    })),
    {
      name: "list-looking content inside a comment",
      content: "<!--\n- example\n-->\n  ## Refunds\n30 days",
      heading: "Refunds",
      from: 4,
      text: "  ## Refunds\n30 days",
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
    { content: "- note\n  ## Refunds\n  Example only", code: "MEMORY_HEADING_NOT_FOUND" },
    { content: "-\n  ## Refunds\n  Example only", code: "MEMORY_HEADING_NOT_FOUND" },
    { content: "1.\n   ## Refunds\n   Example only", code: "MEMORY_HEADING_NOT_FOUND" },
    { content: "-     Example\n  ## Refunds\n  Example only", code: "MEMORY_HEADING_NOT_FOUND" },
    { content: "1.     Example\n   ## Refunds\n   Example only", code: "MEMORY_HEADING_NOT_FOUND" },
    { content: "-\t  Example\n  ## Refunds\n  Example only", code: "MEMORY_HEADING_NOT_FOUND" },
    { content: "-    \n  ## Refunds\n  Example only", code: "MEMORY_HEADING_NOT_FOUND" },
    { content: "1.    \n   ## Refunds\n   Example only", code: "MEMORY_HEADING_NOT_FOUND" },
    { content: "- Example\n\t## Refunds\n\tExample only", code: "MEMORY_HEADING_NOT_FOUND" },
    { content: "<!--\n## Refunds", code: "MEMORY_HEADING_NOT_FOUND" },
    { content: "<!--\n--!>\n## Refunds", code: "MEMORY_HEADING_NOT_FOUND" },
    { content: "<script>\n## Refunds", code: "MEMORY_HEADING_NOT_FOUND" },
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
