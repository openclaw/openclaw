import { describe, expect, it } from "vitest";
import { chunkTextRanges } from "./chunk-text.js";
import { markdownToIR, sliceMarkdownIR } from "./ir.js";
import { convertMarkdownTables } from "./tables.js";

const href = "https://example.com";
function expectWellFormedUtf16(text: string): void {
  expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(text);
}

describe("markdownToIR", () => {
  it("keeps document references and changed options local to each parse", () => {
    const options = { linkify: false };
    expect(
      markdownToIR("[ref]: https://example.org/doc\n\n[ref]", options).links.map(
        (link) => link.href,
      ),
    ).toEqual(["https://example.org/doc"]);
    expect(markdownToIR("[ref] example.org", options).links).toEqual([]);
    options.linkify = true;
    expect(markdownToIR("[ref] example.org", options).links.map((link) => link.href)).toEqual([
      "http://example.org",
    ]);
    options.linkify = false;
    expect(markdownToIR("[ref] example.org", options).links).toEqual([]);
  });

  it("preserves empty slices inside a surrogate pair", () => {
    expect(sliceMarkdownIR(markdownToIR("a😀b"), 2, 2).text).toBe("");
  });

  it("expands a slice starting inside the first of consecutive surrogate pairs", () => {
    expect(sliceMarkdownIR(markdownToIR("😀🐱"), 1, 4).text).toBe("😀🐱");
  });

  it("preserves native fractional and non-finite slice index semantics", () => {
    const ir = markdownToIR("[**abcd**](https://example.com)");
    for (const [start, end] of [
      [-1.5, 4],
      [0, -1.5],
      [1.5, 3.9],
      [Number.NaN, 2],
      [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
    ] as const) {
      const sliced = sliceMarkdownIR(ir, start, end);
      const expected = ir.text.slice(start, end);
      expect(sliced.text).toBe(expected);
      expect(sliced.styles).toEqual([{ start: 0, end: expected.length, style: "bold" }]);
      expect(sliced.links).toEqual([{ start: 0, end: expected.length, href }]);
    }
  });

  it("aligns linked styles when a negative slice start bisects a surrogate pair", () => {
    const ir = markdownToIR("a[**😀b**](https://example.com)");
    const sliced = sliceMarkdownIR(ir, -2, ir.text.length);
    expect(sliced.text).toBe("😀b");
    expectWellFormedUtf16(sliced.text);
    expect(sliced.links).toEqual([{ start: 0, end: 3, href }]);
    expect(sliced.styles).toEqual([{ start: 0, end: 3, style: "bold" }]);
  });

  it("keeps transcript annotations and links aligned with the expanded end", () => {
    const ir = markdownToIR("user[Thu 2026-07-02] **A😀B** [C🐱D](https://example.com)", {
      assistantTranscriptRoleHeaders: true,
    });
    const catStart = ir.text.indexOf("🐱");
    const sliced = sliceMarkdownIR(ir, 0, catStart + 1);
    expect(catStart).toBeGreaterThan(0);
    expect(sliced.text).toBe(ir.text.slice(0, catStart + 2));
    expectWellFormedUtf16(sliced.text);
    expect(sliced.annotations).toEqual(ir.annotations);
    expect(sliced.styles).toEqual(ir.styles);
    expect(sliced.links).toEqual([{ start: ir.links[0]?.start, end: sliced.text.length, href }]);
  });

  it("preserves nested list markers when the final item ends inside a surrogate pair", () => {
    const ir = markdownToIR("- **A😀B**\n  - [x] **C🐱D**");
    const catStart = ir.text.indexOf("🐱");
    const sliced = sliceMarkdownIR(ir, 0, catStart + 1);
    expect(catStart).toBeGreaterThan(0);
    expect(sliced.text).toBe(ir.text.slice(0, catStart + 2));
    expectWellFormedUtf16(sliced.text);
    expect(sliced.listItems).toHaveLength(ir.listItems?.length ?? 0);
    expect(sliced.listItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "bullet", depth: 0 }),
        expect.objectContaining({ kind: "bullet", depth: 1 }),
      ]),
    );
    expect(sliced.styles).toEqual(
      expect.arrayContaining([expect.objectContaining({ style: "bold", end: sliced.text.length })]),
    );
  });

  it("rejoins surrogate-safe transport chunks without duplicating emoji", () => {
    const ir = markdownToIR("a😀b🐱c");
    for (const mode of ["hard", "preferred"] as const) {
      for (const limit of [1, 2, 3, 4]) {
        const chunks = chunkTextRanges(ir.text, { limit, mode }).map(({ start, end }) =>
          sliceMarkdownIR(ir, start, end),
        );
        for (const chunk of chunks) {
          expectWellFormedUtf16(chunk.text);
        }
        expect(chunks.map((chunk) => chunk.text).join("")).toBe(ir.text);
      }
    }
  });

  it.each([
    ["[`name `](https://example.com)", "name ", "code", [{ start: 0, end: 5, href }]],
    ["`   `", "   ", "code", []],
    ["```\nname \n```", "name \n", "code_block", []],
  ] as const)("preserves terminal code payload: %s", (markdown, text, style, links) => {
    expect(markdownToIR(markdown)).toEqual({
      text,
      styles: [{ start: 0, end: text.length, style }],
      links,
    });
  });

  it("projects styled row labels and linked code cells into labeled bullets", () => {
    const ir = markdownToIR(
      "| Name | Value | Other |\n| --- | --- | --- |\n| _Row_ | [` a`](https://example.com) | ` ` |\n| Plain | Data | Last |",
      { tableMode: "bullets" },
    );
    expect(ir.text).toBe("Row\n• Value:  a\n• Other:  \n\nPlain\n• Value: Data\n• Other: Last");
    expect(ir.styles.map(({ start, end, style }) => [style, ir.text.slice(start, end)])).toEqual([
      ["bold", "Row"],
      ["italic", "Row"],
      ["code", " a"],
      ["code", " "],
      ["bold", "Plain"],
    ]);
    expect(ir.links).toEqual([{ start: 13, end: 15, href }]);
  });

  it("preserves all-space code in a single-column bullet", () => {
    expect(markdownToIR("| V |\n| --- |\n| ` ` |", { tableMode: "bullets" })).toEqual({
      text: "• V:  ",
      styles: [{ start: 5, end: 6, style: "code" }],
      links: [],
    });
  });

  it("aligns code tables by visible cell content, discarding inner styles and links", () => {
    const ir = markdownToIR(
      "| | A | BB | Long |\n| --- | --- | --- | --- |\n| **类型** | *👨‍👩‍👧‍👦* | [` abc`](https://example.com) | ~~abc~~ |\n| © | 1️ | `abc ` | A |\n| | 1 | 22 | data |",
      { tableMode: "code" },
    );
    const text = [
      "|      | A   | BB   | Long |",
      "| ---- | --- | ---- | ---- |",
      "| 类型 | 👨‍👩‍👧‍👦  |  abc | abc  |",
      "| ©    | 1️   | abc  | A    |",
      "|      | 1   | 22   | data |",
      "",
    ].join("\n");
    expect(ir).toEqual({
      text,
      styles: [{ start: 0, end: text.length, style: "code_block" }],
      links: [],
    });
  });

  it("fences converted code tables with aligned short and empty columns", () => {
    expect(
      convertMarkdownTables(
        "| | A | BB | Long |\n| --- | --- | --- | --- |\n| | 1 | 22 | data |",
        "code",
      ),
    ).toBe(
      "```\n|     | A   | BB  | Long |\n| --- | --- | --- | ---- |\n|     | 1   | 22  | data |\n```",
    );
  });

  it("emits underline spans only for authored u and ins tags when enabled", () => {
    const ir = markdownToIR("<u>under <ins>nested</ins></u> and __bold__", {
      enableHtmlUnderline: true,
    });
    expect(ir.text).toBe("under nested and bold");
    expect(ir.styles).toEqual([
      { start: 0, end: 12, style: "underline" },
      { start: 17, end: 21, style: "bold" },
    ]);
  });

  it("keeps other HTML lexemes opaque without enabling HTML block parsing", () => {
    const ir = markdownToIR('<div title="<u>">\n**bold**\n<!-- <u> -->\n</div>', {
      enableHtmlUnderline: true,
    });
    expect(ir.text).toBe('<div title="<u>">\nbold\n<!-- <u> -->\n</div>');
    expect(ir.styles).toEqual([{ start: 18, end: 22, style: "bold" }]);
  });
});
