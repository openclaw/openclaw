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
    [
      "falls task lists back to checkbox text",
      "- [x] shipped\n- [ ] pending",
      "[x] shipped\n[ ] pending",
    ],
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
      "includes escaped backticks when choosing inline code delimiters",
      "``a \\` b``",
      "``a \\` b``",
    ],
    [
      "serializes link destinations with angle brackets",
      "[x](https://host/a)",
      "[x](<https://host/a>)",
    ],
  ])("%s", (_name, before, after) => {
    expect(formatMSTeamsMarkdown(before, "off")).toBe(after);
  });

  it.each([["before `  foo  ` after", "before <code> foo </code> after"]])(
    "preserves rendered inline-code whitespace in %j",
    (markdown, html) => {
      const parser = new MarkdownIt();
      // Code-span padding is syntax; compare parsed content without trimming literal spaces.
      expect(parser.renderInline(markdown)).toBe(html);
      expect(parser.renderInline(formatMSTeamsMarkdown(markdown, "off"))).toBe(html);
    },
  );

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

  it("preserves quoted text around fenced code", () => {
    const before = ["> Before", ">", "> ```", "> code", "> ```", ">", "> After"].join("\n");
    const output = formatMSTeamsMarkdown(before, "off");
    expect(output).toContain("> Before");
    expect(output).toContain("> ```\n> code\n> ```");
    expect(output).toContain("> After");
    expect(output).not.toContain("```> ");
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

  it("treats over-indented quoted fence markers as indented code", () => {
    const before = ["    > ```", "", "> | A | B |", "> |---|---|", "> [x](https://host/a)"].join(
      "\n",
    );
    expect(formatMSTeamsMarkdown(before, "off")).toContain("> [x](https://host/a)");
  });

  const collisionUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const authoredToken = `\u{E000}msteamsformat-${collisionUuid}\u{E001}m0\u{E002}`;
  const encodedToken = `&#xE000;msteamsformat-${collisionUuid}&#xE001;m0&#xE002;`;
  const mention = "@[Alice](29:abc)";
  it.each([
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
