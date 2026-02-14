import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  truncateToolResultText,
  calculateMaxToolResultChars,
  truncateOversizedToolResultsInMessages,
  isOversizedToolResult,
  sessionLikelyHasOversizedToolResults,
  HARD_MAX_TOOL_RESULT_CHARS,
} from "./tool-result-truncation.js";

function makeToolResult(text: string, toolCallId = "call_1"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeUserMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeAssistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "messages",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    stopReason: "end_turn",
    timestamp: Date.now(),
  } as AgentMessage;
}

describe("truncateToolResultText", () => {
  it("returns text unchanged when under limit", () => {
    const text = "hello world";
    expect(truncateToolResultText(text, 1000)).toBe(text);
  });

  it("truncates text that exceeds limit", () => {
    const text = "a".repeat(10_000);
    const result = truncateToolResultText(text, 5_000);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain("truncated");
  });

  it("preserves at least MIN_KEEP_CHARS (2000)", () => {
    const text = "x".repeat(50_000);
    const result = truncateToolResultText(text, 100); // Even with small limit
    expect(result.length).toBeGreaterThan(2000);
  });

  it("tries to break at newline boundary", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${"x".repeat(50)}`).join("\n");
    const result = truncateToolResultText(lines, 3000);
    // Should contain truncation notice
    expect(result).toContain("truncated");
    // The truncated content should be shorter than the original
    expect(result.length).toBeLessThan(lines.length);
    // Extract the kept content (before the truncation suffix marker)
    const suffixIndex = result.indexOf("\n\n⚠️");
    if (suffixIndex > 0) {
      const keptContent = result.slice(0, suffixIndex);
      // Should end at a newline boundary (i.e., the last char before suffix is a complete line)
      const lastNewline = keptContent.lastIndexOf("\n");
      // The last newline should be near the end (within the last line)
      expect(lastNewline).toBeGreaterThan(keptContent.length - 100);
    }
  });
});

describe("calculateMaxToolResultChars", () => {
  it("scales with context window size", () => {
    const small = calculateMaxToolResultChars(32_000);
    const large = calculateMaxToolResultChars(200_000);
    expect(large).toBeGreaterThan(small);
  });

  it("caps at HARD_MAX_TOOL_RESULT_CHARS for very large windows", () => {
    const result = calculateMaxToolResultChars(2_000_000); // 2M token window
    expect(result).toBeLessThanOrEqual(HARD_MAX_TOOL_RESULT_CHARS);
  });

  it("returns reasonable size for 128K context", () => {
    const result = calculateMaxToolResultChars(128_000);
    // 30% of 128K = 38.4K tokens * 4 chars = 153.6K chars
    expect(result).toBeGreaterThan(100_000);
    expect(result).toBeLessThan(200_000);
  });
});

describe("isOversizedToolResult", () => {
  it("returns false for small tool results", () => {
    const msg = makeToolResult("small content");
    expect(isOversizedToolResult(msg, 200_000)).toBe(false);
  });

  it("returns true for oversized tool results", () => {
    const msg = makeToolResult("x".repeat(500_000));
    expect(isOversizedToolResult(msg, 128_000)).toBe(true);
  });

  it("returns false for non-toolResult messages", () => {
    const msg = makeUserMessage("x".repeat(500_000));
    expect(isOversizedToolResult(msg, 128_000)).toBe(false);
  });
});

describe("truncateOversizedToolResultsInMessages", () => {
  it("returns unchanged messages when nothing is oversized", () => {
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("using tool"),
      makeToolResult("small result"),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      200_000,
    );
    expect(truncatedCount).toBe(0);
    expect(result).toEqual(messages);
  });

  it("truncates oversized tool results", () => {
    const bigContent = "x".repeat(500_000);
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading file"),
      makeToolResult(bigContent),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      128_000,
    );
    expect(truncatedCount).toBe(1);
    const toolResult = result[2] as { content: Array<{ text: string }> };
    expect(toolResult.content[0].text.length).toBeLessThan(bigContent.length);
    expect(toolResult.content[0].text).toContain("truncated");
  });

  it("preserves non-toolResult messages", () => {
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading file"),
      makeToolResult("x".repeat(500_000)),
    ];
    const { messages: result } = truncateOversizedToolResultsInMessages(messages, 128_000);
    expect(result[0]).toBe(messages[0]); // Same reference
    expect(result[1]).toBe(messages[1]); // Same reference
  });

  it("handles multiple oversized tool results", () => {
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading files"),
      makeToolResult("x".repeat(500_000), "call_1"),
      makeToolResult("y".repeat(500_000), "call_2"),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      128_000,
    );
    expect(truncatedCount).toBe(2);
    for (const msg of result.slice(2)) {
      const tr = msg as { content: Array<{ text: string }> };
      expect(tr.content[0].text.length).toBeLessThan(500_000);
    }
  });
});

describe("sessionLikelyHasOversizedToolResults", () => {
  it("returns false when no tool results are oversized", () => {
    const messages = [makeUserMessage("hello"), makeToolResult("small result")];
    expect(
      sessionLikelyHasOversizedToolResults({
        messages,
        contextWindowTokens: 200_000,
      }),
    ).toBe(false);
  });

  it("returns true when a tool result is oversized", () => {
    const messages = [makeUserMessage("hello"), makeToolResult("x".repeat(500_000))];
    expect(
      sessionLikelyHasOversizedToolResults({
        messages,
        contextWindowTokens: 128_000,
      }),
    ).toBe(true);
  });

  it("returns false for empty messages", () => {
    expect(
      sessionLikelyHasOversizedToolResults({
        messages: [],
        contextWindowTokens: 200_000,
      }),
    ).toBe(false);
  });
});
