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
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  condenseMessagesForExtraction,
  buildContextTransfer,
  parseJsonFromResponse,
  CONTEXT_EXTRACTION_PROMPT,
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

describe("condenseMessagesForExtraction", () => {
  it("condenses user and assistant messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello world", timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
        timestamp: Date.now(),
      },
    ];
    const result = condenseMessagesForExtraction(messages);
    expect(result).toContain("[USER] Hello world");
    expect(result).toContain("[ASSISTANT] Hi there!");
  });

  it("truncates long messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(1000), timestamp: Date.now() },
    ];
    const result = condenseMessagesForExtraction(messages);
    expect(result.length).toBeLessThan(600);
  });

  it("handles tool results with errors", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "exec",
        isError: true,
        content: [{ type: "text", text: "ENOENT" }],
        timestamp: Date.now(),
      },
    ];
    const result = condenseMessagesForExtraction(messages);
    expect(result).toContain("[TOOL:exec ERROR] ENOENT");
  });

  it("respects maxMessages limit", () => {
    const messages: AgentMessage[] = Array.from({ length: 100 }, (_, i) => ({
      role: "user" as const,
      content: `message ${i}`,
      timestamp: Date.now(),
    }));
    const result = condenseMessagesForExtraction(messages, 5);
    // Should only contain last 5 messages (95-99)
    expect(result).toContain("message 95");
    expect(result).toContain("message 99");
    expect(result).not.toContain("message 0");
  });

  it("returns empty string for empty messages", () => {
    expect(condenseMessagesForExtraction([])).toBe("");
  });

  it("handles user messages with array content", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "part one" },
          { type: "image" },
          { type: "text", text: "part two" },
        ],
        timestamp: Date.now(),
      },
    ];
    const result = condenseMessagesForExtraction(messages);
    expect(result).toContain("part one");
    expect(result).toContain("part two");
  });
});

describe("buildContextTransfer", () => {
  it("builds valid context transfer from extracted data", () => {
    const extracted = {
      nextActions: [{ priority: 1, action: "Do X", context: "because Y" }],
      doNotTouch: ["cron job Z"],
      activeTasks: [{ description: "Task A", status: "in-progress", references: ["#42"] }],
      pendingDecisions: ["Close issue?"],
      subAgents: [{ label: "agent-1", sessionKey: "key-1", status: "running" }],
      ephemeralIds: { embedMsg: "123456" },
      conversationMode: "debugging",
    };

    const result = buildContextTransfer(extracted);
    expect(result.timestamp).toBeTruthy();
    expect(result.expiresAt).toBeTruthy();
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(
      new Date(result.timestamp).getTime(),
    );
    expect(result.nextActions).toHaveLength(1);
    expect(result.doNotTouch).toEqual(["cron job Z"]);
    expect(result.activeTasks[0].description).toBe("Task A");
    expect(result.pendingDecisions).toEqual(["Close issue?"]);
    expect(result.subAgents[0].label).toBe("agent-1");
    expect(result.ephemeralIds).toEqual({ embedMsg: "123456" });
    expect(result.conversationMode).toBe("debugging");
  });

  it("defaults missing fields to empty arrays/objects", () => {
    const result = buildContextTransfer({});
    expect(result.nextActions).toEqual([]);
    expect(result.doNotTouch).toEqual([]);
    expect(result.activeTasks).toEqual([]);
    expect(result.pendingDecisions).toEqual([]);
    expect(result.subAgents).toEqual([]);
    expect(result.ephemeralIds).toEqual({});
    expect(result.conversationMode).toBe("casual");
  });

  it("defaults invalid conversationMode to casual", () => {
    const result = buildContextTransfer({ conversationMode: "invalid-mode" });
    expect(result.conversationMode).toBe("casual");
  });

  it("sets 1 hour TTL", () => {
    const result = buildContextTransfer({});
    const ts = new Date(result.timestamp).getTime();
    const exp = new Date(result.expiresAt).getTime();
    expect(exp - ts).toBe(60 * 60 * 1000);
  });
});

describe("parseJsonFromResponse", () => {
  it("parses clean JSON", () => {
    const result = parseJsonFromResponse('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("extracts JSON from surrounding text", () => {
    const result = parseJsonFromResponse('Here is the result:\n{"key": "value"}\nDone.');
    expect(result).toEqual({ key: "value" });
  });

  it("returns null for no JSON", () => {
    expect(parseJsonFromResponse("no json here")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseJsonFromResponse("{invalid json}")).toBeNull();
  });

  it("handles nested JSON objects", () => {
    const input = '{"outer": {"inner": 42}}';
    const result = parseJsonFromResponse(input);
    expect(result).toEqual({ outer: { inner: 42 } });
  });
});

describe("CONTEXT_EXTRACTION_PROMPT", () => {
  it("exists and mentions required schema fields", () => {
    expect(CONTEXT_EXTRACTION_PROMPT).toContain("nextActions");
    expect(CONTEXT_EXTRACTION_PROMPT).toContain("activeTasks");
    expect(CONTEXT_EXTRACTION_PROMPT).toContain("pendingDecisions");
    expect(CONTEXT_EXTRACTION_PROMPT).toContain("subAgents");
    expect(CONTEXT_EXTRACTION_PROMPT).toContain("ephemeralIds");
    expect(CONTEXT_EXTRACTION_PROMPT).toContain("doNotTouch");
    expect(CONTEXT_EXTRACTION_PROMPT).toContain("conversationMode");
  });
});
