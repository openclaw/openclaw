import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS,
  truncateForToolResult,
} from "./dynamic-tools.js";

describe("truncateForToolResult", () => {
  it("returns input unchanged when under the cap", () => {
    const text = "short";
    expect(truncateForToolResult(text, 100)).toBe(text);
  });

  it("returns input unchanged when exactly at the cap", () => {
    const text = "x".repeat(100);
    expect(truncateForToolResult(text, 100)).toBe(text);
  });

  it("truncates with a visible suffix when over the cap", () => {
    const text = "x".repeat(200);
    const result = truncateForToolResult(text, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toMatch(/\[truncated to 100 chars\]$/);
  });

  it("preserves the start of the text", () => {
    const text = "important opening text" + "x".repeat(20_000);
    const result = truncateForToolResult(text, 200);
    expect(result.startsWith("important opening text")).toBe(true);
  });

  it("returns input unchanged when maxChars is zero or negative (disabled)", () => {
    const text = "x".repeat(50_000);
    expect(truncateForToolResult(text, 0)).toBe(text);
    expect(truncateForToolResult(text, -1)).toBe(text);
  });

  it("default cap matches the documented constant", () => {
    expect(DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS).toBe(16_000);
  });

  it("at the documented default cap, oversized inputs land within 16k chars", () => {
    const text = "y".repeat(20_000);
    const result = truncateForToolResult(text, DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS);
    expect(result.length).toBeLessThanOrEqual(DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS);
    expect(result).toMatch(/\[truncated to 16000 chars\]$/);
  });
});
