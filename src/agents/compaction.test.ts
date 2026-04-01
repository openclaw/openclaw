import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  estimateMessagesTokens,
  pruneHistoryForContextShare,
  splitMessagesByTokenShare,
} from "./compaction.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

function makeMessage(id: number, size: number): AgentMessage {
  return {
    role: "user",
    content: "x".repeat(size),
    timestamp: id,
  };
}

function makeMessages(count: number, size: number): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => makeMessage(index + 1, size));
}

function makeAssistantToolCall(
  timestamp: number,
  toolCallId: string,
  text = "x".repeat(4000),
): AssistantMessage {
  return makeAgentAssistantMessage({
    content: [
      { type: "text", text },
      { type: "toolCall", id: toolCallId, name: "test_tool", arguments: {} },
    ],
    model: "gpt-5.4",
    stopReason: "stop",
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

function pruneLargeSimpleHistory() {
  const messages = makeMessages(4, 4000);
  const maxContextTokens = 2000; // budget is 1000 tokens (50%)
  const pruned = pruneHistoryForContextShare({
    messages,
    maxContextTokens,
    maxHistoryShare: 0.5,
    parts: 2,
  });
  return { messages, pruned, maxContextTokens };
}

describe("splitMessagesByTokenShare", () => {
  it("splits messages into two non-empty parts", () => {
    const messages = makeMessages(4, 4000);

    const parts = splitMessagesByTokenShare(messages, 2);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0]?.length).toBeGreaterThan(0);
    expect(parts[1]?.length).toBeGreaterThan(0);
    expect(parts.flat().length).toBe(messages.length);
  });

  it("preserves message order across parts", () => {
    const messages = makeMessages(6, 4000);

    const parts = splitMessagesByTokenShare(messages, 3);
    expect(parts.flat().map((msg) => msg.timestamp)).toEqual(messages.map((msg) => msg.timestamp));
  });

  it("keeps tool_use and matching toolResult in the same chunk", () => {
    // Regression test for #58836: split must not land between
    // an assistant+tool_use message and its corresponding toolResult.
    const messages: AgentMessage[] = [
      makeMessage(1, 4000), // ~1000 tokens
      makeAssistantToolCall(2, "call_split"), // ~1000 tokens (tool_use)
      makeToolResult(3, "call_split", "r".repeat(800)), // ~200 tokens (toolResult)
      makeMessage(4, 4000), // ~1000 tokens
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    // Find which chunk contains the assistant tool_use message
    const chunkWithToolUse = parts.find((chunk) =>
      chunk.some((m) => m.role === "assistant" && m.timestamp === 2),
    );
    // The matching toolResult must be in the same chunk
    const chunkWithToolResult = parts.find((chunk) =>
      chunk.some((m) => m.role === "toolResult" && m.timestamp === 3),
    );
    expect(chunkWithToolUse).toBeDefined();
    expect(chunkWithToolResult).toBeDefined();
    expect(chunkWithToolUse).toBe(chunkWithToolResult);

    // All messages must still be present
    expect(parts.flat().length).toBe(messages.length);
  });

  it("keeps multiple toolResults with their assistant in the same chunk", () => {
    // Assistant with two tool_use blocks; both toolResults must stay together.
    const assistant = makeAgentAssistantMessage({
      content: [
        { type: "text", text: "x".repeat(4000) },
        { type: "toolCall", id: "call_a", name: "tool_a", arguments: {} },
        { type: "toolCall", id: "call_b", name: "tool_b", arguments: {} },
      ],
      model: "gpt-5.2",
      stopReason: "stop",
      timestamp: 2,
    });

    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      assistant,
      makeToolResult(3, "call_a", "result_a".repeat(200)),
      makeToolResult(4, "call_b", "result_b".repeat(200)),
      makeMessage(5, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    const chunkWithAssistant = parts.find((chunk) =>
      chunk.some((m) => m.role === "assistant" && m.timestamp === 2),
    )!;
    const resultTimestamps = chunkWithAssistant
      .filter((m) => m.role === "toolResult")
      .map((m) => m.timestamp);
    expect(resultTimestamps).toContain(3);
    expect(resultTimestamps).toContain(4);
    expect(parts.flat().length).toBe(messages.length);
  });

  it("splits after a completed tool_call/result pair when over budget", () => {
    // Regression: after all toolResults for an assistant are consumed,
    // the chunk must still be eligible for splitting so that
    // pruneHistoryForContextShare can produce multiple chunks.
    const messages: AgentMessage[] = [
      makeAssistantToolCall(1, "call_x", "y".repeat(4000)), // ~1000 tokens
      makeToolResult(2, "call_x", "r".repeat(4000)), // ~1000 tokens
      makeMessage(3, 4000), // ~1000 tokens
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    // Must produce 2 chunks, not 1.
    expect(parts.length).toBe(2);
    // The tool pair stays together in chunk 1.
    const chunk1Roles = parts[0].map((m) => m.role);
    expect(chunk1Roles).toContain("assistant");
    expect(chunk1Roles).toContain("toolResult");
    // All messages preserved.
    expect(parts.flat().length).toBe(messages.length);
  });
});

describe("pruneHistoryForContextShare", () => {
  it("drops older chunks until the history budget is met", () => {
    const { pruned, maxContextTokens } = pruneLargeSimpleHistory();

    expect(pruned.droppedChunks).toBeGreaterThan(0);
    expect(pruned.keptTokens).toBeLessThanOrEqual(Math.floor(maxContextTokens * 0.5));
    expect(pruned.messages.length).toBeGreaterThan(0);
  });

  it("keeps the newest messages when pruning", () => {
    const messages = makeMessages(6, 4000);
    const totalTokens = estimateMessagesTokens(messages);
    const maxContextTokens = Math.max(1, Math.floor(totalTokens * 0.5)); // budget = 25%
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    const keptIds = pruned.messages.map((msg) => msg.timestamp);
    const expectedSuffix = messages.slice(-keptIds.length).map((msg) => msg.timestamp);
    expect(keptIds).toEqual(expectedSuffix);
  });

  it("keeps history when already within budget", () => {
    const messages: AgentMessage[] = [makeMessage(1, 1000)];
    const maxContextTokens = 2000;
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(pruned.droppedChunks).toBe(0);
    expect(pruned.messages.length).toBe(messages.length);
    expect(pruned.keptTokens).toBe(estimateMessagesTokens(messages));
    expect(pruned.droppedMessagesList).toEqual([]);
  });

  it("returns droppedMessagesList containing dropped messages", () => {
    // Note: This test uses simple user messages with no tool calls.
    // When orphaned tool_results exist, droppedMessages may exceed
    // droppedMessagesList.length since orphans are counted but not
    // added to the list (they lack context for summarization).
    const { messages, pruned } = pruneLargeSimpleHistory();

    expect(pruned.droppedChunks).toBeGreaterThan(0);
    // Without orphaned tool_results, counts match exactly
    expect(pruned.droppedMessagesList.length).toBe(pruned.droppedMessages);

    // All messages accounted for: kept + dropped = original
    const allIds = [
      ...pruned.droppedMessagesList.map((m) => m.timestamp),
      ...pruned.messages.map((m) => m.timestamp),
    ].toSorted((a, b) => a - b);
    const originalIds = messages.map((m) => m.timestamp).toSorted((a, b) => a - b);
    expect(allIds).toEqual(originalIds);
  });

  it("returns empty droppedMessagesList when no pruning needed", () => {
    const messages: AgentMessage[] = [makeMessage(1, 100)];
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 100_000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(pruned.droppedChunks).toBe(0);
    expect(pruned.droppedMessagesList).toEqual([]);
    expect(pruned.messages.length).toBe(1);
  });

  it("removes orphaned tool_result messages when tool_use is dropped", () => {
    // Scenario: assistant with tool_use is in chunk 1 (dropped),
    // tool_result is in chunk 2 (kept) - orphaned tool_result should be removed
    // to prevent "unexpected tool_use_id" errors from Anthropic's API
    const messages: AgentMessage[] = [
      // Chunk 1 (will be dropped) - contains tool_use
      makeAssistantToolCall(1, "call_123"),
      // Chunk 2 (will be kept) - contains orphaned tool_result
      makeToolResult(2, "call_123", "result".repeat(500)),
      {
        role: "user",
        content: "x".repeat(500),
        timestamp: 3,
      },
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    // With the tool_use/toolResult boundary fix, the assistant+tool_use and
    // its toolResult now stay in the same chunk. When that chunk is dropped,
    // both are dropped together — no orphaned toolResult in the kept portion.
    const keptRoles = pruned.messages.map((m) => m.role);
    expect(keptRoles).not.toContain("toolResult");

    // Both assistant and toolResult are dropped as a unit, so
    // droppedMessages equals droppedMessagesList.length (no extra orphans).
    expect(pruned.droppedMessages).toBe(pruned.droppedMessagesList.length);
  });

  it("keeps tool_result when its tool_use is also kept", () => {
    // Scenario: both tool_use and tool_result are in the kept portion
    const messages: AgentMessage[] = [
      // Chunk 1 (will be dropped) - just user content
      {
        role: "user",
        content: "x".repeat(4000),
        timestamp: 1,
      },
      // Chunk 2 (will be kept) - contains both tool_use and tool_result
      makeAssistantToolCall(2, "call_456", "y".repeat(500)),
      makeToolResult(3, "call_456", "result"),
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    // Both assistant and toolResult should be in kept messages
    const keptRoles = pruned.messages.map((m) => m.role);
    expect(keptRoles).toContain("assistant");
    expect(keptRoles).toContain("toolResult");
  });

  it("removes multiple orphaned tool_results from the same dropped tool_use", () => {
    // Scenario: assistant with multiple tool_use blocks is dropped,
    // all corresponding tool_results should be removed from kept messages
    const messages: AgentMessage[] = [
      // With the boundary fix, assistant + both toolResults stay in the same chunk.
      // When that chunk is dropped, all three are dropped together.
      makeAgentAssistantMessage({
        content: [
          { type: "text", text: "x".repeat(4000) },
          { type: "toolCall", id: "call_a", name: "tool_a", arguments: {} },
          { type: "toolCall", id: "call_b", name: "tool_b", arguments: {} },
        ],
        model: "gpt-5.4",
        stopReason: "stop",
        timestamp: 1,
      }),
      makeToolResult(2, "call_a", "result_a"),
      makeToolResult(3, "call_b", "result_b"),
      {
        role: "user",
        content: "x".repeat(500),
        timestamp: 4,
      },
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    // No tool_results should be in kept messages (all dropped with their assistant)
    const keptToolResults = pruned.messages.filter((m) => m.role === "toolResult");
    expect(keptToolResults).toHaveLength(0);

    // All three messages (assistant + 2 toolResults) are dropped as a unit,
    // so droppedMessages equals droppedMessagesList.length (no extra orphans).
    expect(pruned.droppedMessages).toBe(pruned.droppedMessagesList.length);
  });
});
