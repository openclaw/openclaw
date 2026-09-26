import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";

describe("hr (thematic break) spacing", () => {
  // A dash underline belongs to a setext heading; *** can interrupt a paragraph.
  it.each([
    ["renders a standalone break", "---", "───"],
    [
      "lets an asterisk break interrupt a paragraph",
      "Para 1\n***\nPara 2",
      "Para 1\n\n───\n\nPara 2",
    ],
    [
      "separates paragraphs with a dash break",
      "Para 1\n\n---\n\nPara 2",
      "Para 1\n\n───\n\nPara 2",
    ],
    [
      "separates paragraphs with an asterisk break",
      "Para 1\n\n***\n\nPara 2",
      "Para 1\n\n───\n\nPara 2",
    ],
    [
      "separates paragraphs with an underscore break",
      "Para 1\n\n___\n\nPara 2",
      "Para 1\n\n───\n\nPara 2",
    ],
    ["renders consecutive breaks", "---\n---\n---", "───\n\n───\n\n───"],
    ["renders a final break", "Para\n\n---", "Para\n\n───"],
    ["renders an initial break before a blank line", "---\n\nPara", "───\n\nPara"],
    ["keeps a setext heading before a paragraph", "Para 1\n---\nPara 2", "Para 1\n\nPara 2"],
    ["renders an initial break without a blank line", "---\nPara", "───\n\nPara"],
    ["keeps a terminal setext heading", "Para\n---", "Para"],
    [
      "separates two breaks between paragraphs",
      "Para 1\n\n---\n\n---\n\nPara 2",
      "Para 1\n\n───\n\n───\n\nPara 2",
    ],
    [
      "separates mixed break markers",
      "Para 1\n\n***\n\n---\n\n___\n\nPara 2",
      "Para 1\n\n───\n\n───\n\n───\n\nPara 2",
    ],
    [
      "separates three breaks between paragraphs",
      "Para 1\n\n---\n\n---\n\n---\n\nPara 2",
      "Para 1\n\n───\n\n───\n\n───\n\nPara 2",
    ],
    [
      "renders a break owned by a list item",
      "- Item 1\n- ---\n- Item 2",
      "• Item 1\n\n───\n\n• Item 2",
    ],
    [
      "separates a break from a following heading",
      "---\n\n# Heading\n\nPara",
      "───\n\nHeading\n\nPara",
    ],
    [
      "separates a heading from a following break",
      "# Heading\n\n---\n\nPara",
      "Heading\n\n───\n\nPara",
    ],
  ])("%s", (_title, markdown, expected) => {
    const result = markdownToIR(markdown);
    expect(result.text).toBe(expected);
    expect(result.text).not.toMatch(/\n{3,}/);
  });
});
