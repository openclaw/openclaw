import MarkdownIt from "markdown-it";
import { describe, expect, it, vi } from "vitest";
import * as ir from "./ir.js";
import { convertMarkdownTables } from "./tables.js";

const markdownToIRWithMetaMock = vi.spyOn(ir, "markdownToIRWithMeta");
const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
const toHtml = (markdown: string) => new MarkdownIt().render(markdown);

function expectCodeTable(input: string, prefix: string, fragments: string[]) {
  const rendered = convertMarkdownTables(input, "code");
  expect(rendered.startsWith(prefix)).toBe(true);
  const html = toHtml(rendered);
  for (const fragment of fragments) {
    expect(html).toContain(fragment);
  }
}

describe("convertMarkdownTables", () => {
  it.each([
    ["\n", "# Heading\n\nKeep \\*stars\\* and ``a`b`` literal.\n\n", "\n\n> Keep this quote.\n"],
    ["\r\n", "Keep \\*literal\\*.\r\n\r\n", "\r\n\r\nAfter.\r\n"],
  ])("preserves surrounding source with %j line endings", (newline, before, after) => {
    const source = before + table.replaceAll("\n", newline) + after;
    const rendered = convertMarkdownTables(source, "code");
    expect([rendered.startsWith(before), rendered.endsWith(after)]).toEqual([true, true]);
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
    ["| A |\n| --- |\n| x |\n| y |", "• A: x\n\n• A: y"],
    ["| A | B |\n| --- | --- |\n| x | 1 |\n| | |\n| y | 2 |", "**x**\n• B: 1\n\n\n**y**\n• B: 2"],
  ])("preserves existing bullet spacing: %s", (input, expected) => {
    expect(convertMarkdownTables(input, "bullets")).toBe(expected);
    expect(ir.markdownToIR(input, { tableMode: "bullets" }).text).toBe(
      expected.replaceAll("**", ""),
    );
  });

  it("keeps the existing table recognition for list-like headers", () => {
    const rendered = convertMarkdownTables("- A | B\n---|---\nx|y", "code");
    expect(rendered).toContain("| - A | B   |");
    expect(toHtml(rendered)).toContain("<pre><code>");
  });
  it("preserves escaped pipes and backtick runs in code cells", () => {
    expectCodeTable(
      "| Name | Value |\n| --- | --- |\n| Entry | a\\|b and ````x```y```` |",
      "````\n",
      ["a|b", "x```y"],
    );
  });

  it.each([
    ["blockquote", "> ", "> ", "<blockquote>"],
    ["quoted list", "> - ", ">   ", "<blockquote>\n<ul>"],
  ])("keeps a converted table in its %s container", (_label, first, continuation, container) => {
    expectCodeTable(first + table.replaceAll("\n", `\n${continuation}`), `${first}\`\`\``, [
      container,
      "<pre><code>| A   | B   |",
    ]);
  });

  it("leaves table-shaped text inside fences untouched", () => {
    const input = `\`\`\`markdown\n${table}\n\`\`\`\n`;
    expect(convertMarkdownTables(input, "bullets")).toBe(input);
  });

  it("does not parse ordinary text that cannot contain a table", () => {
    markdownToIRWithMetaMock.mockClear();
    const text = "Ordinary iMessage reply with **bold** and _emphasis_.";

    expect(convertMarkdownTables(text, "code")).toBe(text);
    expect(markdownToIRWithMetaMock).not.toHaveBeenCalled();
  });
});
