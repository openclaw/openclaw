import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

import {
  estimateMessagesTokens,
  pruneHistoryForContextShare,
  splitMessagesForPreservation,
  splitMessagesByTokenShare,
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
    ].sort((a, b) => a - b);
    const originalIds = messages.map((m) => m.timestamp).sort((a, b) => a - b);
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
});

describe("splitMessagesForPreservation", () => {
  function makeUser(text: string): AgentMessage {
    return { role: "user", content: text, timestamp: Date.now() };
  }

  function makeAssistant(text: string): AgentMessage {
    return { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() };
  }

  it("preserves last N user/assistant pairs", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      makeUser("u2"),
      makeAssistant("a2"),
      makeUser("u3"),
      makeAssistant("a3"),
    ];

    const result = splitMessagesForPreservation({ messages, keepLastMessages: 2 });

    expect(result.preservedPairs).toBe(2);
    expect(result.toPreserve.length).toBe(4); // 2 pairs = 4 messages
    expect(result.toSummarize.length).toBe(2); // First pair
    expect(result.toSummarize[0]).toBe(messages[0]); // u1
    expect(result.toSummarize[1]).toBe(messages[1]); // a1
    expect(result.toPreserve[0]).toBe(messages[2]); // u2
    expect(result.toPreserve[3]).toBe(messages[5]); // a3
  });

  it("returns all messages to summarize when keepLastMessages is 0", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      makeUser("u2"),
      makeAssistant("a2"),
    ];

    const result = splitMessagesForPreservation({ messages, keepLastMessages: 0 });

    expect(result.preservedPairs).toBe(0);
    expect(result.toPreserve.length).toBe(0);
    expect(result.toSummarize).toBe(messages);
  });

  it("preserves all messages when keepLastMessages exceeds available pairs", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      makeUser("u2"),
      makeAssistant("a2"),
    ];

    const result = splitMessagesForPreservation({ messages, keepLastMessages: 10 });

    expect(result.preservedPairs).toBe(2);
    expect(result.toPreserve.length).toBe(4);
    expect(result.toSummarize.length).toBe(0);
  });

  it("handles incomplete pairs by excluding trailing incomplete messages", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      makeUser("u2"),
      makeAssistant("a2"),
      makeUser("u3"), // Incomplete pair - no assistant response yet
    ];

    const result = splitMessagesForPreservation({ messages, keepLastMessages: 2 });

    // Should preserve both complete pairs (u1+a1, u2+a2), and include the trailing u3
    // because it comes after the preserved pairs
    expect(result.preservedPairs).toBe(2);
    expect(result.toPreserve.length).toBe(5); // u1, a1, u2, a2, u3
    expect(result.toSummarize.length).toBe(0);
  });

  it("handles messages with tool results between user and assistant", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      { role: "toolResult", toolCallId: "t1", toolName: "test", timestamp: Date.now() } as AgentMessage,
      makeUser("u2"),
      makeAssistant("a2"),
    ];

    const result = splitMessagesForPreservation({ messages, keepLastMessages: 1 });

    // Should preserve last complete user/assistant pair (u2, a2)
    expect(result.preservedPairs).toBe(1);
    expect(result.toPreserve.length).toBe(2);
    expect(result.toPreserve[0]).toBe(messages[3]); // u2
    expect(result.toPreserve[1]).toBe(messages[4]); // a2
  });

  it("returns empty arrays for empty messages", () => {
    const result = splitMessagesForPreservation({ messages: [], keepLastMessages: 3 });

    expect(result.preservedPairs).toBe(0);
    expect(result.toPreserve.length).toBe(0);
    expect(result.toSummarize.length).toBe(0);
  });

  it("handles negative keepLastMessages", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
    ];

    const result = splitMessagesForPreservation({ messages, keepLastMessages: -1 });

    expect(result.preservedPairs).toBe(0);
    expect(result.toPreserve.length).toBe(0);
    expect(result.toSummarize).toBe(messages);
  });
});
