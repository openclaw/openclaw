import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";

describe("markdownToIR tableMode bullets", () => {
  it("handles table with multiple columns", () => {
    const md = `
| Feature | SQLite | Postgres |
|---------|--------|----------|
| Speed   | Fast   | Medium   |
| Scale   | Small  | Large    |
`.trim();

    const ir = markdownToIR(md, { tableMode: "bullets" });

    expect(ir.text).toContain("Speed");
    expect(ir.text).toContain("Scale");
    expect(ir.text).toContain("• SQLite: Fast");
    expect(ir.text).toContain("• Postgres: Medium");
    expect(ir.text).toContain("• SQLite: Small");
    expect(ir.text).toContain("• Postgres: Large");
  });

  it("leaves table syntax untouched by default", () => {
    const md = `
| A | B |
|---|---|
| 1 | 2 |
`.trim();

    const ir = markdownToIR(md);

    expect(ir.text).toContain("| A | B |");
    expect(ir.text).toContain("| 1 | 2 |");
    expect(ir.text).not.toContain("•");
    expect(ir.styles.map((style) => style.style)).not.toContain("code_block");
  });

  it("bolds row labels in bullets mode", () => {
    const md = `
| Name | Value |
|------|-------|
| Row1 | Data1 |
`.trim();

    const ir = markdownToIR(md, { tableMode: "bullets" });

    expect(
      ir.styles
        .filter((style) => style.style === "bold")
        .map((style) => ir.text.slice(style.start, style.end)),
    ).toContain("Row1");
  });

  it("preserves inline styles and links in bullets mode", () => {
    const md = `
| Name | Value |
|------|-------|
| _Row_ | [Link](https://example.com) |
`.trim();

    const ir = markdownToIR(md, { tableMode: "bullets" });

    expect(
      ir.styles
        .filter((style) => style.style === "italic")
        .map((style) => ir.text.slice(style.start, style.end)),
    ).toContain("Row");
    expect(ir.links.map((link) => link.href)).toContain("https://example.com");
  });

  it.each([
    {
      name: "one-space code",
      cell: "` `",
      expected: {
        text: "• V:  ",
        styles: [{ start: 5, end: 6, style: "code" }],
        links: [],
      },
    },
    {
      name: "linked code-leading space",
      cell: "[` a`](https://example.com)",
      expected: {
        text: "• V:  a",
        styles: [{ start: 5, end: 7, style: "code" }],
        links: [{ start: 5, end: 7, href: "https://example.com" }],
      },
    },
  ])("preserves code-owned cell edges: $name", ({ cell, expected }) => {
    expect(markdownToIR(`| V |\n| --- |\n| ${cell} |`, { tableMode: "bullets" })).toEqual(expected);
  });
});
