// Tests for Feishu post markdown normalization.
import { describe, expect, it } from "vitest";
import { normalizeFeishuPostMarkdownNewlines } from "./post-markdown.js";

describe("normalizeFeishuPostMarkdownNewlines", () => {
  it("upgrades single newlines to paragraph breaks", () => {
    expect(normalizeFeishuPostMarkdownNewlines("line one\nline two\nline three")).toBe(
      "line one\n\nline two\n\nline three",
    );
  });

  it("does not double-process existing blank lines", () => {
    expect(normalizeFeishuPostMarkdownNewlines("paragraph one\n\nparagraph two")).toBe(
      "paragraph one\n\nparagraph two",
    );
  });

  it("preserves fenced code block internals", () => {
    const input = "intro\n```\ncode line one\ncode line two\n```\noutro";
    expect(normalizeFeishuPostMarkdownNewlines(input)).toBe(
      "intro\n\n```\ncode line one\ncode line two\n```\n\noutro",
    );
  });

  it("leaves text without newlines unchanged", () => {
    expect(normalizeFeishuPostMarkdownNewlines("no breaks here")).toBe("no breaks here");
  });

  it("is idempotent", () => {
    const once = normalizeFeishuPostMarkdownNewlines("a\nb\n\nc");
    const twice = normalizeFeishuPostMarkdownNewlines(once);
    expect(twice).toBe(once);
  });
});
