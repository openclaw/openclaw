import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

import {
  estimateMessagesTokens,
  pruneHistoryForContextShare,
  splitMessagesByTokenShare,
  dropLeadingOrphanToolMessages,
} from "./compaction.js";

function makeMessage(id: number, size: number): AgentMessage {
  return {
    role: "user",
    content: "x".repeat(size),
    timestamp: id,
  };
}

describe("splitMessagesByTokenShare", () => {
  it("splits messages into two non-empty parts", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeMessage(2, 4000),
      makeMessage(3, 4000),
      makeMessage(4, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 2);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0]?.length).toBeGreaterThan(0);
    expect(parts[1]?.length).toBeGreaterThan(0);
    expect(parts.flat().length).toBe(messages.length);
  });

  it("preserves message order across parts", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeMessage(2, 4000),
      makeMessage(3, 4000),
      makeMessage(4, 4000),
      makeMessage(5, 4000),
      makeMessage(6, 4000),
    ];

    const parts = splitMessagesByTokenShare(messages, 3);
    expect(parts.flat().map((msg) => msg.timestamp)).toEqual(messages.map((msg) => msg.timestamp));
  });
});

describe("pruneHistoryForContextShare", () => {
  it("drops older chunks until the history budget is met", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeMessage(2, 4000),
      makeMessage(3, 4000),
      makeMessage(4, 4000),
    ];
    const maxContextTokens = 2000; // budget is 1000 tokens (50%)
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(pruned.droppedChunks).toBeGreaterThan(0);
    expect(pruned.keptTokens).toBeLessThanOrEqual(Math.floor(maxContextTokens * 0.5));
    expect(pruned.messages.length).toBeGreaterThan(0);
  });

  it("keeps the newest messages when pruning", () => {
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeMessage(2, 4000),
      makeMessage(3, 4000),
      makeMessage(4, 4000),
      makeMessage(5, 4000),
      makeMessage(6, 4000),
    ];
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
    const messages: AgentMessage[] = [
      makeMessage(1, 4000),
      makeMessage(2, 4000),
      makeMessage(3, 4000),
      makeMessage(4, 4000),
    ];
    const maxContextTokens = 2000; // budget is 1000 tokens (50%)
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(pruned.droppedChunks).toBeGreaterThan(0);
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

  it("strips leading orphan tool_result messages after dropping chunks", () => {
    const toolResult = (id: number): AgentMessage =>
      ({
        role: "toolResult",
        toolCallId: `call_${id}`,
        toolName: "test",
        content: [{ type: "text", text: "ok" }],
        timestamp: id,
      }) as AgentMessage;
    const assistant = (id: number, size: number): AgentMessage =>
      ({
        role: "assistant",
        content: "a".repeat(size),
        timestamp: id,
      }) as AgentMessage;
    // Chunk boundary will drop first chunk; second chunk starts with tool_result(s).
    const messages: AgentMessage[] = [
      makeMessage(1, 2000),
      assistant(2, 2000),
      toolResult(3),
      makeMessage(4, 2000),
      assistant(5, 2000),
      toolResult(6),
      makeMessage(7, 2000),
    ];
    const maxContextTokens = 2000;
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens,
      maxHistoryShare: 0.5,
      parts: 2,
    });
    expect(pruned.droppedChunks).toBeGreaterThan(0);
    const roles = pruned.messages.map((m) => (m as { role?: string }).role);
    expect(roles[0]).not.toBe("toolResult");
  });

  it("dropLeadingOrphanToolMessages leaves non-tool start unchanged", () => {
    const messages: AgentMessage[] = [makeMessage(1, 100), makeMessage(2, 100)];
    expect(dropLeadingOrphanToolMessages(messages)).toBe(messages);
  });

  it("dropLeadingOrphanToolMessages strips leading toolResult only", () => {
    const toolResult = (id: number): AgentMessage =>
      ({
        role: "toolResult",
        toolCallId: `call_${id}`,
        toolName: "test",
        content: [],
        timestamp: id,
      }) as AgentMessage;
    const messages: AgentMessage[] = [toolResult(1), toolResult(2), makeMessage(3, 100)];
    const out = dropLeadingOrphanToolMessages(messages);
    expect(out.length).toBe(1);
    expect((out[0] as { role?: string }).role).toBe("user");
  });
});
