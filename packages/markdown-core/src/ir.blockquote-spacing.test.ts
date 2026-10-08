import { describe, it, expect } from "vitest";
import { markdownToIR } from "./ir.js";

describe("blockquote spacing", () => {
  // Container closings must not add a third newline to their child's separator.
  it.each([
    ["consecutive quotes", "> first\n\n> second", "first\n\nsecond"],
    ["deeply nested quotes", "> level 1\n>> level 2\n>>> level 3", "level 1\n\nlevel 2\n\nlevel 3"],
    ["following heading", "> quote\n\n# Heading", "quote\n\nHeading"],
    ["following list", "> quote\n\n- item", "quote\n\n• item"],
    ["following code block", "> quote\n\n```\ncode\n```", "quote\n\ncode\n"],
    ["following horizontal rule", "> quote\n\n---\n\nparagraph", "quote\n\n───\n\nparagraph"],
    [
      "multiple paragraphs",
      "> first paragraph\n>\n> second paragraph\n\nfollowing paragraph",
      "first paragraph\n\nsecond paragraph\n\nfollowing paragraph",
    ],
    ["empty quote", ">\n\nparagraph", "paragraph"],
    [
      "interleaved quotes and prose",
      "> first\n\nparagraph\n\n> second",
      "first\n\nparagraph\n\nsecond",
    ],
  ])("preserves spacing for %s", (_name, markdown, expected) => {
    expect(markdownToIR(markdown).text).toBe(expected);
  });

  it("excludes the trailing paragraph separator from the blockquote span", () => {
    expect(markdownToIR("> `gpt`\n\nbody")).toEqual({
      text: "gpt\n\nbody",
      styles: [
        { start: 0, end: 3, style: "blockquote" },
        { start: 0, end: 3, style: "code" },
      ],
      links: [],
    });
  });

  it("includes the configured prefix without adding spacing", () => {
    expect(markdownToIR("> quote\n\nparagraph", { blockquotePrefix: "> " }).text).toBe(
      "> quote\n\nparagraph",
    );
  });
});
