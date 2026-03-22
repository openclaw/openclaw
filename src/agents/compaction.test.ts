import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  estimateMessagesTokens,
  pruneHistoryForContextShare,
  splitMessagesByTokenShare,
} from "./compaction.js";

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
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "toolCall", id: toolCallId, name: "test_tool", arguments: {} },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.2",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
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

    // The orphaned tool_result should NOT be in kept messages
    // (this is the critical invariant that prevents API errors)
    const keptRoles = pruned.messages.map((m) => m.role);
    expect(keptRoles).not.toContain("toolResult");

    // The orphan count should be reflected in droppedMessages
    // (orphaned tool_results are dropped but not added to droppedMessagesList
    // since they lack context for summarization)
    expect(pruned.droppedMessages).toBeGreaterThan(pruned.droppedMessagesList.length);
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
      // Chunk 1 (will be dropped) - contains multiple tool_use blocks
      {
        role: "assistant",
        content: [
          { type: "text", text: "x".repeat(4000) },
          { type: "toolCall", id: "call_a", name: "tool_a", arguments: {} },
          { type: "toolCall", id: "call_b", name: "tool_b", arguments: {} },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.2",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
      // Chunk 2 (will be kept) - contains orphaned tool_results
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

    // No orphaned tool_results should be in kept messages
    const keptToolResults = pruned.messages.filter((m) => m.role === "toolResult");
    expect(keptToolResults).toHaveLength(0);

    // The orphan count should reflect both dropped tool_results
    // droppedMessages = 1 (assistant) + 2 (orphaned tool_results) = 3
    // droppedMessagesList only has the assistant message
    expect(pruned.droppedMessages).toBe(pruned.droppedMessagesList.length + 2);
  });

  // Regression test for https://github.com/openclaw/openclaw/issues/52024
  // The context trimmer can split tool_use/tool_result pairs when the tool_result
  // is embedded in a user message (role: "user") rather than a standalone tool_result message.
  // This produces orphaned tool_result blocks that cause API rejection:
  // "unexpected tool_use_id found in tool_result blocks"
  it("drops orphaned tool_results embedded in user messages during pruning", () => {
    // Simulate a transcript where tool_result content ended up inside a user message
    // (e.g., after compaction repair moved it incorrectly, or session restore corruption)
    type ToolResultBlock = { type: "toolResult"; tool_use_id: string; content: Array<{ type: "text"; text: string }> };
    type TextBlock = { type: "text"; text: string };

    const messages: AgentMessage[] = [
      // Chunk 1 (will be dropped) - assistant with tool_use
      makeAssistantToolCall(1, "call_abc", "searching..."),
      // Chunk 2 (will be kept) - user message WITH embedded orphaned tool_result
      // This is the pattern that triggers the bug: tool_result as content block in user role
      {
        role: "user",
        content: [
          {
            type: "toolResult",
            tool_use_id: "call_abc",
            content: [{ type: "text", text: "search result here" }],
          } as ToolResultBlock | TextBlock,
          { type: "text", text: "please check this" } as ToolResultBlock | TextBlock,
        ],
        timestamp: 2,
      } as unknown as AgentMessage,
      // Another user turn after the orphaned result
      {
        role: "user",
        content: "what else?",
        timestamp: 3,
      },
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    // The orphaned tool_result block inside the user message should be removed
    // or the user message should be cleaned to prevent API errors
    // Check that no content block references the dropped tool_use_id
    for (const msg of pruned.messages) {
      if (msg.role === "user" && Array.isArray((msg as { content: unknown }).content)) {
        const content = (msg as { content: Array<{ type?: string; tool_use_id?: string }> }).content;
        const hasOrphanedToolResult = content.some(
          (block) => block.type === "toolResult" && block.tool_use_id === "call_abc",
        );
        expect(hasOrphanedToolResult).toBe(false);
      }
    }
  });
});
