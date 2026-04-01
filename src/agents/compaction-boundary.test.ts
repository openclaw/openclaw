import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { findCompactionBoundaries, snapToBoundary } from "./compaction-boundary.js";
import { splitMessagesByTokenShare } from "./compaction.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

function userMsg(ts: number, text = "x".repeat(400)): AgentMessage {
  return { role: "user", content: text, timestamp: ts };
}

function assistantWithToolCall(ts: number, toolCallId: string, text = "x".repeat(400)) {
  return makeAgentAssistantMessage({
    content: [
      { type: "text", text },
      { type: "toolCall", id: toolCallId, name: "test_tool", arguments: {} },
    ],
    model: "sonnet-4.6",
    stopReason: "stop",
    timestamp: ts,
  });
}

function toolResult(ts: number, toolCallId: string, text = "result"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "test_tool",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: ts,
  } as AgentMessage;
}

function assistantText(ts: number, text = "x".repeat(400)) {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text }],
    model: "sonnet-4.6",
    stopReason: "stop",
    timestamp: ts,
  });
}

describe("findCompactionBoundaries", () => {
  it("marks user messages as boundaries when no tool calls are pending", () => {
    const messages = [userMsg(1), userMsg(2), userMsg(3)];
    const boundaries = findCompactionBoundaries(messages);
    expect(boundaries.has(0)).toBe(true);
    expect(boundaries.has(1)).toBe(true);
    expect(boundaries.has(2)).toBe(true);
  });

  it("marks after toolResult as boundary when all tool calls are resolved", () => {
    const messages = [
      userMsg(1),
      assistantWithToolCall(2, "tc1"),
      toolResult(3, "tc1"),
      userMsg(4),
    ];
    const boundaries = findCompactionBoundaries(messages);
    // Index 0 (user) is safe, index 1 (assistant with tool_call) is NOT safe,
    // index 2 (toolResult resolving tc1) IS safe, index 3 (user) is safe.
    expect(boundaries.has(0)).toBe(true);
    expect(boundaries.has(1)).toBe(false);
    expect(boundaries.has(2)).toBe(true);
    expect(boundaries.has(3)).toBe(true);
  });

  it("does not mark boundaries between tool_use and its result", () => {
    const messages = [assistantWithToolCall(1, "tc1"), toolResult(2, "tc1")];
    const boundaries = findCompactionBoundaries(messages);
    expect(boundaries.has(0)).toBe(false); // tool call pending
    expect(boundaries.has(1)).toBe(true); // resolved
  });

  it("handles multiple pending tool calls", () => {
    const messages = [
      makeAgentAssistantMessage({
        content: [
          { type: "text", text: "x".repeat(400) },
          { type: "toolCall", id: "tc1", name: "tool_a", arguments: {} },
          { type: "toolCall", id: "tc2", name: "tool_b", arguments: {} },
        ],
        model: "sonnet-4.6",
        stopReason: "stop",
        timestamp: 1,
      }),
      toolResult(2, "tc1"),
      toolResult(3, "tc2"),
      userMsg(4),
    ];
    const boundaries = findCompactionBoundaries(messages);
    expect(boundaries.has(0)).toBe(false); // 2 tool calls pending
    expect(boundaries.has(1)).toBe(false); // tc2 still pending
    expect(boundaries.has(2)).toBe(true); // all resolved
    expect(boundaries.has(3)).toBe(true);
  });

  it("returns empty set for empty messages", () => {
    expect(findCompactionBoundaries([]).size).toBe(0);
  });

  it("handles assistant text-only messages as boundaries", () => {
    const messages = [userMsg(1), assistantText(2), userMsg(3)];
    const boundaries = findCompactionBoundaries(messages);
    expect(boundaries.has(0)).toBe(true);
    expect(boundaries.has(1)).toBe(true);
    expect(boundaries.has(2)).toBe(true);
  });
});

