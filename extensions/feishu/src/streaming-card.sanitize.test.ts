import { describe, expect, it } from "vitest";
import { sanitizeCardKitMarkdown } from "./streaming-card.js";

describe("sanitizeCardKitMarkdown", () => {
  it("balances an unclosed fenced code block", () => {
    const input = "```python\nif x < 10:\n    print(x)";
    const out = sanitizeCardKitMarkdown(input);
    expect(out.endsWith("```")).toBe(true);
  });

  it("does not escape angle brackets inside fenced code blocks", () => {
    const input = "intro\n```python\nif x < 10:\n    print(x)\n```\ntrailing";
    const out = sanitizeCardKitMarkdown(input);
    expect(out).toContain("if x < 10:");
    expect(out).not.toContain("if x \\< 10:");
  });

  it("does not escape angle brackets inside inline code spans", () => {
    const input = "use `x < y` to compare";
    const out = sanitizeCardKitMarkdown(input);
    expect(out).toContain("`x < y`");
  });

  it("escapes bare angle brackets outside code", () => {
    const input = "prefix < suffix";
    const out = sanitizeCardKitMarkdown(input);
    expect(out).toContain("\\<");
  });

  it("preserves Feishu mention tags", () => {
    const input = '<at user_id="ou_xxx">name</at> hello';
    const out = sanitizeCardKitMarkdown(input);
    expect(out).toBe(input);
  });

  it("balances unmatched inline backticks outside fences", () => {
    const input = "hello `world";
    const out = sanitizeCardKitMarkdown(input);
    expect(out.endsWith("`")).toBe(true);
  });

  it("ignores escaped backticks when balancing inline spans", () => {
    // Prose explaining markdown escaping: `\`` is a literal backtick, not an
    // unmatched code delimiter. Sanitizer must leave this text alone.
    const input = "To type a backtick write \\` in your message.";
    const out = sanitizeCardKitMarkdown(input);
    expect(out).toBe(input);
  });
});
