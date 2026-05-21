import { describe, expect, it } from "vitest";
import { normalizeZalouserOutboundText } from "./outbound-format.js";

describe("normalizeZalouserOutboundText", () => {
  describe("identity / passthrough", () => {
    it("returns empty string unchanged", () => {
      expect(normalizeZalouserOutboundText("")).toBe("");
    });

    it("returns plain prose unchanged", () => {
      const text = "Hello, this is a normal message.\nSecond line.";
      expect(normalizeZalouserOutboundText(text)).toBe(text);
    });

    it("returns non-string inputs unchanged", () => {
      // Helper is defensive against callers that forward an arbitrary value.
      expect(normalizeZalouserOutboundText(null as unknown as string)).toBe(null);
      expect(normalizeZalouserOutboundText(undefined as unknown as string)).toBe(undefined);
      expect(normalizeZalouserOutboundText(42 as unknown as string)).toBe(42);
    });
  });

  describe("horizontal-rule stripping", () => {
    // HR removal blanks the rule line itself; the surrounding newlines
    // remain so adjacent paragraphs still get a single blank line of
    // separation (markdown paragraph break). The Zalo client renders
    // \n\n as one blank line, which is what a reader expects.
    it("strips a triple-dash HR on its own line, preserving paragraph break", () => {
      const input = "Before the rule\n---\nAfter the rule";
      expect(normalizeZalouserOutboundText(input)).toBe(
        "Before the rule\n\nAfter the rule",
      );
    });

    it("strips a triple-asterisk HR on its own line", () => {
      const input = "Before\n***\nAfter";
      expect(normalizeZalouserOutboundText(input)).toBe("Before\n\nAfter");
    });

    it("strips longer HR runs (----)", () => {
      const input = "Before\n----\nAfter";
      expect(normalizeZalouserOutboundText(input)).toBe("Before\n\nAfter");
    });

    it("strips an HR with leading + trailing whitespace", () => {
      const input = "Before\n   ---   \nAfter";
      expect(normalizeZalouserOutboundText(input)).toBe("Before\n\nAfter");
    });

    it("does NOT strip a line that has 3 dashes mixed with other content", () => {
      // The HR pattern only matches lines that are NOTHING but dashes.
      const input = "Status: --- not started ---\nNext line";
      expect(normalizeZalouserOutboundText(input)).toBe(input);
    });

    it("does NOT strip two dashes (which is not a markdown HR)", () => {
      const input = "Before\n--\nAfter";
      expect(normalizeZalouserOutboundText(input)).toBe(input);
    });
  });

  describe("blank lines between list items", () => {
    it("collapses one blank line between two bullet items", () => {
      const input = "- first\n\n- second";
      expect(normalizeZalouserOutboundText(input)).toBe("- first\n- second");
    });

    it("collapses two blank lines between two bullet items", () => {
      const input = "- first\n\n\n- second";
      expect(normalizeZalouserOutboundText(input)).toBe("- first\n- second");
    });

    it("collapses blank lines across three or more bullet items", () => {
      const input = "- one\n\n- two\n\n- three";
      expect(normalizeZalouserOutboundText(input)).toBe("- one\n- two\n- three");
    });

    it("collapses blank lines between numbered list items", () => {
      const input = "1. step one\n\n2. step two\n\n3. step three";
      expect(normalizeZalouserOutboundText(input)).toBe(
        "1. step one\n2. step two\n3. step three",
      );
    });

    it("collapses blank lines between asterisk list items", () => {
      const input = "* alpha\n\n* beta";
      expect(normalizeZalouserOutboundText(input)).toBe("* alpha\n* beta");
    });

    it("handles a mix of bullet and numbered styles", () => {
      const input = "1. first numbered\n\n- bullet\n\n2. second numbered";
      const out = normalizeZalouserOutboundText(input);
      // All three group into one block separated by single newlines.
      expect(out).toBe("1. first numbered\n- bullet\n2. second numbered");
    });
  });

  describe("blank lines around the edges of a list", () => {
    it("collapses blank line(s) between prose and the first list item", () => {
      const input = "Intro paragraph.\n\n\n- first item\n- second item";
      expect(normalizeZalouserOutboundText(input)).toBe(
        "Intro paragraph.\n- first item\n- second item",
      );
    });

    it("collapses blank line(s) between the last list item and following prose", () => {
      const input = "- alpha\n- beta\n\n\nClosing paragraph.";
      expect(normalizeZalouserOutboundText(input)).toBe(
        "- alpha\n- beta\nClosing paragraph.",
      );
    });
  });

  describe("hard newline cap", () => {
    it("collapses 3+ consecutive newlines down to 2 in plain prose", () => {
      const input = "Para A\n\n\n\nPara B";
      expect(normalizeZalouserOutboundText(input)).toBe("Para A\n\nPara B");
    });
  });

  describe("idempotency", () => {
    it("is stable: f(f(x)) === f(x) on a representative agent reply", () => {
      const input = [
        "Here are your options:",
        "",
        "---",
        "",
        "- Option A: do thing",
        "",
        "- Option B: do other thing",
        "",
        "",
        "1. step",
        "",
        "2. another step",
        "",
        "---",
        "",
        "Let me know which.",
      ].join("\n");
      const once = normalizeZalouserOutboundText(input);
      const twice = normalizeZalouserOutboundText(once);
      expect(twice).toBe(once);
    });
  });
});
