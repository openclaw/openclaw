import { describe, it, expect } from "vitest";
import { markdownToIR } from "./ir.js";

describe("hr (thematic break) spacing", () => {
  it.each([
    ["standalone rule", "---", "───"],
    // A dash line directly after prose is a setext heading, so use stars here.
    ["interrupting a paragraph", "Para 1\n***\nPara 2", "Para 1\n\n───\n\nPara 2"],
    ["between paragraphs", "Para 1\n\n---\n\nPara 2", "Para 1\n\n───\n\nPara 2"],
    ["consecutive rules", "---\n---\n---", "───\n\n───\n\n───"],
    ["between list items", "- Item 1\n- ---\n- Item 2", "• Item 1\n\n───\n\n• Item 2"],
    ["before a heading", "---\n\n# Heading\n\nPara", "───\n\nHeading\n\nPara"],
    ["after a heading", "# Heading\n\n---\n\nPara", "Heading\n\n───\n\nPara"],
  ])("renders %s", (_name, markdown, expected) => {
    expect(markdownToIR(markdown).text).toBe(expected);
  });
});
