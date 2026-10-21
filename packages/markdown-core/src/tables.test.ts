import MarkdownIt from "markdown-it";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markdownToIR } from "./ir.js";
import { convertMarkdownTables } from "./tables.js";

const markdownToIRWithMetaMock = vi.hoisted(() => vi.fn());
const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
const toHtml = (markdown: string) => new MarkdownIt().render(markdown);

function expectSurroundingSource(before: string, after: string, source = table) {
  const rendered = convertMarkdownTables(before + source + after, "code");
  expect(rendered.startsWith(before)).toBe(true);
  expect(rendered.endsWith(after)).toBe(true);
}

vi.mock("./ir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ir.js")>();
  markdownToIRWithMetaMock.mockImplementation(actual.markdownToIRWithMeta);
  return { ...actual, markdownToIRWithMeta: markdownToIRWithMetaMock };
});

describe("convertMarkdownTables", () => {
  beforeEach(() => {
    markdownToIRWithMetaMock.mockClear();
  });

  it("preserves non-table Markdown source in code mode", () => {
    expectSurroundingSource(
      "# Heading\n\nKeep \\*stars\\* and ``a`b`` literal.\n\n",
      "\n\n> Keep this quote.\n",
    );
  });

  it("preserves escaped literals, code delimiters and reference links in bullet cells", () => {
    const references = '\n\n[docs]: https://example.com/guide "Guide"\n';
    const rendered = convertMarkdownTables(
      "| Name | Value |\n| --- | --- |\n| Entry | \\*stars\\*, ``a`b`` and [manual][docs] |" +
        references,
      "bullets",
    );
    const html = toHtml(rendered);

    expect(html).toContain("*stars*");
    expect(html).not.toContain("<em>stars</em>");
    expect(html).toContain("<code>a`b</code>");
    expect(html).toContain('<a href="https://example.com/guide" title="Guide">manual</a>');
    expect(rendered.endsWith(references)).toBe(true);
  });

  it.each([
    ["single-column rows", "| A |\n| --- |\n| x |\n| y |", "• A: x\n\n• A: y"],
    [
      "empty labeled row",
      "| A | B |\n| --- | --- |\n| x | 1 |\n| | |\n| y | 2 |",
      "**x**\n• B: 1\n\n\n**y**\n• B: 2",
    ],
  ])("preserves existing bullet spacing for %s", (_name, input, expected) => {
    expect(convertMarkdownTables(input, "bullets")).toBe(expected);
    expect(markdownToIR(input, { tableMode: "bullets" }).text).toBe(expected.replaceAll("**", ""));
  });

  it("keeps the existing table recognition for list-like headers", () => {
    const rendered = convertMarkdownTables("- A | B\n---|---\nx|y", "code");

    expect(rendered).toContain("| - A | B   |");
    expect(toHtml(rendered)).toContain("<pre><code>");
  });

  it("preserves escaped pipes and backtick runs in code cells", () => {
    const rendered = convertMarkdownTables(
      "| Name | Value |\n| --- | --- |\n| Entry | a\\|b and ````x```y```` |",
      "code",
    );
    const html = toHtml(rendered);

    expect(html).toContain("a|b");
    expect(html).toContain("x```y");
    expect(rendered.startsWith("````\n")).toBe(true);
  });

  it.each([
    ["blockquote", "> ", "> ", "<blockquote>"],
    ["quoted list", "> - ", ">   ", "<blockquote>\n<ul>"],
  ])("keeps a converted table in its %s container", (_label, first, continuation, container) => {
    const input = first + table.replaceAll("\n", `\n${continuation}`);
    const rendered = convertMarkdownTables(input, "code");
    const html = toHtml(rendered);

    expect(rendered.startsWith(`${first}\`\`\``)).toBe(true);
    expect(html).toContain(container);
    expect(html).toContain("<pre><code>| A   | B   |");
  });

  it("preserves CRLF source around a table", () => {
    expectSurroundingSource(
      "Keep \\*literal\\*.\r\n\r\n",
      "\r\n\r\nAfter.\r\n",
      table.replaceAll("\n", "\r\n"),
    );
  });

  it("leaves table-shaped text inside fences untouched", () => {
    const input = `\`\`\`markdown\n${table}\n\`\`\`\n`;

    expect(convertMarkdownTables(input, "bullets")).toBe(input);
  });

  it("does not parse ordinary text that cannot contain a table", () => {
    const text = "Ordinary iMessage reply with **bold** and _emphasis_.";

    expect(convertMarkdownTables(text, "code")).toBe(text);
    expect(markdownToIRWithMetaMock).not.toHaveBeenCalled();
  });
});
