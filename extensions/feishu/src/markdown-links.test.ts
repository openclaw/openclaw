import { describe, expect, it } from "vitest";
import { normalizeFeishuMarkdownLinks } from "./markdown-links.js";

describe("markdown-links", () => {
  it("wraps bare URL and normalizes fragile URL characters", () => {
    const out = normalizeFeishuMarkdownLinks("Visit https://example.com/a_b(c).");
    expect(out).toBe("Visit [https://example.com/a%5Fb%28c%29](https://example.com/a%5Fb%28c%29).");
  });

  it("normalizes URL chars in existing markdown link destination without double-wrapping", () => {
    const out = normalizeFeishuMarkdownLinks("[site](https://example.com/a_b)");
    expect(out).toBe("[site](https://example.com/a%5Fb)");
  });

  it("keeps inline code untouched and rewrites plain URL", () => {
    const out = normalizeFeishuMarkdownLinks(
      "`https://example.com/a_b` and https://example.com/a_b",
    );
    expect(out).toBe(
      "`https://example.com/a_b` and [https://example.com/a%5Fb](https://example.com/a%5Fb)",
    );
  });

  it("keeps fenced code block untouched", () => {
    const input = "```txt\nhttps://example.com/a_b\n```\nhttps://example.com/a_b";
    const out = normalizeFeishuMarkdownLinks(input);
    expect(out).toBe(
      "```txt\nhttps://example.com/a_b\n```\n[https://example.com/a%5Fb](https://example.com/a%5Fb)",
    );
  });

  it("converts autolink to stable markdown link", () => {
    const out = normalizeFeishuMarkdownLinks("<https://example.com/a_b>");
    expect(out.includes("<https://")).toBe(false);
    expect(out).toContain("example.com");
    expect(out).toContain("%5F");
  });

  it("keeps trailing punctuation outside markdown destination", () => {
    const out = normalizeFeishuMarkdownLinks("See https://example.com/path).");
    expect(out).toBe("See [https://example.com/path](https://example.com/path)).");
  });
});
