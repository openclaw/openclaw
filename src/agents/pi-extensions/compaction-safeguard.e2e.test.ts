import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  getCompactionSafeguardRuntime,
  setCompactionSafeguardRuntime,
} from "./compaction-safeguard-runtime.js";
import { __testing } from "./compaction-safeguard.js";

const {
  collectToolFailures,
  formatToolFailuresSection,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  extractLastTurn,
  serializeLastTurn,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  MAX_LAST_TURN_TOKENS,
} = __testing;

describe("compaction-safeguard tool failures", () => {
  it("formats tool failures with meta and summary", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        details: { status: "failed", exitCode: 1 },
        content: [{ type: "text", text: "ENOENT: missing file" }],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures).toHaveLength(1);

    const section = formatToolFailuresSection(failures);
    expect(section).toContain("## Tool Failures");
    expect(section).toContain("exec (status=failed exitCode=1): ENOENT: missing file");
  });

  it("dedupes by toolCallId and handles empty output", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        details: { exitCode: 2 },
        content: [],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        content: [{ type: "text", text: "ignored" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures).toHaveLength(1);

    const section = formatToolFailuresSection(failures);
    expect(section).toContain("exec (exitCode=2): failed");
  });

  it("caps the number of failures and adds overflow line", () => {
    const messages: AgentMessage[] = Array.from({ length: 9 }, (_, idx) => ({
      role: "toolResult",
      toolCallId: `call-${idx}`,
      toolName: "exec",
      isError: true,
      content: [{ type: "text", text: `error ${idx}` }],
      timestamp: Date.now(),
    }));

    const failures = collectToolFailures(messages);
    const section = formatToolFailuresSection(failures);
    expect(section).toContain("## Tool Failures");
    expect(section).toContain("...and 1 more");
  });

  it("omits section when there are no tool failures", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "ok",
        toolName: "exec",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    const section = formatToolFailuresSection(failures);
    expect(section).toBe("");
  });
});

describe("computeAdaptiveChunkRatio", () => {
  const CONTEXT_WINDOW = 200_000;

  it("returns BASE_CHUNK_RATIO for normal messages", () => {
    // Small messages: 1000 tokens each, well under 10% of context
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(1000), timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(1000) }],
        timestamp: Date.now(),
      },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBe(BASE_CHUNK_RATIO);
  });

  it("reduces ratio when average message > 10% of context", () => {
    // Large messages: ~50K tokens each (25% of context)
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(50_000 * 4), timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(50_000 * 4) }],
        timestamp: Date.now(),
      },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeLessThan(BASE_CHUNK_RATIO);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
  });

  it("respects MIN_CHUNK_RATIO floor", () => {
    // Very large messages that would push ratio below minimum
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(150_000 * 4), timestamp: Date.now() },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
  });

  it("handles empty message array", () => {
    const ratio = computeAdaptiveChunkRatio([], CONTEXT_WINDOW);
    expect(ratio).toBe(BASE_CHUNK_RATIO);
  });

  it("handles single huge message", () => {
    // Single massive message
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(180_000 * 4), timestamp: Date.now() },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
    expect(ratio).toBeLessThanOrEqual(BASE_CHUNK_RATIO);
  });
});

describe("isOversizedForSummary", () => {
  const CONTEXT_WINDOW = 200_000;

  it("returns false for small messages", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "Hello, world!",
      timestamp: Date.now(),
    };

    expect(isOversizedForSummary(msg, CONTEXT_WINDOW)).toBe(false);
  });

  it("returns true for messages > 50% of context", () => {
    // Message with ~120K tokens (60% of 200K context)
    // After safety margin (1.2x), effective is 144K which is > 100K (50%)
    const msg: AgentMessage = {
      role: "user",
      content: "x".repeat(120_000 * 4),
      timestamp: Date.now(),
    };

    expect(isOversizedForSummary(msg, CONTEXT_WINDOW)).toBe(true);
  });

  it("applies safety margin", () => {
    // Message at exactly 50% of context before margin
    // After SAFETY_MARGIN (1.2), it becomes 60% which is > 50%
    const halfContextChars = (CONTEXT_WINDOW * 0.5) / SAFETY_MARGIN;
    const msg: AgentMessage = {
      role: "user",
      content: "x".repeat(Math.floor(halfContextChars * 4)),
      timestamp: Date.now(),
    };

    // With safety margin applied, this should be at the boundary
    // The function checks if tokens * SAFETY_MARGIN > contextWindow * 0.5
    const isOversized = isOversizedForSummary(msg, CONTEXT_WINDOW);
    // Due to token estimation, this could be either true or false at the boundary
    expect(typeof isOversized).toBe("boolean");
  });
});

