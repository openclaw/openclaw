import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";

let truncateToolResultText: typeof import("./tool-result-truncation.js").truncateToolResultText;
let truncateToolResultMessage: typeof import("./tool-result-truncation.js").truncateToolResultMessage;
let calculateMaxToolResultChars: typeof import("./tool-result-truncation.js").calculateMaxToolResultChars;
let getToolResultTextLength: typeof import("./tool-result-truncation.js").getToolResultTextLength;
let truncateOversizedToolResultsInMessages: typeof import("./tool-result-truncation.js").truncateOversizedToolResultsInMessages;
let isOversizedToolResult: typeof import("./tool-result-truncation.js").isOversizedToolResult;
let DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS: typeof import("./tool-result-truncation.js").DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
let HARD_MAX_TOOL_RESULT_CHARS: typeof import("./tool-result-truncation.js").HARD_MAX_TOOL_RESULT_CHARS;

async function loadFreshToolResultTruncationModuleForTest() {
  ({
    truncateToolResultText,
    truncateToolResultMessage,
    calculateMaxToolResultChars,
    getToolResultTextLength,
    truncateOversizedToolResultsInMessages,
    isOversizedToolResult,
    DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
    HARD_MAX_TOOL_RESULT_CHARS,
  } = await import("./tool-result-truncation.js"));
}

let testTimestamp = 1;
const nextTimestamp = () => testTimestamp++;

beforeEach(async () => {
  testTimestamp = 1;
  await loadFreshToolResultTruncationModuleForTest();
});

function makeToolResult(text: string, toolCallId = "call_1"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: nextTimestamp(),
  };
}

function makeUserMessage(text: string): UserMessage {
  return {
    role: "user",
    content: text,
    timestamp: nextTimestamp(),
  };
}

function makeAssistantMessage(text: string): AssistantMessage {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text }],
    model: "gpt-5.2",
    stopReason: "stop",
    timestamp: nextTimestamp(),
  });
}

function getFirstToolResultText(message: AgentMessage | ToolResultMessage): string {
  if (message.role !== "toolResult") {
    return "";
  }
  const firstBlock = message.content[0];
  return firstBlock && "text" in firstBlock ? firstBlock.text : "";
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

  it("supports custom suffix and min keep chars", () => {
    const text = "x".repeat(5_000);
    const result = truncateToolResultText(text, 300, {
      suffix: "\n\n[custom-truncated]",
      minKeepChars: 250,
    });
    expect(result).toContain("[custom-truncated]");
    expect(result.length).toBeGreaterThan(250);
  });
});

describe("getToolResultTextLength", () => {
  it("sums all text blocks in tool results", () => {
    const msg: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      isError: false,
      content: [
        { type: "text", text: "abc" },
        { type: "image", data: "x", mimeType: "image/png" },
        { type: "text", text: "12345" },
      ],
      timestamp: nextTimestamp(),
    };

    expect(getToolResultTextLength(msg)).toBe(8);
  });

  it("returns zero for non-toolResult messages", () => {
    expect(getToolResultTextLength(makeAssistantMessage("hello"))).toBe(0);
  });
});

describe("truncateToolResultMessage", () => {
  it("truncates with a custom suffix", () => {
    const msg: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(50_000) }],
      isError: false,
      timestamp: nextTimestamp(),
    };

    const result = truncateToolResultMessage(msg, 10_000, {
      suffix: "\n\n[persist-truncated]",
      minKeepChars: 2_000,
    });
    expect(result.role).toBe("toolResult");
    if (result.role !== "toolResult") {
      throw new Error("expected toolResult");
    }
    expect(getFirstToolResultText(result)).toContain("[persist-truncated]");
  });
});

describe("calculateMaxToolResultChars", () => {
  it("scales with context window size", () => {
    const small = calculateMaxToolResultChars(32_000);
    const large = calculateMaxToolResultChars(200_000);
    expect(large).toBeGreaterThan(small);
  });

  it("exports the live cap through both constant names", () => {
    expect(DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS).toBe(40_000);
    expect(HARD_MAX_TOOL_RESULT_CHARS).toBe(DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS);
  });

  it("caps at HARD_MAX_TOOL_RESULT_CHARS for very large windows", () => {
    const result = calculateMaxToolResultChars(2_000_000); // 2M token window
    expect(result).toBeLessThanOrEqual(HARD_MAX_TOOL_RESULT_CHARS);
  });

  it("caps 128K contexts at the live tool-result ceiling", () => {
    const result = calculateMaxToolResultChars(128_000);
    expect(result).toBe(DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS);
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
    const messages: AgentMessage[] = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading file"),
      makeToolResult(bigContent),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      128_000,
    );
    expect(truncatedCount).toBe(1);
    const toolResult = result[2];
    expect(toolResult?.role).toBe("toolResult");
    const text = toolResult ? getFirstToolResultText(toolResult) : "";
    expect(text.length).toBeLessThan(bigContent.length);
    expect(text).toContain("truncated");
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
    const messages: AgentMessage[] = [
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
      expect(msg.role).toBe("toolResult");
      const text = getFirstToolResultText(msg);
      expect(text.length).toBeLessThan(500_000);
    }
  });
});

describe("truncateToolResultText head+tail strategy", () => {
  it("preserves error content at the tail when present", () => {
    const head = "Line 1\n".repeat(500);
    const middle = "data data data\n".repeat(500);
    const tail = "\nError: something failed\nStack trace: at foo.ts:42\n";
    const text = head + middle + tail;
    const result = truncateToolResultText(text, 5000);
    // Should contain both the beginning and the error at the end
    expect(result).toContain("Line 1");
    expect(result).toContain("Error: something failed");
    expect(result).toContain("middle content omitted");
  });

  it("uses simple head truncation when tail has no important content", () => {
    const text = "normal line\n".repeat(1000);
    const result = truncateToolResultText(text, 5000);
    expect(result).toContain("normal line");
    expect(result).not.toContain("middle content omitted");
    expect(result).toContain("truncated");
  });
});
