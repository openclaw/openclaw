import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { repairToolUseResultPairing } from "./session-transcript-repair.js";

describe("post-compaction tool_use/tool_result repair", () => {
  it("repairs orphaned tool_results that can appear after compaction summary", () => {
    // Simulate what compact() might produce: a summary message followed by
    // a kept tail that has orphaned tool_results (their assistant turn was compacted away)
    const messages: AgentMessage[] = [
      // Summary from compaction (user message with summary content)
      {
        role: "user",
        content: "Summary: Previous conversation covered...",
        timestamp: 1,
      } as AgentMessage,
      // Orphaned tool_result - its assistant turn with tool_use was compacted
      {
        role: "toolResult",
        toolCallId: "call_orphan",
        toolName: "browser",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 2,
      } as unknown as AgentMessage,
      // Valid assistant turn with tool_use
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_valid", name: "exec", input: { command: "ls" } }],
        timestamp: 3,
      } as unknown as AgentMessage,
      // Matching tool_result
      {
        role: "toolResult",
        toolCallId: "call_valid",
        toolName: "exec",
        content: [{ type: "text", text: "file.txt" }],
        isError: false,
        timestamp: 4,
      } as unknown as AgentMessage,
    ];

    const result = repairToolUseResultPairing(messages);

    // Should have dropped the orphan
    expect(result.droppedOrphanCount).toBe(1);
    expect(result.moved).toBe(true);

    // Should have kept valid messages
    expect(result.messages.length).toBe(3); // summary + assistant + toolResult

    // Verify the orphan was dropped
    const toolResults = result.messages.filter((m) => m.role === "toolResult");
    expect(toolResults.length).toBe(1);
    expect((toolResults[0] as { toolCallId?: string }).toolCallId).toBe("call_valid");
  });

  it("handles compaction output with displaced tool_results", () => {
    // Simulate compact() producing messages where tool_results got displaced
    // after user messages instead of immediately after their assistant turn
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_1", name: "read", input: { path: "file.txt" } }],
        timestamp: 1,
      } as unknown as AgentMessage,
      // User message appeared between tool_use and tool_result (shouldn't happen but can)
      {
        role: "user",
        content: "interrupting message",
        timestamp: 2,
      } as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
        timestamp: 3,
      } as unknown as AgentMessage,
    ];

    const result = repairToolUseResultPairing(messages);

    // Repair should move tool_result to right after assistant
    expect(result.moved).toBe(true);

    // Verify correct ordering: assistant, toolResult, user
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[1].role).toBe("toolResult");
    expect(result.messages[2].role).toBe("user");
  });

  it("inserts synthetic error result for missing tool_result after compaction", () => {
    // Simulate compact() keeping an assistant turn but losing its tool_result
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "Summary from compaction...",
        timestamp: 1,
      } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_missing", name: "browser", input: {} }],
        timestamp: 2,
      } as unknown as AgentMessage,
      // No matching tool_result - it was lost in compaction
      {
        role: "user",
        content: "next user message",
        timestamp: 3,
      } as AgentMessage,
    ];

    const result = repairToolUseResultPairing(messages);

    // Should have added a synthetic result
    expect(result.added.length).toBe(1);
    expect(result.added[0].toolCallId).toBe("call_missing");
    expect(result.added[0].isError).toBe(true);

    // Verify synthetic result is in the right place
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[2].role).toBe("toolResult");
  });

  it("drops duplicate tool_results that may appear after compaction", () => {
    // Simulate compact() somehow producing duplicate tool_results
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_1", name: "read", input: {} }],
        timestamp: 1,
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
        timestamp: 2,
      } as unknown as AgentMessage,
      // Duplicate - shouldn't happen but repair should handle it
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "duplicate" }],
        isError: false,
        timestamp: 3,
      } as unknown as AgentMessage,
    ];

    const result = repairToolUseResultPairing(messages);

    expect(result.droppedDuplicateCount).toBe(1);
    expect(result.messages.length).toBe(2); // assistant + single toolResult
  });
});
