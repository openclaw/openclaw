import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { limitHistoryTurns } from "./pi-embedded-runner.js";
import { sanitizeToolUseResultPairing } from "./session-transcript-repair.js";
import { validateAnthropicTurns } from "./pi-embedded-helpers.js";

/**
 * Integration tests for PR #4736: Re-run tool pairing and turn validation after history limiting
 *
 * These tests verify that after limitHistoryTurns creates problematic scenarios
 * (orphaned tool_result blocks, consecutive assistant messages), the re-run of
 * sanitizeToolUseResultPairing and validateAnthropicTurns correctly repairs them.
 */
describe("limitHistoryTurns + sanitization integration (PR #4736)", () => {
  it("removes orphaned tool_result blocks when tool_use is separated by compaction", () => {
    // Setup: Simulate a scenario where compaction summary separates tool_use from tool_result
    // After limiting, the tool_result references a tool_use that's not in the immediately
    // preceding assistant message (issue #4650)
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "turn 1" }],
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_old", name: "exec", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_old",
        toolName: "exec",
        content: [{ type: "text", text: "output" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Compaction summary goes here" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "turn 2" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "response" }],
      },
    ];

    // Step 1: Limit to last 2 user turns (keeps everything from turn 1 onward)
    const limited = limitHistoryTurns(messages, 2);
    expect(limited.length).toBe(6); // All messages kept

    // Now manually create the orphan scenario by having tool_result after a different assistant
    const orphanedScenario: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "turn" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "text response" }],
      },
      {
        role: "toolResult",
        toolCallId: "call_orphan",
        toolName: "read",
        content: [{ type: "text", text: "orphaned result" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "another response" }],
      },
    ];

    // Step 2: Re-run sanitizeToolUseResultPairing (as PR #4736 does)
    const repaired = sanitizeToolUseResultPairing(orphanedScenario);

    // Verify orphaned tool_result was removed
    expect(repaired.some((m) => m.role === "toolResult")).toBe(false);
    expect(repaired.length).toBe(3); // user + 2 assistants
  });

  it("merges consecutive assistant messages after history limiting", () => {
    // Setup: History that will create consecutive assistant messages when limited
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "summary from compaction" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old response - will be cut" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "second - will be kept" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "new response" }],
      },
    ];

    // Step 1: Limit to last 1 turn
    const limited = limitHistoryTurns(messages, 1);

    // Verify that limiting kept the last user turn and potentially created consecutive assistants
    expect(limited.length).toBeGreaterThan(0);

    // Step 2: Re-run turn validation (as PR #4736 does)
    const validated = validateAnthropicTurns(limited);

    // Verify no consecutive assistant messages remain
    for (let i = 1; i < validated.length; i++) {
      if (validated[i].role === "assistant") {
        expect(validated[i - 1].role).not.toBe("assistant");
      }
    }

    // Verify user/assistant alternation
    const roles = validated.map((m) => m.role);
    expect(roles[0]).toBe("user"); // Should start with user
  });

  it("handles complex scenario: orphan + consecutive assistants", () => {
    // Setup: Worst case - both orphaned tool_result AND consecutive assistants
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "turn 1" }],
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_old", name: "exec", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_old",
        toolName: "exec",
        content: [{ type: "text", text: "output" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "summary" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "turn 2" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "final response" }],
      },
    ];

    // Step 1: Limit to last 1 turn
    const limited = limitHistoryTurns(messages, 1);

    // Step 2: Apply full repair chain (as PR #4736 does)
    const repaired = sanitizeToolUseResultPairing(limited);
    const validated = validateAnthropicTurns(repaired);

    // Verify both issues are fixed
    expect(validated.some((m) => m.role === "toolResult")).toBe(false); // No orphans
    for (let i = 1; i < validated.length; i++) {
      if (validated[i].role === "assistant") {
        expect(validated[i - 1].role).not.toBe("assistant"); // No consecutive
      }
    }
    expect(validated[0].role).toBe("user"); // Proper turn structure
  });

  it("preserves tool_use/tool_result pairing when not orphaned", () => {
    // Setup: Tool use in the kept portion of history
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "old turn" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old response" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "new turn with tool request" }],
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_new", name: "read", arguments: { path: "test.txt" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_new",
        toolName: "read",
        content: [{ type: "text", text: "test content" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "response using tool result" }],
      },
    ];

    // Step 1: Limit to last 1 turn (keeps the tool_use + tool_result)
    const limited = limitHistoryTurns(messages, 1);

    // Step 2: Apply repair (should preserve valid pairing)
    const repaired = sanitizeToolUseResultPairing(limited);
    const validated = validateAnthropicTurns(repaired);

    // Verify tool pairing is preserved
    const toolResultIndex = validated.findIndex((m) => m.role === "toolResult");
    expect(toolResultIndex).toBeGreaterThan(-1); // tool_result should exist

    const toolCallIndex = validated.findIndex(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((c) => c.type === "toolCall"),
    );
    expect(toolCallIndex).toBeGreaterThan(-1); // tool_use should exist
    expect(toolResultIndex).toBeGreaterThan(toolCallIndex); // tool_result after tool_use

    // Verify IDs match
    const assistant = validated[toolCallIndex] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content?.find((c) => c.type === "toolCall") as
      | {
          id?: string;
        }
      | undefined;
    const result = validated[toolResultIndex] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(result.toolCallId).toBe(toolCall?.id);
  });
});
