import { describe, expect, it } from "vitest";
import { applyConstructFallbacks } from "./construct-fallbacks.js";
import { FormatCapabilityProfile } from "./format-capabilities.js";
import { markdownToIR, sliceMarkdownIR, type MarkdownIR } from "./ir.js";
import { plainIR as makeIR, style, htmlTag } from "./markdown.test-support.js";

const ALL_NATIVE = FormatCapabilityProfile.define({
  mechanism: "markdown",
  chunk: { limit: 4_000, unit: "chars" },
});

function project(ir: MarkdownIR, constructs: Partial<FormatCapabilityProfile["constructs"]>) {
  return applyConstructFallbacks(ir, {
    ...ALL_NATIVE,
    constructs: { ...ALL_NATIVE.constructs, ...constructs },
  });
}

function markdownToTaskIR(markdown: string): MarkdownIR {
  return markdownToIR(markdown, { enableTaskLists: true });
}

it("preserves authored tags through projection and list-marker removal", () => {
  const parsed = markdownToIR("- **<b>x</b>**");
  const native = applyConstructFallbacks(parsed, ALL_NATIVE);
  const stripped = project(parsed, { bulletList: "strip" });

  expect(native.htmlTags).toEqual([htmlTag(2, 5, "<b>", "b"), htmlTag(6, 10, "</b>", "b", true)]);
  expect(stripped.text).toBe("<b>x</b>");
  expect(stripped.styles).toEqual([style(0, 8, "bold")]);
  expect(stripped.htmlTags).toEqual([htmlTag(0, 3, "<b>", "b"), htmlTag(4, 8, "</b>", "b", true)]);
  expect(Object.keys(native)).not.toContain("htmlTags");
  expect(Object.keys(stripped)).not.toContain("htmlTags");
});

describe("applyConstructFallbacks", () => {
  it.each([
    ["heading", "native", makeIR("Title", [style(0, 5, "heading_2")]), ["Title", ["heading_2"], 0]],
    [
      "linkLabel",
      "strip",
      makeIR("docs", [], [{ start: 0, end: 4, href: "https://example.com" }]),
      ["docs", [], 0],
    ],
    [
      "codeLanguage",
      "fallback",
      makeIR("const x = 1;", [{ start: 0, end: 12, style: "code_block", language: "ts" }]),
      ["const x = 1;", ["code_block"], 0],
    ],
  ] as const)("%s: %s", (construct, support, ir, expected) => {
    const actual = project(ir, { [construct]: support });
    expect([
      actual.text,
      actual.styles.map((span) => (span.language ? `${span.style}:${span.language}` : span.style)),
      actual.links.length,
    ]).toEqual(expected);
  });

  it("keeps link suffixes outside surrounding styles", () => {
    const ir = makeIR(
      "see docs now",
      [style(0, 12, "bold")],
      [{ start: 4, end: 8, href: "https://example.com" }],
    );

    expect(project(ir, { linkLabel: "fallback" })).toEqual({
      text: "see docs (https://example.com) now",
      styles: [style(0, 8, "bold"), style(30, 34, "bold")],
      links: [],
    });
  });

  it("merges heading fallback with authored bold and respects stripped bold", () => {
    const ir = makeIR("Title", [style(0, 5, "heading_1"), style(0, 5, "bold")]);
    expect(project(ir, { heading: "fallback" }).styles).toEqual([style(0, 5, "bold")]);
    expect(project(ir, { heading: "fallback", bold: "strip" }).styles).toEqual([]);
  });

  it("does not infer list constructs from literal code or escaped markers", () => {
    const ir = markdownToTaskIR(
      "```\n• [x] command\n1. step\n```\n\n- \\[x] literal\n\n-\n      [x] indented code",
    );
    expect(project(ir, { taskList: "fallback", orderedList: "strip" }).text).toBe(
      "• [x] command\n1. step\n\n• [x] literal\n\n• [x] indented code\n",
    );
  });

  it("recognizes task items nested inside blockquotes", () => {
    for (const markdown of ["> - [x] done", "- > - [x] done"]) {
      const ir = markdownToTaskIR(markdown);
      expect(project(ir, { taskList: "fallback" }).text, markdown).toContain("[x] done");
      expect(project(ir, { taskList: "strip" }).text).not.toContain("[x]");
    }
  });

  it("does not protect checkbox-like links after an earlier list-item block", () => {
    const markdown = "- ---\n\n  [x] done\n\n[x]: https://example.com";
    expect(markdownToIR(markdown, { enableTaskLists: true })).toEqual(markdownToIR(markdown));
  });

  it("clips task-list provenance at partial marker slice boundaries", () => {
    const ir = markdownToTaskIR("- [x] done");
    const prefixOnly = sliceMarkdownIR(ir, 0, 2);
    expect(project(prefixOnly, { taskList: "fallback" }).text).toBe("");
    const insideListMarker = sliceMarkdownIR(ir, 1, ir.text.length);
    expect(project(insideListMarker, { taskList: "strip", bulletList: "strip" }).text).toBe("done");
    for (const start of [3, 4]) {
      const sliced = sliceMarkdownIR(ir, start, ir.text.length);
      const stripped = project(sliced, { taskList: "strip" });
      expect(stripped.text, `start=${start}`).toBe("done");
    }
  });

  it.each([
    ["-", "bulletList"],
    ["1.", "orderedList"],
  ] as const)("clips trailing empty %s provenance", (markdown, construct) => {
    expect(project(markdownToIR(markdown), { [construct]: "strip" }).text).toBe("");
  });
});
