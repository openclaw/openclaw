import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionWriteLockModuleMock,
  resetModulesWithSessionWriteLockDoMock,
} from "../../test-utils/session-write-lock-module-mock.js";
import { estimateTextTokensApprox } from "../token-approximation.js";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
} from "../test-helpers/agent-message-fixtures.js";

const acquireSessionWriteLockReleaseMock = vi.hoisted(() => vi.fn(async () => {}));
const acquireSessionWriteLockMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => ({ release: acquireSessionWriteLockReleaseMock })),
);

vi.mock("../session-write-lock.js", () =>
  buildSessionWriteLockModuleMock(
    () => vi.importActual<typeof import("../session-write-lock.js")>("../session-write-lock.js"),
    (params) => acquireSessionWriteLockMock(params),
  ),
);

let truncateToolResultText: typeof import("./tool-result-truncation.js").truncateToolResultText;
let truncateToolResultMessage: typeof import("./tool-result-truncation.js").truncateToolResultMessage;
let truncateToolResultTextToTokens: typeof import("./tool-result-truncation.js").truncateToolResultTextToTokens;
let truncateToolResultMessageToTokens: typeof import("./tool-result-truncation.js").truncateToolResultMessageToTokens;
let calculateMaxToolResultChars: typeof import("./tool-result-truncation.js").calculateMaxToolResultChars;
let getToolResultTextLength: typeof import("./tool-result-truncation.js").getToolResultTextLength;
let getToolResultTextTokenCount: typeof import("./tool-result-truncation.js").getToolResultTextTokenCount;
let truncateOversizedToolResultsInMessages: typeof import("./tool-result-truncation.js").truncateOversizedToolResultsInMessages;
let truncateOversizedToolResultsInSession: typeof import("./tool-result-truncation.js").truncateOversizedToolResultsInSession;
let isOversizedToolResult: typeof import("./tool-result-truncation.js").isOversizedToolResult;
let resolveToolResultMaxTokens: typeof import("./tool-result-truncation.js").resolveToolResultMaxTokens;
let sessionLikelyHasOversizedToolResults: typeof import("./tool-result-truncation.js").sessionLikelyHasOversizedToolResults;
let HARD_MAX_TOOL_RESULT_CHARS: typeof import("./tool-result-truncation.js").HARD_MAX_TOOL_RESULT_CHARS;
let DEFAULT_TOOL_RESULT_MAX_TOKENS: typeof import("./tool-result-truncation.js").DEFAULT_TOOL_RESULT_MAX_TOKENS;
let onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;

async function loadFreshToolResultTruncationModuleForTest() {
  resetModulesWithSessionWriteLockDoMock("../session-write-lock.js", (params) =>
    acquireSessionWriteLockMock(params),
  );
  ({ onSessionTranscriptUpdate } = await import("../../sessions/transcript-events.js"));
  ({
    truncateToolResultText,
    truncateToolResultMessage,
    truncateToolResultTextToTokens,
    truncateToolResultMessageToTokens,
    calculateMaxToolResultChars,
    getToolResultTextLength,
    getToolResultTextTokenCount,
    truncateOversizedToolResultsInMessages,
    truncateOversizedToolResultsInSession,
    isOversizedToolResult,
    resolveToolResultMaxTokens,
    sessionLikelyHasOversizedToolResults,
    HARD_MAX_TOOL_RESULT_CHARS,
    DEFAULT_TOOL_RESULT_MAX_TOKENS,
  } = await import("./tool-result-truncation.js"));
}

let testTimestamp = 1;
const nextTimestamp = () => testTimestamp++;

