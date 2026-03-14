import { describe, expect, it } from "vitest";
import { markdownToSignalText } from "./format.js";

describe("markdownToSignalText", () => {
  describe("headings visual distinction", () => {
    it("renders headings as bold text", () => {
      const res = markdownToSignalText("# Heading 1");
      expect(res.text).toBe("Heading 1");
      expect(res.styles).toContainEqual({ start: 0, length: 9, style: "BOLD" });
    });

    it("renders h2 headings as bold text", () => {
      const res = markdownToSignalText("## Heading 2");
      expect(res.text).toBe("Heading 2");
      expect(res.styles).toContainEqual({ start: 0, length: 9, style: "BOLD" });
    });

    it("renders h3 headings as bold text", () => {
      const res = markdownToSignalText("### Heading 3");
      expect(res.text).toBe("Heading 3");
      expect(res.styles).toContainEqual({ start: 0, length: 9, style: "BOLD" });
    });
  });

  describe("blockquote visual distinction", () => {
    it("renders blockquotes with a visible prefix", () => {
      const res = markdownToSignalText("> This is a quote");
      // Should have some kind of prefix to distinguish it
      expect(res.text).toMatch(/^[│>]/);
      expect(res.text).toContain("This is a quote");
    });

    it("renders multi-line blockquotes with prefix", () => {
      const res = markdownToSignalText("> Line 1\n> Line 2");
      // Should start with the prefix
      expect(res.text).toMatch(/^[│>]/);
      expect(res.text).toContain("Line 1");
      expect(res.text).toContain("Line 2");
    });
  });

  describe("horizontal rule rendering", () => {
    it("renders horizontal rules as a visible separator", () => {
      const res = markdownToSignalText("Para 1\n\n---\n\nPara 2");
      // Should contain some kind of visual separator like ───
      expect(res.text).toMatch(/[─—-]{3,}/);
    });

    it("renders horizontal rule between content", () => {
      const res = markdownToSignalText("Above\n\n***\n\nBelow");
      expect(res.text).toContain("Above");
      expect(res.text).toContain("Below");
      // Should have a separator
      expect(res.text).toMatch(/[─—-]{3,}/);
    });
  });
});
