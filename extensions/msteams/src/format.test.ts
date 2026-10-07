import { randomUUID } from "node:crypto";
import MarkdownIt from "markdown-it";
import { describe, expect, it, vi } from "vitest";
import { formatMSTeamsMarkdown } from "./format.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

describe("formatMSTeamsMarkdown", () => {
  it.each([
    ["falls headings back to bold text", "# Deployment status", "**Deployment status**"],
    ["falls unordered lists back to mobile-safe bullets", "- alpha\n- beta", "• alpha\n• beta"],
    ["falls ordered lists back to numbered text", "1. alpha\n2. beta", "1. alpha\n2. beta"],
    [
      "falls task lists back to checkbox text",
      "- [x] shipped\n- [ ] pending",
      "[x] shipped\n[ ] pending",
    ],
    ["keeps partially supported strikethrough markers", "~~obsolete~~", "~~obsolete~~"],
    ["keeps every paragraph inside a blockquote", "> one\n>\n> two", "> one\n> \n> two"],
    [
      "stops blockquote prefixes before following text",
      "> quoted\n\noutside",
      "> quoted\n\noutside",
    ],
    ["does not linkify plain filenames", "See README.md", "See README.md"],
    [
      "preserves entity-encoded markdown literals",
      "&#42;&#42;literal&#42;&#42;",
      "&#42;&#42;literal&#42;&#42;",
    ],
    ["preserves transport-owned mentions", "@[Alice](29:abc)", "@[Alice](29:abc)"],
    [
      "preserves escaped brackets in transport-owned mentions",
      String.raw`@[Alice \[Ops\]](29:abc)`,
      String.raw`@[Alice \[Ops\]](29:abc)`,
    ],
    [
      "preserves transport-owned markdown images",
      "![chart](https://example.com/chart_(final).png)",
      "![chart](https://example.com/chart_(final).png)",
    ],
    [
      "preserves images containing nested opener text",
      "![plot](https://example.com/a![b].png)",
      "![plot](https://example.com/a![b].png)",
    ],
    [
      "includes protected image backticks when choosing code delimiters",
      "``![x`](https://example.com/x.png)``",
      "``![x`](https://example.com/x.png)``",
    ],
    [
      "keeps every fenced-code line inside a blockquote",
      "> ```\n> one\n> two\n> ```",
      "> ```\n> one\n> two\n> ```",
    ],
    [
      "keeps surrounding blockquote text around inline code",
      "> Run `status` now.",
      "> Run `status` now.",
    ],
    [
      "keeps merged nested quotes aligned with Unicode styles and inline code",
      "> > **😀** `one`\n> > `two` **tail**",
      "> **😀** `one`\n> `two` **tail**",
    ],
    ["keeps escaped markdown literal", String.raw`\*literal\*`, String.raw`\*literal\*`],
    ["keeps escaped literal backticks", String.raw`\`literal\``, String.raw`\`literal\``],
    ["restores escaped markdown nested inside code", "`\\*`", "`\\*`"],
    [
      "falls nested lists back without treating indentation as code",
      "- parent\n    - child",
      "• parent\n  • child",
    ],
    [
      "keeps inline code delimiters that protect embedded backticks",
      "``value `with` ticks``",
      "``value `with` ticks``",
    ],
    [
      "includes escaped backticks when choosing inline code delimiters",
      "``a \\` b``",
      "``a \\` b``",
    ],
    ["preserves inline code semantics while normalizing boundary spaces", "`  foo  `", "`  foo  `"],
    [
      "serializes link destinations with angle brackets",
      "[x](https://host/a)",
      "[x](<https://host/a>)",
    ],
    [
      "drops code language while keeping a collision-safe fence",
      ["````md", "```", "example", "```", "````"].join("\n"),
      ["````", "```", "example", "```", "````"].join("\n"),
    ],
    [
      "normalizes indented code to a collision-safe fence",
      "    **literal code**",
      ["```", "**literal code**", "```"].join("\n"),
    ],
  ])("%s", (_name, before, after) => {
    expect(formatMSTeamsMarkdown(before, "off")).toBe(after);
  });

  it.each([
    ["`foo `", "<code>foo </code>"],
    ["` `", "<code> </code>"],
    ["before `  foo  ` after", "before <code> foo </code> after"],
  ])("preserves rendered inline-code whitespace in %j", (markdown, html) => {
    const parser = new MarkdownIt();
    // Code-span padding is syntax; compare parsed content without trimming literal spaces.
    expect(parser.renderInline(markdown)).toBe(html);
    expect(parser.renderInline(formatMSTeamsMarkdown(markdown, "off"))).toBe(html);
  });

  it.each(["", "  ", "> "])("keeps raw table prefix %j when conversion is disabled", (prefix) => {
    const table = ["| Name | State |", "|---|---|", "| deploy | ready |"]
      .map((line) => prefix + line)
      .join("\n");
    expect(formatMSTeamsMarkdown(table, "off")).toBe(table);
  });

  it("keeps separate raw tables after lone carriage-return line endings", () => {
    const table = "| A | B |\r|---|---|\r| x | y |";
    const source = `# Before\r\r${table}\r\r# After\r\r${table}`;
    expect(formatMSTeamsMarkdown(source, "off")).toBe(
      `**Before**\n\n${table}\n\n**After**\n\n${table}`,
    );
  });

  it("keeps one-column raw tables when table conversion is disabled", () => {
    const table = ["| Name |", "|---|", "| deploy |"].join("\n");
    expect(formatMSTeamsMarkdown(table, "off")).toBe(table);
  });

  it("keeps raw tables with tab-padded delimiter cells", () => {
    const table = ["| A | B |", "|\t---\t|\t---\t|", "| x | y |"].join("\n");
    expect(formatMSTeamsMarkdown(table, "off")).toBe(table);
  });

  it("keeps pipe-less body rows in raw tables when conversion is disabled", () => {
    const table = ["| Name | State |", "|---|---|", "[deploy](https://host/a)"].join("\n");
    expect(formatMSTeamsMarkdown(table, "off")).toBe(table);
  });

  it("does not treat tables inside fenced code as raw table blocks", () => {
    const before = ["```", "| A | B |", "|---|---|", "| x | y |", "```", "", "# Next"].join("\n");
    const after = ["```", "| A | B |", "|---|---|", "| x | y |", "```", "**Next**"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toBe(after);
  });

  it("protects table-looking fenced blocks inside blockquotes", () => {
    const fence = [
      "> ```",
      "> | A | B |",
      "> |---|---|",
      "> ![x](https://e.test/a?x=1&amp;y=2)",
      "> ```",
    ].join("\n");
    expect(formatMSTeamsMarkdown(`${fence}\n\n# Next`, "off")).toBe(`${fence}\n**Next**`);
  });

  it("stops blockquoted raw tables at quote-only lines", () => {
    const before = ["> | A | B |", "> |---|---|", "> | x | y |", ">", "> # Next"].join("\n");
    const after = ["> | A | B |", "> |---|---|", "> | x | y |", "> ", "> **Next**"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toBe(after);
  });

  it("stops quoted raw tables when following content leaves the quote", () => {
    const before = ["> | A | B |", "> |---|---|", "> | x | y |", "# Next"].join("\n");
    const after = ["> | A | B |", "> |---|---|", "> | x | y |", "", "**Next**"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toBe(after);
  });

  it("ends unclosed quoted fences when the quote container ends", () => {
    const before = ["> ```", "> code", "", "| A | B |", "|---|---|", "| x | y |"].join("\n");
    const after = ["> ```", "> code", "> ```", "| A | B |", "|---|---|", "| x | y |"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toBe(after);
  });

  it("preserves quoted text around fenced code", () => {
    const before = ["> Before", ">", "> ```", "> code", "> ```", ">", "> After"].join("\n");
    const output = formatMSTeamsMarkdown(before, "off");
    expect(output).toContain("> Before");
    expect(output).toContain("> ```\n> code\n> ```");
    expect(output).toContain("> After");
    expect(output).not.toContain("```> ");
  });

  it("measures raw table quote depth from leading markers only", () => {
    const table = ["| A > B | State |", "|---|---|", "[x](https://host/a)"].join("\n");
    expect(formatMSTeamsMarkdown(table, "off")).toBe(table);
  });

  it("stops nested quoted tables at quote-only lines", () => {
    const before = ["> > | A | B |", "> > |---|---|", "> > | x | y |", "> >", "> > # Next"].join(
      "\n",
    );
    const output = formatMSTeamsMarkdown(before, "off");
    expect(output).toContain("**Next**");
    expect(output).not.toContain("# Next");
  });

  it("stops quoted tables at quote-only lines with trailing whitespace", () => {
    const before = ["> | A | B |", "> |---|---|", "> | x | y |", ">  ", "> # Next"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toContain("**Next**");
  });

  it("ends list-contained fence state on outdent", () => {
    const before = ["- ```", "  code", "", "| A | B |", "|---|---|", "[x](https://host/a)"].join(
      "\n",
    );
    expect(formatMSTeamsMarkdown(before, "off")).toContain("[x](https://host/a)");
  });

  it("stops raw tables at interrupting headings without a blank line", () => {
    const before = ["| A | B |", "|---|---|", "| x | y |", "# Next"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toContain("**Next**");
  });

  it("does not hide later blocks behind malformed images", () => {
    const output = formatMSTeamsMarkdown("![x](bad\n\n# Next)", "off");
    expect(output).toContain("**Next");
    expect(output).not.toContain("# Next");
  });

  it("does not let nested images complete malformed outer candidates", () => {
    const output = formatMSTeamsMarkdown("![broken\n# Next ![x](https://e.test/x.png)", "off");
    expect(output).toContain("**Next");
    expect(output).toContain("![x](https://e.test/x.png)");
  });

  it("tracks fences opened on list continuation lines", () => {
    const before = [
      "- item",
      "  ```",
      "  code",
      "",
      "| A | B |",
      "|---|---|",
      "[x](https://host/a)",
    ].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toContain("[x](https://host/a)");
  });

  it("rejects backticks in backtick fence info strings", () => {
    const before = ["```bad`", "", "| A | B |", "|---|---|", "[x](https://host/a)"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toContain("[x](https://host/a)");
  });

  it("treats tab-indented fence markers as indented code", () => {
    const before = ["\t```", "", "| A | B |", "|---|---|", "[x](https://host/a)"].join("\n");
    expect(formatMSTeamsMarkdown(before, "off")).toContain("[x](https://host/a)");
  });

  it("treats over-indented quoted fence markers as indented code", () => {
    const before = ["    > ```", "", "> | A | B |", "> |---|---|", "> [x](https://host/a)"].join(
      "\n",
    );
    expect(formatMSTeamsMarkdown(before, "off")).toContain("> [x](https://host/a)");
  });

  it("formats surrounding constructs while preserving a disabled raw table", () => {
    const table = ["| Name | State |", "|---|---|", "| deploy | ready |"].join("\n");
    const before = `# Status\n\n${table}\n\n- next`;
    expect(formatMSTeamsMarkdown(before, "off")).toBe(`**Status**\n\n${table}\n\n• next`);
  });

  const collisionUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const authoredToken = `\u{E000}msteamsformat-${collisionUuid}\u{E001}m0\u{E002}`;
  const encodedToken = `&#xE000;msteamsformat-${collisionUuid}&#xE001;m0&#xE002;`;
  const mention = "@[Alice](29:abc)";
  it.each([
    ["literal text", `${authoredToken} ${mention}`, `${authoredToken} ${mention}`],
    [
      "adjacent bold spans",
      `**\u{E000}msteams**__format-${collisionUuid}\u{E001}m0\u{E002}__ ${mention}`,
      `**${authoredToken}** ${mention}`,
    ],
    ["character references", `${encodedToken} ${mention}`, `${encodedToken} ${mention}`],
  ])("preserves forged placeholders in %s", (_name, source, expected) => {
    const entropy = vi
      .mocked(randomUUID)
      .mockClear()
      .mockImplementation(() => {
        throw new Error("unexpected extra entropy request");
      });
    entropy
      .mockReturnValueOnce(collisionUuid)
      .mockReturnValueOnce("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    try {
      expect(formatMSTeamsMarkdown(source, "off")).toBe(expected);
      expect(entropy).toHaveBeenCalledTimes(2);
    } finally {
      entropy.mockReset();
    }
  });
});