beforeEach(async () => {
  testTimestamp = 1;
  acquireSessionWriteLockMock.mockClear();
  acquireSessionWriteLockReleaseMock.mockClear();
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

describe("getToolResultTextTokenCount", () => {
  it("estimates tool-result tokens from text content", () => {
    const msg = makeToolResult("x".repeat(4_000));
    expect(getToolResultTextTokenCount(msg)).toBeGreaterThan(900);
  });

  it("counts legacy role=tool string outputs", () => {
    const msg = castAgentMessage({
      role: "tool",
      tool_call_id: "call_1",
      tool_name: "read",
      content: "x".repeat(4_000),
    });
    expect(getToolResultTextTokenCount(msg)).toBeGreaterThan(900);
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

describe("truncateToolResultTextToTokens", () => {
  it("returns text unchanged when under the token cap", () => {
    const text = "hello world";
    expect(truncateToolResultTextToTokens(text, 2_000)).toBe(text);
  });

  it("adds a truncation notice and preserves head and tail context", () => {
    const head = "HEAD\n".repeat(300);
    const middle = "middle-data\n".repeat(1_000);
    const tail = "TAIL\n".repeat(300);
    const text = head + middle + tail;

    const result = truncateToolResultTextToTokens(text, 2_000);
    expect(result).toContain("[Truncated: original");
    expect(result).toContain("Full output available via tool recall.");
    expect(result).toContain("HEAD");
    expect(result).toContain("TAIL");
    expect(result).toContain("middle content omitted");
  });
});

describe("truncateToolResultMessageToTokens", () => {
  it("collapses text blocks into a token-truncated summary block", () => {
    const msg: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [
        { type: "text", text: "x".repeat(8_000) },
        { type: "text", text: "y".repeat(8_000) },
      ],
      isError: false,
      timestamp: nextTimestamp(),
    };

    const result = truncateToolResultMessageToTokens(msg, 2_000);
    expect(result.role).toBe("toolResult");
    expect(getFirstToolResultText(result)).toContain("[Truncated: original");
  });

  it("truncates legacy role=tool string outputs", () => {
    const msg = castAgentMessage({
      role: "tool",
      tool_call_id: "call_1",
      tool_name: "read",
      content: "x".repeat(12_000),
    });

    const result = truncateToolResultMessageToTokens(msg, 2_000);
    expect((result as { content?: unknown }).content).toEqual(
      expect.stringContaining("[Truncated: original"),
    );
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

describe("resolveToolResultMaxTokens", () => {
  it("defaults to 2000 tokens on large windows", () => {
    expect(resolveToolResultMaxTokens(128_000)).toBe(DEFAULT_TOOL_RESULT_MAX_TOKENS);
  });

  it("clamps to half the context window on small models", () => {
    expect(resolveToolResultMaxTokens(1_000)).toBe(500);
  });

  it("honors config overrides when they are lower than the context cap", () => {
    expect(
      resolveToolResultMaxTokens(
        128_000,
        {
          agents: {
            defaults: {
              tokenLimits: {
                toolResultMax: 1_500,
              },
            },
          },
        } as never,
      ),
    ).toBe(1_500);
  });
});

describe("isOversizedToolResult", () => {
  it("returns false for small tool results", () => {
    const msg = makeToolResult("small content");
    expect(isOversizedToolResult(msg, 200_000)).toBe(false);
  });

  it("returns true for oversized tool results", () => {
    const msg = makeToolResult("x".repeat(15_000));
    expect(isOversizedToolResult(msg, 128_000)).toBe(true);
  });

  it("returns false for non-toolResult messages", () => {
    const msg = makeUserMessage("x".repeat(15_000));
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
    const bigContent = "x".repeat(15_000);
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
    expect(text).toContain("[Truncated: original");
  });

  it("preserves non-toolResult messages", () => {
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading file"),
      makeToolResult("x".repeat(15_000)),
    ];
    const { messages: result } = truncateOversizedToolResultsInMessages(messages, 128_000);
    expect(result[0]).toBe(messages[0]); // Same reference
    expect(result[1]).toBe(messages[1]); // Same reference
  });

  it("handles multiple oversized tool results", () => {
    const messages: AgentMessage[] = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading files"),
      makeToolResult("x".repeat(15_000), "call_1"),
      makeToolResult("y".repeat(15_000), "call_2"),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      128_000,
    );
    expect(truncatedCount).toBe(2);
    for (const msg of result.slice(2)) {
      expect(msg.role).toBe("toolResult");
      const text = getFirstToolResultText(msg);
      expect(text.length).toBeLessThan(15_000);
    }
  });
});

describe("truncateOversizedToolResultsInSession", () => {
  it("acquires the session write lock before rewriting oversized tool results", async () => {
    const sessionFile = "/tmp/tool-result-truncation-session.jsonl";
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(makeUserMessage("hello"));
    sessionManager.appendMessage(makeAssistantMessage("reading file"));
    sessionManager.appendMessage(makeToolResult("x".repeat(15_000)));

    const openSpy = vi
      .spyOn(SessionManager, "open")
      .mockReturnValue(sessionManager as unknown as ReturnType<typeof SessionManager.open>);
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);

    try {
      const result = await truncateOversizedToolResultsInSession({
        sessionFile,
        contextWindowTokens: 128_000,
        sessionKey: "agent:main:test",
      });

      expect(result.truncated).toBe(true);
      expect(result.truncatedCount).toBe(1);
      expect(acquireSessionWriteLockMock).toHaveBeenCalledWith({ sessionFile });
      expect(acquireSessionWriteLockReleaseMock).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ sessionFile });

      const branch = sessionManager.getBranch();
      const rewrittenToolResult = branch.find(
        (entry) => entry.type === "message" && entry.message.role === "toolResult",
      );
      expect(rewrittenToolResult?.type).toBe("message");
      if (
        rewrittenToolResult?.type !== "message" ||
        rewrittenToolResult.message.role !== "toolResult"
      ) {
        throw new Error("expected rewritten tool result");
      }
      const rewrittenText = getFirstToolResultText(rewrittenToolResult.message);
      expect(rewrittenText.length).toBeLessThan(15_000);
      expect(rewrittenText).toContain("[Truncated: original");
    } finally {
      cleanup();
      openSpy.mockRestore();
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
    const messages = [makeUserMessage("hello"), makeToolResult("x".repeat(15_000))];
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

describe("truncateToolResultTextToTokens head+tail strategy", () => {
  it("preserves error content at the tail when present", () => {
    const head = "Line 1\n".repeat(500);
    const middle = "data data data\n".repeat(500);
    const tail = "\nError: something failed\nStack trace: at foo.ts:42\n";
    const text = head + middle + tail;
    const result = truncateToolResultTextToTokens(text, 2_000);
    // Should contain both the beginning and the error at the end
    expect(result).toContain("Line 1");
    expect(result).toContain("Error: something failed");
    expect(result).toContain("middle content omitted");
  });

  it("uses simple head truncation when tail has no important content", () => {
    const text = "normal line\n".repeat(1000);
    const result = truncateToolResultTextToTokens(text, 2_000);
    expect(result).toContain("normal line");
    expect(result).toContain("middle content omitted");
    expect(result).toContain("[Truncated: original");
  });

  it("reports the final truncated token count in the notice", () => {
    const text = "z".repeat(16_000);
    const result = truncateToolResultTextToTokens(text, 2_000);
    const match = result.match(/original (\d+) tokens → (\d+) tokens/);
    expect(match).not.toBeNull();
    expect(Number(match?.[2])).toBe(estimateTextTokensApprox(result));
  });
});
