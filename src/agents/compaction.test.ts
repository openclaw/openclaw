// Covers compaction token splitting and history pruning helpers.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { AssistantMessage, ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import "./test-helpers/agent-session-token-mock.js";

let estimateMessagesTokens: typeof import("./compaction-planning.js").estimateMessagesTokens;
let buildHistoryPrunePlan: typeof import("./compaction-planning.js").buildHistoryPrunePlan;
let buildOversizedFallbackPlan: typeof import("./compaction-planning.js").buildOversizedFallbackPlan;
let buildStageSplitPlan: typeof import("./compaction-planning.js").buildStageSplitPlan;
let buildSummaryChunks: typeof import("./compaction-planning.js").buildSummaryChunks;

beforeAll(async () => {
  vi.resetModules();
  ({
    buildHistoryPrunePlan,
    buildOversizedFallbackPlan,
    buildStageSplitPlan,
    buildSummaryChunks,
    estimateMessagesTokens,
  } = await import("./compaction-planning.js"));
});

function splitMessagesByTokenShare(messages: AgentMessage[], parts: number): AgentMessage[][] {
  const plan = buildStageSplitPlan({
    messages,
    maxChunkTokens: 0,
    parts,
    minMessagesForSplit: 2,
  });
  return plan.mode === "split" ? plan.chunks : [messages];
}

function pruneHistoryForContextShare(params: {
  messages: AgentMessage[];
  maxContextTokens: number;
  maxHistoryShare?: number;
  parts?: number;
}) {
  const plan = buildHistoryPrunePlan({
    messagesToSummarize: params.messages,
    turnPrefixMessages: [],
    tokensBefore: Number.MAX_SAFE_INTEGER,
    contextWindowTokens: params.maxContextTokens,
    maxHistoryShare: params.maxHistoryShare ?? 0.5,
    parts: params.parts,
  });
  if (!plan.pruned) {
    throw new Error("expected history prune planning to run");
  }
  return plan.pruned;
}

function makeMessage(id: number, size: number): AgentMessage {
  return {
    role: "user",
    content: "x".repeat(size),
    timestamp: id,
  };
}

function makeAssistantToolCall(
  timestamp: number,
  toolCallId: string,
  text = "x".repeat(4000),
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  // Tool-call fixtures use real assistant message structure so split/prune
  // helpers preserve tool-call/result adjacency like production transcripts.
  return makeAgentAssistantMessage({
    content: [
      { type: "text", text },
      { type: "toolCall", id: toolCallId, name: "test_tool", arguments: {} },
    ],
    model: "gpt-5.4",
    stopReason,
    timestamp,
  });
}

