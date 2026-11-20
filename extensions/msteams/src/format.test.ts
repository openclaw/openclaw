import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { formatMSTeamsMarkdown } from "./format.js";

describe("formatMSTeamsMarkdown", () => {
  it.each([
    [
      "falls task lists back to checkbox text",
      "- [x] shipped\n- [ ] pending",
      "[x] shipped\n[ ] pending",
    ],
    ["preserves escaped mention brackets", String.raw`@[Alice \[Ops\]](29:abc)`],
    ["preserves transport-owned images", "![chart](https://example.com/chart_(final).png)"],
    ["preserves nested image opener text", "![plot](https://example.com/a![b].png)"],
    ["counts escaped backticks for code delimiters", "``a \\` b``"],
    [
      "serializes link destinations with angle brackets",
      "[x](https://host/a)",
      "[x](<https://host/a>)",
    ],
  ])("%s", (_name, before, after = before) => {
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
    const fence = "> ```\n> | A | B |\n> |---|---|\n> ![x](https://e.test/a?x=1&amp;y=2)\n> ```";
    expect(formatMSTeamsMarkdown(`${fence}\n\n# Next`, "off")).toBe(`${fence}\n**Next**`);
  });

  it("preserves quoted text around fenced code", () => {
    const before = "> Before\n>\n> ```\n> code\n> ```\n>\n> After";
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

  it("ends a code block inside a list item before the next item", () => {
    const steps =
      "1. Install:\n   ```bash\n   npm install\n   ```\n2. Run:\n   ```bash\n   npm start\n   ```";
    const output = formatMSTeamsMarkdown(steps, "off");
    expect(output).toBe("1. Install:\n```\nnpm install\n```\n2. Run:\n```\nnpm start\n```");
    const html = new MarkdownIt().render(output);
    expect(html.match(/<pre><code>/g)).toHaveLength(2);
    expect(html).toContain("<li>Run:</li>");
  });

  it("tracks fences opened on list continuation lines", () => {
    const before = "- item\n  ```\n  code\n\n| A | B |\n|---|---|\n[x](https://host/a)";
    expect(formatMSTeamsMarkdown(before, "off")).toContain("[x](https://host/a)");
  });

  it("treats over-indented quoted fence markers as indented code", () => {
    const before = "    > ```\n\n> | A | B |\n> |---|---|\n> [x](https://host/a)";
    expect(formatMSTeamsMarkdown(before, "off")).toContain("> [x](https://host/a)");
  });
});
