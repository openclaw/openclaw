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

  it.each([
    ["pre**fix**", "prefix"],
    ["**pre**fix", "prefix"],
    ["pre**fix**post", "prefixpost"],
    ["Today **only**", "Today only"],
  ])("keeps the full row label bold without exposing delimiters in %s", (label, visible) => {
    const rendered = convertMarkdownTables(
      `| Name | Price |\n| --- | --- |\n| ${label} | 4 |`,
      "bullets",
    );
    const { text, styles } = ir.markdownToIR(rendered);
    expect(text).toBe(`${visible}\n• Price: 4`);
    expect(styles).toEqual([{ style: "bold", start: 0, end: visible.length }]);
  });

  it("preserves neighboring emphasis, code, escaped stars, and reference keys in a bold label", () => {
    const references = "\n\n[a**b**]: https://example.org/guide";
    const input =
      "| Name | Price |\n| --- | --- |\n| pre**fix**_now_ " +
      "`**code**` \\* [manual][a**b**] | pre**fix** |" +
      references;
    const rendered = convertMarkdownTables(input, "bullets");
    const projected = ir.markdownToIR(rendered);
    const visibleLabel = "prefixnow **code** * manual";
    expect(projected.text).toBe(`${visibleLabel}\n• Price: prefix`);
    expect(projected.styles).toContainEqual({ style: "bold", start: 0, end: visibleLabel.length });
    expect(projected.styles).toContainEqual({ style: "italic", start: 6, end: 9 });
    expect(toHtml(rendered)).toContain('<a href="https://example.org/guide">manual</a>');
    expect(rendered).toContain("• Price: pre**fix**");
    expect(rendered.endsWith(references)).toBe(true);
  });

  it.each([
    ["pre**fix** 前*斜体：*后", "prefix 前斜体：后", ["斜体："]],
    ["pre**fix**前*斜体：*后", "prefix前斜体：后", ["斜体："]],
    ["pre**fix**前*斜体：*后 tail", "prefix前斜体：后 tail", ["斜体："]],
    ["前*斜体：*后 x**a**_b_", "前斜体：后 xab", ["斜体：", "b"]],
    ["前*斜体：*后 x*old***a**_b_", "前斜体：后 xoldab", ["斜体：", "old", "b"]],
    ["x*old***a**_b_ 前*斜体：*后", "xoldab 前斜体：后", ["old", "b", "斜体："]],
  ] as const)("preserves CJK emphasis and neighboring spans in %s", (label, visible, italic) => {
    const rendered = convertMarkdownTables(
      `| Name | Price |\n| --- | --- |\n| ${label} | 4 |`,
      "bullets",
    );
    expect(rendered).toContain("前*斜体：*后");
    const { text, styles } = ir.markdownToIR(rendered);
    expect(text).toBe(visible + "\n• Price: 4");
    expect(
      styles
        .filter((range) => range.style === "italic")
        .map(({ start, end }) => text.slice(start, end)),
    ).toEqual(italic);
    expect(styles).toContainEqual({ style: "bold", start: 0, end: visible.length });
  });

  it("preserves a bare URL for consumers that linkify after table conversion", () => {
    const url = "https://example.com/a_b";
    const rendered = convertMarkdownTables(
      `| Name | Price |\n| --- | --- |\n| pre**fix** ${url} | 4 |`,
      "bullets",
    );
    expect(new MarkdownIt({ linkify: true }).render(rendered)).toBe(
      `<p><strong>prefix <a href="${url}">${url}</a></strong>\n• Price: 4</p>\n`,
    );
  });

  it.each(["", " tail"])(
    "preserves a parenthesized URL after intraword strong with suffix %j",
    (suffix) => {
      const url = "https://example.com/a_b";
      const rendered = convertMarkdownTables(
        `| Name | Price |\n| --- | --- |\n| pre**fix**(${url})${suffix} | 4 |`,
        "bullets",
      );
      expect(new MarkdownIt({ linkify: true }).render(rendered)).toContain(
        `(<a href="${url}">${url}</a>)${suffix}`,
      );
    },
  );

  it("keeps both italic runs around intraword strong in the row label", () => {
    const rendered = convertMarkdownTables(
      "| Name | Price |\n| --- | --- |\n| x*old***a**_b_ | 4 |",
      "bullets",
    );
    const { text, styles } = ir.markdownToIR(rendered);
    expect(text).toBe("xoldab\n• Price: 4");
    expect(styles.filter(({ style }) => style === "italic")).toEqual([
      { style: "italic", start: 1, end: 4 },
      { style: "italic", start: 5, end: 6 },
    ]);
    expect(styles).toContainEqual({ style: "bold", start: 0, end: 6 });
    expect(styles.every(({ end }) => end <= 6)).toBe(true);
  });

  it.each([
    [
      "~~*left* **center** *right*~~",
      "<s><em>left</em> <strong>center</strong> <em>right</em></s>",
    ],
    [
      "**a**~~[t][id]~~*b*",
      '<strong>a</strong><s><a href="https://example.org/reference">t</a></s><em>b</em>',
    ],
  ])("preserves the original strike and emphasis boundaries of %s", (label, html) => {
    const references = "\n\n[id]: https://example.org/reference";
    const rendered = convertMarkdownTables(
      `| Name | Price |\n| --- | --- |\n| ${label} | 4 |${references}`,
      "bullets",
    );
    expect(rendered).toBe(`**${label}**\n• Price: 4${references}`);
    expect(toHtml(rendered)).toBe(`<p><strong>${html}</strong>\n• Price: 4</p>\n`);
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
