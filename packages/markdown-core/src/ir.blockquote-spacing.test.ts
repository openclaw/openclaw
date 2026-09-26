import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";

describe("blockquote spacing", () => {
  it.each([
    ["separates a quote from a paragraph", "> quote\n\nparagraph", "quote\n\nparagraph"],
    ["separates consecutive quotes", "> first\n\n> second", "first\n\nsecond"],
    ["separates nested quotes", "> outer\n>> inner", "outer\n\ninner"],
    [
      "separates a nested quote from a paragraph",
      "> outer\n>> inner\n\nparagraph",
      "outer\n\ninner\n\nparagraph",
    ],
    [
      "separates deeply nested quotes",
      "> level 1\n>> level 2\n>>> level 3",
      "level 1\n\nlevel 2\n\nlevel 3",
    ],
    ["separates a quote from a heading", "> quote\n\n# Heading", "quote\n\nHeading"],
    ["separates a quote from a list", "> quote\n\n- item", "quote\n\n• item"],
    ["preserves the code block's trailing newline", "> quote\n\n```\ncode\n```", "quote\n\ncode\n"],
    [
      "separates a quote from a thematic break",
      "> quote\n\n---\n\nparagraph",
      "quote\n\n───\n\nparagraph",
    ],
    [
      "preserves paragraphs inside and after a quote",
      "> first paragraph\n>\n> second paragraph\n\nfollowing paragraph",
      "first paragraph\n\nsecond paragraph\n\nfollowing paragraph",
    ],
    ["omits an empty quote", ">\n\nparagraph", "paragraph"],
    ["trims a final quote's separator", "paragraph\n\n> quote", "paragraph\n\nquote"],
    [
      "separates quotes around a paragraph",
      "> first\n\nparagraph\n\n> second",
      "first\n\nparagraph\n\nsecond",
    ],
    ["separates ordinary paragraphs", "paragraph 1\n\nparagraph 2", "paragraph 1\n\nparagraph 2"],
    [
      "separates a list from a paragraph",
      "- item 1\n- item 2\n\nparagraph",
      "• item 1\n• item 2\n\nparagraph",
    ],
    ["separates a heading from a paragraph", "# Heading\n\nparagraph", "Heading\n\nparagraph"],
  ])("%s", (_title, markdown, expected) => {
    const result = markdownToIR(markdown);
    expect(result.text).toBe(expected);
    expect(result.text).not.toContain("\n\n\n");
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

  it("includes the prefix and maintains paragraph spacing", () => {
    const result = markdownToIR("> quote\n\nparagraph", { blockquotePrefix: "> " });
    expect(result.text).toBe("> quote\n\nparagraph");
    expect(result.text).not.toContain("\n\n\n");
  });
});
