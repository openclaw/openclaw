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

  describe("fenced code block preservation (P1 review fix)", () => {
    // The normalizer must NEVER rewrite content inside ``` / ~~~ fenced
    // code blocks. YAML frontmatter, config snippets, and any code that
    // happens to contain a `---` line or blank lines between bullets
    // must pass through verbatim.
    it("preserves a --- line inside a triple-backtick fence", () => {
      const input = "Here is the config:\n```yaml\nfoo: bar\n---\nbaz: qux\n```\nDone.";
      // The fence content is identical; only the surrounding prose is
      // a candidate for transformation (and there is nothing to do here).
      expect(normalizeZalouserOutboundText(input)).toBe(input);
    });

    it("preserves a --- line inside a triple-tilde fence", () => {
      const input = "Snippet:\n~~~yaml\nfoo: bar\n---\nbaz: qux\n~~~\nThanks.";
      expect(normalizeZalouserOutboundText(input)).toBe(input);
    });

    it("preserves blank lines between bullets inside a code fence", () => {
      // A code fence containing what looks like a list with blank lines
      // must keep that exact spacing - it might be a Python list, a
      // YAML sequence with intentional spacing, etc.
      const input = "```python\nfoo = [\n  - a\n\n  - b\n]\n```";
      expect(normalizeZalouserOutboundText(input)).toBe(input);
    });

    it("preserves longer-than-3 backtick fences", () => {
      const input = "````md\n---\nfront: matter\n---\n````";
      expect(normalizeZalouserOutboundText(input)).toBe(input);
    });

    it("still normalizes prose AROUND a code fence", () => {
      const input = "Intro\n\n\n- before\n\n- code follows\n```\n---\n```\n- after\n\n- final";
      const out = normalizeZalouserOutboundText(input);
      // Inside fence: `---` preserved. Outside: list blank lines collapse.
      expect(out).toContain("```\n---\n```");
      expect(out).toContain("- before\n- code follows");
      expect(out).toContain("- after\n- final");
    });

    it("handles an unclosed fence by treating the rest as code (defensive)", () => {
      // If the agent emits an unterminated fence, we should NOT
      // aggressively normalize the tail - the content might be a
      // truncated code block that the user can still read.
      const input = "Intro\n```\nfoo\n---\nbar";
      const out = normalizeZalouserOutboundText(input);
      // The --- inside the open fence stays intact.
      expect(out).toContain("foo\n---\nbar");
    });

    it("does NOT close a backtick fence on a tilde line (opener-aware)", () => {
      // Review finding P2: a different fence marker inside a code block
      // must not flip the fence state. A ~~~ line inside a ``` block is
      // code content, so a following --- must stay intact.
      const input = "```\ncode\n~~~\n---\nstill code\n```\nDone.";
      const out = normalizeZalouserOutboundText(input);
      expect(out).toContain("code\n~~~\n---\nstill code");
    });

    it("does NOT close a fence on a shorter run of the same char", () => {
      // CommonMark: the closer must be at least as long as the opener.
      // A 3-backtick line inside a 4-backtick fence is content, so the
      // ---  after it must remain intact.
      const input = "````\ncode\n```\n---\nmore code\n````\nDone.";
      const out = normalizeZalouserOutboundText(input);
      expect(out).toContain("code\n```\n---\nmore code");
    });

    it("closes on a longer run of the same char (>= opener length)", () => {
      // A 4-backtick closer validly closes a 3-backtick opener; prose
      // after it is normalized again.
      const input = "```\ncode\n````\n\n\n- a\n\n- b";
      const out = normalizeZalouserOutboundText(input);
      expect(out).toContain("code\n````");
      // The list AFTER the closed fence is normalized (blank lines collapsed).
      expect(out).toContain("- a\n- b");
    });
  });

  describe("CRLF / CR line endings (P2 review fix)", () => {
    it("collapses blank lines between bullets with CRLF endings", () => {
      const input = "- a\r\n\r\n- b";
      expect(normalizeZalouserOutboundText(input)).toBe("- a\n- b");
    });

    it("strips an HR line with a trailing CR", () => {
      const input = "before\r\n---\r\nafter";
      expect(normalizeZalouserOutboundText(input)).toBe("before\n\nafter");
    });

    it("handles lone CR (old-mac) line endings", () => {
      const input = "- a\r\r- b";
      expect(normalizeZalouserOutboundText(input)).toBe("- a\n- b");
    });
  });

  describe("plus-sign list markers (P3 review fix)", () => {
    it("collapses blank lines between + bullets", () => {
      const input = "+ first\n\n+ second\n\n+ third";
      expect(normalizeZalouserOutboundText(input)).toBe("+ first\n+ second\n+ third");
    });

    it("collapses a mixed -, *, +, numbered list", () => {
      const input = "- dash\n\n* star\n\n+ plus\n\n1. one";
      expect(normalizeZalouserOutboundText(input)).toBe("- dash\n* star\n+ plus\n1. one");
    });

    it("collapses blank line between prose and a + list", () => {
      const input = "Intro.\n\n\n+ alpha\n+ beta";
      expect(normalizeZalouserOutboundText(input)).toBe("Intro.\n+ alpha\n+ beta");
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