describe("snapToBoundary", () => {
  it("returns proposed index if it is a boundary", () => {
    const boundaries = new Set([2, 5, 8]);
    expect(snapToBoundary(5, boundaries, 0, 10)).toBe(5);
  });

  it("snaps backward to nearest boundary", () => {
    const boundaries = new Set([2, 5, 8]);
    expect(snapToBoundary(7, boundaries, 0, 10)).toBe(5);
  });

  it("snaps forward if no earlier boundary in range", () => {
    const boundaries = new Set([5, 8]);
    expect(snapToBoundary(3, boundaries, 3, 10)).toBe(5);
  });

  it("returns proposed if no boundaries exist", () => {
    expect(snapToBoundary(3, new Set(), 0, 10)).toBe(3);
  });
});

describe("splitMessagesByTokenShare with tool-call boundaries", () => {
  it("does not split between tool_use and its toolResult", () => {
    // Create a sequence where the naive token-based split would land
    // between the tool_use and toolResult.
    const messages: AgentMessage[] = [
      userMsg(1, "x".repeat(4000)),
      userMsg(2, "x".repeat(4000)),
      assistantWithToolCall(3, "tc1", "x".repeat(4000)),
      toolResult(4, "tc1", "x".repeat(200)),
      userMsg(5, "x".repeat(4000)),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);

    // Verify: no chunk should end with an assistant tool_call without
    // the corresponding toolResult in the same chunk.
    for (const chunk of parts) {
      const pendingToolCalls = new Set<string>();
      for (const msg of chunk) {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (
              block &&
              typeof block === "object" &&
              "type" in block &&
              (block.type === "toolCall" || block.type === "toolUse") &&
              "id" in block &&
              typeof block.id === "string"
            ) {
              pendingToolCalls.add(block.id);
            }
          }
        } else if (msg.role === "toolResult") {
          const id = (msg as { toolCallId?: string }).toolCallId;
          if (id) {
            pendingToolCalls.delete(id);
          }
        }
      }
      expect(
        pendingToolCalls.size,
        `Chunk has orphaned tool_use without toolResult: ${[...pendingToolCalls].join(", ")}`,
      ).toBe(0);
    }
  });

  it("splits at boundary when boundary coincides with proposed split point", () => {
    // All messages equal size — the proposed split lands exactly at message index 2.
    // Message 2 (toolResult) IS a boundary, so it should be respected.
    const messages: AgentMessage[] = [
      userMsg(1, "x".repeat(4000)),
      assistantWithToolCall(2, "tc1", "x".repeat(4000)),
      toolResult(3, "tc1", "x".repeat(4000)),
      userMsg(4, "x".repeat(4000)),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);
    const flat = parts.flat();
    expect(flat.length).toBe(messages.length);

    // The tool_use and toolResult should be in the same chunk.
    for (const chunk of parts) {
      const pendingToolCalls = new Set<string>();
      for (const msg of chunk) {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (
              block &&
              typeof block === "object" &&
              "type" in block &&
              (block.type === "toolCall" || block.type === "toolUse") &&
              "id" in block &&
              typeof block.id === "string"
            ) {
              pendingToolCalls.add(block.id);
            }
          }
        } else if (msg.role === "toolResult") {
          const id = (msg as { toolCallId?: string }).toolCallId;
          if (id) {
            pendingToolCalls.delete(id);
          }
        }
      }
      expect(
        pendingToolCalls.size,
        `Chunk has orphaned tool_use without toolResult: ${[...pendingToolCalls].join(", ")}`,
      ).toBe(0);
    }
  });

  it("preserves all messages across splits", () => {
    const messages: AgentMessage[] = [
      userMsg(1, "x".repeat(4000)),
      assistantWithToolCall(2, "tc1", "x".repeat(4000)),
      toolResult(3, "tc1", "x".repeat(4000)),
      userMsg(4, "x".repeat(4000)),
      assistantWithToolCall(5, "tc2", "x".repeat(4000)),
      toolResult(6, "tc2", "x".repeat(4000)),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);
    const flat = parts.flat();
    expect(flat.length).toBe(messages.length);
    expect(flat.map((m) => m.timestamp)).toEqual(messages.map((m) => m.timestamp));
  });
});