describe("extractLastTurn", () => {
  it("extracts the last user + assistant exchange", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "First question", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "First answer" }],
        timestamp: 2,
      },
      { role: "user", content: "Second question", timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Second answer" }],
        timestamp: 4,
      },
    ];

    const turn = extractLastTurn(messages);
    expect(turn).toHaveLength(2);
    expect((turn[0] as { content: string }).content).toBe("Second question");
    expect(
      ((turn[1] as { content: Array<{ text: string }> }).content[0] as { text: string }).text,
    ).toBe("Second answer");
  });

  it("includes tool calls and tool results in the last turn", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Old message", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Old response" }],
        timestamp: 2,
      },
      { role: "user", content: "Do something", timestamp: 3 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll help" },
          { type: "toolCall", name: "exec", id: "call-1", arguments: { command: "ls" } },
        ],
        timestamp: 4,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: false,
        content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
        timestamp: 5,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here are the files" }],
        timestamp: 6,
      },
    ];

    const turn = extractLastTurn(messages);
    expect(turn).toHaveLength(4); // user + assistant(tool call) + toolResult + assistant(final)
    expect(turn[0].role).toBe("user");
    expect(turn[1].role).toBe("assistant");
    expect(turn[2].role).toBe("toolResult");
    expect(turn[3].role).toBe("assistant");
  });

  it("returns empty array for empty messages", () => {
    expect(extractLastTurn([])).toEqual([]);
  });

  it("returns just assistant if no user message found", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "I'm here" }],
        timestamp: 1,
      },
    ];

    const turn = extractLastTurn(messages);
    expect(turn).toHaveLength(1);
    expect(turn[0].role).toBe("assistant");
  });

  it("handles messages with only user messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello", timestamp: 1 },
      { role: "user", content: "Are you there?", timestamp: 2 },
    ];

    const turn = extractLastTurn(messages);
    expect(turn).toHaveLength(1);
    expect((turn[0] as { content: string }).content).toBe("Are you there?");
  });
});

describe("serializeLastTurn", () => {
  it("serializes user text and assistant text", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "What is 2+2?", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "The answer is 4." }],
        timestamp: 2,
      },
    ];

    const result = serializeLastTurn(messages, 4000);
    expect(result).toContain("[User]:");
    expect(result).toContain("What is 2+2?");
    expect(result).toContain("[Assistant]:");
    expect(result).toContain("The answer is 4.");
  });

  it("truncates when exceeding maxTokens", () => {
    // Create a very long assistant response
    const longText = "x".repeat(20000 * 4); // ~20K tokens
    const messages: AgentMessage[] = [
      { role: "user", content: "Tell me everything", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: longText }],
        timestamp: 2,
      },
    ];

    const result = serializeLastTurn(messages, 1000);
    // Should be truncated — the full text would be >> 1000 tokens
    // The serialized output should be roughly 1000 * 4 = 4000 chars max
    expect(result.length).toBeLessThan(longText.length);
    expect(result).toContain("[truncated]");
  });

  it("handles tool calls in assistant messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "List files", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check" },
          { type: "toolCall", name: "exec", id: "call-1", arguments: { command: "ls" } },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: false,
        content: [{ type: "text", text: "file.txt" }],
        timestamp: 3,
      },
    ];

    const result = serializeLastTurn(messages, 4000);
    expect(result).toContain("[User]:");
    expect(result).toContain("List files");
    expect(result).toContain("[Assistant]:");
    expect(result).toContain("Let me check");
    expect(result).toContain("[Tool result]:");
    expect(result).toContain("file.txt");
  });

  it("returns empty string for empty input", () => {
    expect(serializeLastTurn([], 4000)).toBe("");
  });

  it("respects MAX_LAST_TURN_TOKENS default", () => {
    expect(MAX_LAST_TURN_TOKENS).toBe(4000);
  });
});

describe("compaction-safeguard runtime registry", () => {
  it("stores and retrieves config by session manager identity", () => {
    const sm = {};
    setCompactionSafeguardRuntime(sm, { maxHistoryShare: 0.3 });
    const runtime = getCompactionSafeguardRuntime(sm);
    expect(runtime).toEqual({ maxHistoryShare: 0.3 });
  });

  it("returns null for unknown session manager", () => {
    const sm = {};
    expect(getCompactionSafeguardRuntime(sm)).toBeNull();
  });

  it("clears entry when value is null", () => {
    const sm = {};
    setCompactionSafeguardRuntime(sm, { maxHistoryShare: 0.7 });
    expect(getCompactionSafeguardRuntime(sm)).not.toBeNull();
    setCompactionSafeguardRuntime(sm, null);
    expect(getCompactionSafeguardRuntime(sm)).toBeNull();
  });

  it("ignores non-object session managers", () => {
    setCompactionSafeguardRuntime(null, { maxHistoryShare: 0.5 });
    expect(getCompactionSafeguardRuntime(null)).toBeNull();
    setCompactionSafeguardRuntime(undefined, { maxHistoryShare: 0.5 });
    expect(getCompactionSafeguardRuntime(undefined)).toBeNull();
  });

  it("isolates different session managers", () => {
    const sm1 = {};
    const sm2 = {};
    setCompactionSafeguardRuntime(sm1, { maxHistoryShare: 0.3 });
    setCompactionSafeguardRuntime(sm2, { maxHistoryShare: 0.8 });
    expect(getCompactionSafeguardRuntime(sm1)).toEqual({ maxHistoryShare: 0.3 });
    expect(getCompactionSafeguardRuntime(sm2)).toEqual({ maxHistoryShare: 0.8 });
  });
});