function makeToolResult(timestamp: number, toolCallId: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "test_tool",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function requireChunkContainingTimestamp(
  parts: AgentMessage[][],
  role: AgentMessage["role"],
  timestamp: number,
): AgentMessage[] {
  const chunk = parts.find((candidate) =>
    candidate.some((message) => message.role === role && message.timestamp === timestamp),
  );
  if (!chunk) {
    throw new Error(`expected ${role} message with timestamp ${timestamp} in a chunk`);
  }
  return chunk;
}

describe("splitMessagesByTokenShare", () => {
  it("keeps repeated-id tool results with their assistant by occurrence", () => {
    const assistant = makeAgentAssistantMessage({
      content: [
        { type: "toolCall", id: "call_reused", name: "first", arguments: {} },
        { type: "toolCall", id: "call_reused", name: "second", arguments: {} },
      ],
      model: "gpt-5.6-luna",
      stopReason: "toolUse",
      timestamp: 2,
    });
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      assistant,
      makeToolResult(3, "call_reused", "first".repeat(400)),
      makeToolResult(4, "call_reused", "second".repeat(400)),
      makeMessage(5, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    const toolChunk = requireChunkContainingTimestamp(parts, "assistant", 2);
    expect(requireChunkContainingTimestamp(parts, "toolResult", 3)).toBe(toolChunk);
    expect(requireChunkContainingTimestamp(parts, "toolResult", 4)).toBe(toolChunk);
  });

  it("does not block splits after aborted tool-call assistants", () => {
    // Aborted tool-use turns have no required result, so they should not pin
    // later messages to the same chunk.
    const messages: AgentMessage[] = [
      makeAssistantToolCall(1, "call_abort", "y".repeat(4000), "aborted"),
      makeMessage(2, 4000),
      makeMessage(3, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    expect(parts.map((chunk) => chunk.map((msg) => msg.timestamp))).toEqual([[1], [2, 3]]);
  });

  it("splits before unfinished tool-call turns that never get a result", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeAssistantToolCall(2, "call_missing"),
      makeMessage(3, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    expect(parts.length).toBe(2);
    expect(parts[0]?.map((m) => m.timestamp)).toEqual([1]);
    expect(parts[1]?.map((m) => m.timestamp)).toEqual([2, 3]);
  });
});

describe("buildSummaryChunks", () => {
  it("keeps displaced and multiple results inside their assistant's atomic summary chunk", () => {
    const assistant = makeAgentAssistantMessage({
      content: [
        { type: "toolCall", id: "call_first", name: "first", arguments: {} },
        { type: "toolCall", id: "call_second", name: "second", arguments: {} },
      ],
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: 2,
    });
    const messages: AgentMessage[] = [
      makeMessage(1, 1000),
      assistant,
      makeToolResult(3, "call_first", "r".repeat(1200)),
      makeMessage(4, 500),
      makeToolResult(5, "call_second", "r".repeat(1200)),
      makeMessage(6, 1000),
    ];

    const chunks = buildSummaryChunks({ messages, maxChunkTokens: 500 });

    expect(chunks.map((chunk) => chunk.map((message) => message.timestamp))).toEqual([
      [1],
      [2, 3, 4, 5],
      [6],
    ]);
  });
});

describe("buildOversizedFallbackPlan", () => {
  it("drops every result in an oversized multi-tool batch while preserving displaced users", () => {
    const displacedUser = makeMessage(3, 100);
    const latestUser = makeMessage(6, 100);
    const assistant = makeAgentAssistantMessage({
      content: [
        { type: "toolCall", id: "call_first", name: "first", arguments: {} },
        { type: "toolCall", id: "call_second", name: "second", arguments: {} },
      ],
      model: "gpt-5.6-luna",
      stopReason: "stop",
      timestamp: 1,
    });
    const plan = buildOversizedFallbackPlan({
      messages: [
        assistant,
        makeToolResult(2, "call_first", "x".repeat(12_000)),
        displacedUser,
        makeToolResult(4, "call_second", "small result"),
        latestUser,
      ],
      contextWindow: 2_000,
    });

    expect(plan.smallMessages).toEqual([displacedUser, latestUser]);
    expect(plan.smallMessages[0]).toBe(displacedUser);
    expect(plan.smallMessages[1]).toBe(latestUser);
  });
});

describe("pruneHistoryForContextShare", () => {
  it("accounts for orphaned tool_results removed from the retained suffix", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeToolResult(2, "missing-call", "orphan-result ".repeat(500)),
      makeMessage(3, 4000),
    ];
    const chunks = splitMessagesByTokenShare(messages, 2);
    const retained = chunks.slice(1).flat();
    const retainedTokens = estimateMessagesTokens(retained);
    const totalTokens = estimateMessagesTokens(messages);
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: Math.ceil(totalTokens),
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(chunks[0]).toContain(messages[0]);
    expect(retained).toContain(messages[1]);
    expect(pruned.messages).not.toContain(messages[1]);
    expect(pruned.droppedMessagesList).toEqual([messages[0], messages[1]]);
    expect(pruned.droppedMessages).toBe(2);
    expect(pruned.droppedTokens).toBe(estimateMessagesTokens([messages[0]!, messages[1]!]));
    expect(retainedTokens).toBeGreaterThan(0);
  });

  it("accounts for synthetic results displaced across retained tool frames", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeAssistantToolCall(2, "call_first"),
      {
        ...makeToolResult(3, "call_first", "synthetic result"),
        details: { openclawSyntheticMissingToolResult: true },
        isError: true,
      },
      makeAssistantToolCall(4, "call_second"),
      makeToolResult(5, "call_first", "real result"),
      makeToolResult(6, "call_second", "second result"),
    ];
    const totalTokens = estimateMessagesTokens(messages);
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: Math.ceil(totalTokens),
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(pruned.messages).not.toContain(messages[2]!);
    expect(pruned.droppedMessagesList.map((message) => message.timestamp)).toEqual([1, 2, 3, 5]);
    expect(pruned.droppedMessages).toBe(pruned.droppedMessagesList.length);
    expect(pruned.droppedTokens).toBe(estimateMessagesTokens(pruned.droppedMessagesList));
  });

  it("does not count normalized retained tool_results as dropped", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeAssistantToolCall(2, "call_read", "result"),
      { ...makeToolResult(3, "call_read", "result"), toolName: "   " },
    ];
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: Math.ceil(estimateMessagesTokens(messages)),
      maxHistoryShare: 0.75,
      parts: 2,
    });

    expect(pruned.droppedMessagesList).not.toContain(messages[2]!);
    expect(pruned.droppedMessages).toBe(pruned.droppedMessagesList.length);
    expect(pruned.messages).not.toContain(messages[2]!);
    expect(pruned.messages.find((message) => message.role === "toolResult")).toMatchObject({
      toolName: "test_tool",
    });
  });
});
