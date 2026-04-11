import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  estimateMessageTokens,
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
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
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

describe("estimateMessageTokens", () => {
  it("falls back to guarded estimation for malformed assistant blocks", () => {
    const message = {
      role: "assistant",
      content: [
        null,
        { type: "text" },
        { type: "text", text: "abcd" },
        { type: "input_text", text: "gh" },
        { type: "output_text", text: "ij" },
        { type: "thinking" },
        { type: "thinking", thinking: "ef" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "x" } },
      ],
      timestamp: 1,
    } as unknown as AgentMessage;

    expect(() => estimateMessageTokens(message)).not.toThrow();
    expect(estimateMessageTokens(message)).toBe(
      Math.ceil(
        ("abcd".length +
          "gh".length +
          "ij".length +
          "ef".length +
          "read".length +
          JSON.stringify({ path: "x" }).length) /
          4,
      ),
    );
  });

  it("counts provider-specific tool-call payloads in the fallback estimator", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text" },
        { type: "toolUse", id: "call_2", name: "read", input: { path: "IDENTITY.md" } },
        { type: "functionCall", id: "call_3", name: "bash", arguments: { command: "pwd" } },
        { type: "tool_use", id: "call_4", name: "search", input: { q: "openclaw" } },
        { type: "tool_call", id: "call_5", name: "write", arguments: { path: "out.txt" } },
        { type: "function_call", id: "call_6", name: "exec", arguments: { cmd: "pwd" } },
        {
          type: "toolCall",
          id: "call_7",
          name: "stream",
          arguments: {},
          partialJson: '{"path":"x"}',
        },
        {
          type: "toolUse",
          id: "call_8",
          name: "delta",
          input: undefined,
          arguments: {},
          partialArgs: '{"cmd":"ls"}',
        },
      ],
      timestamp: 1,
    } as unknown as AgentMessage;

    expect(estimateMessageTokens(message)).toBe(
      Math.ceil(
        ("read".length +
          JSON.stringify({ path: "IDENTITY.md" }).length +
          "bash".length +
          JSON.stringify({ command: "pwd" }).length +
          "search".length +
          JSON.stringify({ q: "openclaw" }).length +
          "write".length +
          JSON.stringify({ path: "out.txt" }).length +
          "exec".length +
          JSON.stringify({ cmd: "pwd" }).length +
          "stream".length +
          JSON.stringify('{"path":"x"}').length +
          "delta".length +
          JSON.stringify('{"cmd":"ls"}').length) /
          4,
      ),
    );
  });

  it("returns zero for assistant messages missing content arrays", () => {
    const message = {
      role: "assistant",
      timestamp: 1,
    } as unknown as AgentMessage;

    expect(() => estimateMessageTokens(message)).not.toThrow();
    expect(estimateMessageTokens(message)).toBe(0);
    expect(estimateMessagesTokens([message])).toBe(0);
  });

  it("counts input_image blocks in the fallback estimator", () => {
    const message = {
      role: "assistant",
      content: [
        null,
        { type: "text" },
        { type: "input_text", text: "describe this" },
        {
          type: "input_image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "aGVsbG8=",
          },
        },
      ],
      timestamp: 1,
    } as unknown as AgentMessage;

    expect(estimateMessageTokens(message)).toBe(Math.ceil(("describe this".length + 4800) / 4));
  });
});

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
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeAssistantToolCall(2, "call_split"),
      makeToolResult(3, "call_split", "r".repeat(800)),
      makeMessage(4, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    const chunkWithToolUse = parts.find((chunk) =>
      chunk.some((m) => m.role === "assistant" && m.timestamp === 2),
    );
    const chunkWithToolResult = parts.find((chunk) =>
      chunk.some((m) => m.role === "toolResult" && m.timestamp === 3),
    );
    expect(chunkWithToolUse).toBeDefined();
    expect(chunkWithToolResult).toBeDefined();
    expect(chunkWithToolUse).toBe(chunkWithToolResult);
    expect(parts.flat().length).toBe(messages.length);
  });

  it("keeps multiple toolResults with their assistant in the same chunk", () => {
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

  it("keeps displaced toolResults with their assistant chunk", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeAssistantToolCall(2, "call_split"),
      makeMessage(3, 800),
      makeToolResult(4, "call_split", "r".repeat(800)),
      makeMessage(5, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    const chunkWithToolUse = parts.find((chunk) =>
      chunk.some((m) => m.role === "assistant" && m.timestamp === 2),
    );
    const chunkWithToolResult = parts.find((chunk) =>
      chunk.some((m) => m.role === "toolResult" && m.timestamp === 4),
    );

    expect(chunkWithToolUse).toBeDefined();
    expect(chunkWithToolUse).toBe(chunkWithToolResult);
  });

  it("splits after a completed tool_call/result pair when over budget", () => {
    const messages: AgentMessage[] = [
      makeAssistantToolCall(1, "call_x", "y".repeat(4000)),
      makeToolResult(2, "call_x", "r".repeat(4000)),
      makeMessage(3, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    expect(parts.length).toBe(2);
    const chunk1Roles = parts[0].map((m) => m.role);
    expect(chunk1Roles).toContain("assistant");
    expect(chunk1Roles).toContain("toolResult");
    expect(parts.flat().length).toBe(messages.length);
  });

  it("splits before a trailing completed tool-call pair", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeAssistantToolCall(2, "call_tail", "y".repeat(200)),
      makeToolResult(3, "call_tail", "r".repeat(4000)),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    expect(parts.length).toBe(2);
    expect(parts[0]?.map((m) => m.timestamp)).toEqual([1]);
    expect(parts[1]?.map((m) => m.timestamp)).toEqual([2, 3]);
  });

  it("does not block splits after aborted tool-call assistants", () => {
    const messages: AgentMessage[] = [
      makeAssistantToolCall(1, "call_abort", "y".repeat(4000), "aborted"),
      makeMessage(2, 4000),
      makeMessage(3, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    expect(parts.length).toBe(2);
    expect(parts.flat().length).toBe(messages.length);
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
    const { messages, pruned } = pruneLargeSimpleHistory();

    expect(pruned.droppedChunks).toBeGreaterThan(0);
    expect(pruned.droppedMessagesList.length).toBe(pruned.droppedMessages);

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
    const messages: AgentMessage[] = [
      makeAssistantToolCall(1, "call_123"),
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

    const keptRoles = pruned.messages.map((m) => m.role);
    expect(keptRoles).not.toContain("toolResult");
    expect(pruned.droppedMessages).toBe(pruned.droppedMessagesList.length);
  });

  it("keeps tool_result when its tool_use is also kept", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "x".repeat(4000),
        timestamp: 1,
      },
      makeAssistantToolCall(2, "call_456", "y".repeat(500)),
      makeToolResult(3, "call_456", "result"),
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    const keptRoles = pruned.messages.map((m) => m.role);
    expect(keptRoles).toContain("assistant");
    expect(keptRoles).toContain("toolResult");
  });

  it("removes multiple orphaned tool_results from the same dropped tool_use", () => {
    const messages: AgentMessage[] = [
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

    const keptToolResults = pruned.messages.filter((m) => m.role === "toolResult");
    expect(keptToolResults).toHaveLength(0);
    expect(pruned.droppedMessages).toBe(pruned.droppedMessagesList.length);
  });
});
