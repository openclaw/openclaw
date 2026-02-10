import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { pruneHistoryForContextShare } from "./compaction.js";

describe("Issue #13020: tool_result blocks in user message content", () => {
  it("removes orphaned tool_result blocks from user message content arrays", () => {
    // This reproduces the exact issue from #13020 where tool_result blocks
    // are embedded in user message content arrays (not separate toolResult messages)
    const messages: AgentMessage[] = [
      // Chunk 1 (will be dropped) - contains tool_use
      {
        role: "assistant",
        content: [
          { type: "text", text: "x".repeat(4000) },
          {
            type: "toolUse",
            id: "toolu_01GAkAmTaPHv1fFZxXj2kgyE",
            name: "exec",
            input: { command: "ls" },
          },
        ],
        timestamp: 1,
      },
      // Chunk 2 (will be kept) - user message with orphaned tool_result in content array
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01GAkAmTaPHv1fFZxXj2kgyE",
            content: "command output here",
          },
          { type: "text", text: "Thanks for running that command" },
        ],
        timestamp: 2,
      },
      {
        role: "assistant",
        content: "You're welcome!",
        timestamp: 3,
      },
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    // The user message should still be present
    const userMessages = pruned.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);

    // But the orphaned tool_result block should be removed from its content
    const userMsg = userMessages[0];
    expect(Array.isArray(userMsg.content)).toBe(true);

    if (Array.isArray(userMsg.content)) {
      const toolResultBlocks = userMsg.content.filter(
        (block: any) => block && typeof block === "object" && block.type === "tool_result",
      );
      expect(toolResultBlocks).toHaveLength(0);

      // The text content should still be there
      const textBlocks = userMsg.content.filter(
        (block: any) => block && typeof block === "object" && block.type === "text",
      );
      expect(textBlocks).toHaveLength(1);
      expect(textBlocks[0]).toEqual({
        type: "text",
        text: "Thanks for running that command",
      });
    }

    // The orphan should be counted in droppedMessages
    expect(pruned.droppedMessages).toBeGreaterThan(pruned.droppedMessagesList.length);
  });

  it("keeps tool_result blocks when their tool_use is also kept", () => {
    // Both tool_use and tool_result are in the kept portion
    const messages: AgentMessage[] = [
      // Chunk 1 (will be dropped)
      {
        role: "user",
        content: "x".repeat(4000),
        timestamp: 1,
      },
      // Chunk 2 (will be kept) - contains tool_use
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running command" },
          { type: "toolUse", id: "call_456", name: "exec", input: {} },
        ],
        timestamp: 2,
      },
      // User message with tool_result in content - should be kept since tool_use is kept
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_456",
            content: "result",
          },
        ],
        timestamp: 3,
      } as AgentMessage,
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    // Find the user message with tool_result
    const userMsg = pruned.messages.find((m) => m.role === "user" && m.timestamp === 3);
    expect(userMsg).toBeDefined();

    if (userMsg && Array.isArray(userMsg.content)) {
      const toolResultBlocks = userMsg.content.filter(
        (block: any) => block && typeof block === "object" && block.type === "tool_result",
      );
      // tool_result should be kept since its tool_use is also kept
      expect(toolResultBlocks).toHaveLength(1);
      expect(toolResultBlocks[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "call_456",
        content: "result",
      });
    }
  });

  it("handles mixed content in user messages correctly", () => {
    // User message has both tool_result blocks and regular content
    const messages: AgentMessage[] = [
      // Assistant with multiple tool uses (will be dropped)
      {
        role: "assistant",
        content: [
          { type: "text", text: "x".repeat(4000) },
          { type: "toolUse", id: "orphan_1", name: "tool1", input: {} },
          { type: "toolUse", id: "orphan_2", name: "tool2", input: {} },
        ],
        timestamp: 1,
      },
      // User message with mixed content (will be kept)
      {
        role: "user",
        content: [
          { type: "text", text: "Here are the results:" },
          {
            type: "tool_result",
            tool_use_id: "orphan_1",
            content: "result 1",
          },
          { type: "text", text: "And also:" },
          {
            type: "tool_result",
            tool_use_id: "orphan_2",
            content: "result 2",
          },
          { type: "text", text: "What do you think?" },
        ],
        timestamp: 2,
      },
      // Assistant with a new tool use (will be kept)
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check something else" },
          { type: "toolUse", id: "valid_1", name: "tool3", input: {} },
        ],
        timestamp: 3,
      },
      // User with valid tool_result (will be kept)
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "valid_1",
            content: "valid result",
          },
        ],
        timestamp: 4,
      },
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    // Check the first user message - orphaned tool_results should be removed
    const firstUserMsg = pruned.messages.find((m) => m.role === "user" && m.timestamp === 2);
    expect(firstUserMsg).toBeDefined();

    if (firstUserMsg && Array.isArray(firstUserMsg.content)) {
      // No orphaned tool_results should remain
      const orphanedResults = firstUserMsg.content.filter(
        (block: any) =>
          block &&
          typeof block === "object" &&
          block.type === "tool_result" &&
          (block.tool_use_id === "orphan_1" || block.tool_use_id === "orphan_2"),
      );
      expect(orphanedResults).toHaveLength(0);

      // Text content should be preserved
      const textBlocks = firstUserMsg.content.filter(
        (block: any) => block && typeof block === "object" && block.type === "text",
      );
      expect(textBlocks).toHaveLength(3);
    }

    // Check the second user message - valid tool_result should be kept
    const secondUserMsg = pruned.messages.find((m) => m.role === "user" && m.timestamp === 4);
    expect(secondUserMsg).toBeDefined();

    if (secondUserMsg && Array.isArray(secondUserMsg.content)) {
      const validResults = secondUserMsg.content.filter(
        (block: any) =>
          block &&
          typeof block === "object" &&
          block.type === "tool_result" &&
          block.tool_use_id === "valid_1",
      );
      expect(validResults).toHaveLength(1);
    }
  });
});
