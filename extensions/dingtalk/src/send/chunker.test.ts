/**
 * Tests for chunker utilities.
 */
import { describe, it, expect } from "vitest";
import {
  chunkText,
  chunkMarkdownText,
  toCleanString,
  normalizeForTextMessage,
} from "./chunker.js";

describe("chunkText", () => {
  it("returns single chunk for text under limit", () => {
    const text = "Hello, world!";
    const result = chunkText(text, 100);
    expect(result).toEqual(["Hello, world!"]);
  });

  it("splits on double newline when possible", () => {
    const text = "Paragraph 1.\n\nParagraph 2.\n\nParagraph 3.";
    const result = chunkText(text, 25);
    expect(result.length).toBeGreaterThan(1);
    expect(result[0]).toBe("Paragraph 1.");
  });

  it("splits on single newline when no double newline found", () => {
    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    const result = chunkText(text, 15);
    expect(result.length).toBeGreaterThan(1);
  });

  it("splits on Chinese punctuation", () => {
    const text = "这是第一句。这是第二句！这是第三句？";
    const result = chunkText(text, 15);
    expect(result.length).toBeGreaterThan(1);
    // Should end on punctuation
    expect(result[0]).toMatch(/[。！？]$/);
  });

  it("splits on English punctuation", () => {
    const text = "First sentence. Second sentence! Third sentence?";
    const result = chunkText(text, 20);
    expect(result.length).toBeGreaterThan(1);
  });

  it("hard cuts when no good break point found", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const result = chunkText(text, 10);
    expect(result.length).toBe(3);
    expect(result[0]).toBe("abcdefghij");
    expect(result[1]).toBe("klmnopqrst");
    expect(result[2]).toBe("uvwxyz");
  });

  it("handles empty string", () => {
    // Empty string returns single-element array with empty string, which gets trimmed
    const result = chunkText("", 100);
    expect(result.length).toBeLessThanOrEqual(1);
  });

  it("handles null/undefined", () => {
    // null/undefined are coerced to empty string
    const resultNull = chunkText(null as unknown as string, 100);
    const resultUndef = chunkText(undefined as unknown as string, 100);
    expect(resultNull.length).toBeLessThanOrEqual(1);
    expect(resultUndef.length).toBeLessThanOrEqual(1);
  });

  it("trims whitespace from chunks", () => {
    const text = "  chunk 1  \n\n  chunk 2  ";
    const result = chunkText(text, 15);
    expect(result[0]).toBe("chunk 1");
  });
});

describe("chunkMarkdownText", () => {
  it("returns single chunk for text under limit", () => {
    const text = "# Hello\n\nWorld";
    const result = chunkMarkdownText(text, 100);
    expect(result).toEqual(["# Hello\n\nWorld"]);
  });

  it("does not break inside code fences", () => {
    const text = "Before code\n\n```javascript\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```\n\nAfter code";
    const result = chunkMarkdownText(text, 30);
    // Code block should not be split
    const codeChunk = result.find((c) => c.includes("```javascript"));
    if (codeChunk) {
      expect(codeChunk).toContain("```");
      // Ensure the code block is complete
      const openCount = (codeChunk.match(/```/g) || []).length;
      expect(openCount % 2).toBe(0); // Should have even number of fences
    }
  });

  it("handles tilde fences", () => {
    const text = "Text\n\n~~~python\nprint('hello')\n~~~\n\nMore text";
    const result = chunkMarkdownText(text, 50);
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles unclosed code fences gracefully", () => {
    const text = "Some text\n\n```javascript\nconst x = 1;\n// no closing fence";
    const result = chunkMarkdownText(text, 100);
    expect(result.length).toBe(1);
  });

  it("handles empty string", () => {
    const result = chunkMarkdownText("", 100);
    expect(result.length).toBeLessThanOrEqual(1);
  });
});

describe("toCleanString", () => {
  it("returns empty string for null", () => {
    expect(toCleanString(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(toCleanString(undefined)).toBe("");
  });

  it("returns string as-is", () => {
    expect(toCleanString("hello")).toBe("hello");
  });

  it("converts number to string", () => {
    expect(toCleanString(42)).toBe("42");
  });

  it("converts object to string", () => {
    expect(toCleanString({ a: 1 })).toBe("{\"a\":1}");
  });
});

describe("normalizeForTextMessage", () => {
  it("converts CRLF to LF", () => {
    const text = "Line 1\r\nLine 2\r\nLine 3";
    expect(normalizeForTextMessage(text)).toBe("Line 1\nLine 2\nLine 3");
  });

  it("preserves LF", () => {
    const text = "Line 1\nLine 2";
    expect(normalizeForTextMessage(text)).toBe("Line 1\nLine 2");
  });

  it("handles null/undefined", () => {
    expect(normalizeForTextMessage(null as unknown as string)).toBe("");
    expect(normalizeForTextMessage(undefined as unknown as string)).toBe("");
  });
});
