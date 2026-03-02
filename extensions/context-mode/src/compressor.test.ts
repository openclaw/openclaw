import { describe, expect, it, beforeEach } from "vitest";
import { compressToolResult, generateRefId, resetRefCounter } from "./compressor.js";
import { DEFAULT_CONFIG, type ContextModeConfig } from "./types.js";

describe("generateRefId", () => {
  beforeEach(() => resetRefCounter());

  it("returns unique IDs", () => {
    const a = generateRefId();
    const b = generateRefId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^ctx_/);
    expect(b).toMatch(/^ctx_/);
  });
});

describe("compressToolResult", () => {
  const config: ContextModeConfig = { ...DEFAULT_CONFIG, summaryHeadChars: 100 };

  beforeEach(() => resetRefCounter());

  it("includes compression header with original size", () => {
    const text = "x".repeat(5000);
    const result = compressToolResult(text, "test_tool", config);
    expect(result.summary).toContain("compressed from");
    expect(result.summary).toContain("5,000");
    expect(result.originalChars).toBe(5000);
  });

  it("includes head of original text", () => {
    const text = "Hello world\nSecond line\n" + "x".repeat(5000);
    const result = compressToolResult(text, "test_tool", config);
    expect(result.summary).toContain("Hello world");
  });

  it("includes retrieval reference", () => {
    const text = "x".repeat(3000);
    const result = compressToolResult(text, "test_tool", config);
    expect(result.summary).toContain(`ref="${result.refId}"`);
    expect(result.summary).toContain("context_retrieve");
  });

  it("extracts URLs from text", () => {
    const text = "Check https://example.com/page for details\n" + "x".repeat(3000);
    const result = compressToolResult(text, "test_tool", config);
    expect(result.summary).toContain("https://example.com/page");
    expect(result.summary).toContain("URLs");
  });

  it("extracts error patterns", () => {
    const text = "Error: connection refused\nOther content\n" + "x".repeat(3000);
    const result = compressToolResult(text, "test_tool", config);
    expect(result.summary).toContain("Errors:");
    expect(result.summary).toContain("connection refused");
  });

  it("summarizes JSON arrays", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      status: "active",
    }));
    const text = JSON.stringify(items);
    const result = compressToolResult(text, "test_tool", config);
    expect(result.summary).toContain("JSON array");
    expect(result.summary).toContain("100 items");
    expect(result.summary).toContain("id");
  });

  it("summarizes JSON objects", () => {
    const obj: Record<string, unknown> = {
      name: "test",
      count: 42,
      items: [1, 2, 3],
      nested: { a: 1, b: 2 },
    };
    const text = JSON.stringify(obj) + "x".repeat(2000);
    // Won't parse as JSON because of trailing x's, so no JSON summary
    const result = compressToolResult(text, "test_tool", config);
    expect(result.summary).toContain("compressed from");
  });

  it("summarizes valid JSON object", () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      obj[`key_${i}`] = `value_${i}_${"x".repeat(100)}`;
    }
    const text = JSON.stringify(obj, null, 2);
    const result = compressToolResult(text, "test_tool", config);
    expect(result.summary).toContain("JSON object");
    expect(result.summary).toContain("20 keys");
  });

  it("includes line count for multiline output", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const result = compressToolResult(text, "test_tool", config);
    expect(result.summary).toContain("Total lines: 200");
  });

  it("produces shorter output than original", () => {
    const text = "a".repeat(10000);
    const result = compressToolResult(text, "test_tool", config);
    expect(result.summary.length).toBeLessThan(text.length);
  });
});
