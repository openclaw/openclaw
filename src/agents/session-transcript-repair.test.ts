import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { limitHistoryTurns } from "./pi-embedded-runner/history.js";
import {
  repairToolUseResultPairing,
  sanitizeToolCallInputs,
  sanitizeToolUseResultPairing,
  repairToolUseResultPairing,
} from "./session-transcript-repair.js";

describe("sanitizeToolUseResultPairing", () => {
  it("moves tool results directly after tool calls and inserts missing results", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          { type: "toolCall", id: "call_2", name: "exec", arguments: {} },
        ],
      },
      { role: "user", content: "user message that should come after tool use" },
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "exec",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out[0]?.role).toBe("assistant");
    expect(out[1]?.role).toBe("toolResult");
    expect((out[1] as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect(out[2]?.role).toBe("toolResult");
    expect((out[2] as { toolCallId?: string }).toolCallId).toBe("call_2");
    expect(out[3]?.role).toBe("user");
  });

  it("drops duplicate tool results for the same id within a span", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "second" }],
        isError: false,
      },
      { role: "user", content: "ok" },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.filter((m) => m.role === "toolResult")).toHaveLength(1);
  });

  it("drops duplicate tool results for the same id across the transcript", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "second (duplicate)" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    const results = out.filter((m) => m.role === "toolResult") as Array<{
      toolCallId?: string;
    }>;
    expect(results).toHaveLength(1);
    expect(results[0]?.toolCallId).toBe("call_1");
  });

  it("drops orphan tool results that do not match any tool call", () => {
    const input = [
      { role: "user", content: "hello" },
      {
        role: "toolResult",
        toolCallId: "call_orphan",
        toolName: "read",
        content: [{ type: "text", text: "orphan" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("skips tool call extraction for assistant messages with stopReason 'error'", () => {
    // When an assistant message has stopReason: "error", its tool_use blocks may be
    // incomplete/malformed. We should NOT create synthetic tool_results for them,
    // as this causes API 400 errors: "unexpected tool_use_id found in tool_result blocks"
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_error", name: "exec", arguments: {} }],
        stopReason: "error",
      },
      { role: "user", content: "something went wrong" },
    ] as AgentMessage[];

    const result = repairToolUseResultPairing(input);

    // Should NOT add synthetic tool results for errored messages
    expect(result.added).toHaveLength(0);
    // The assistant message should be passed through unchanged
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("user");
    expect(result.messages).toHaveLength(2);
  });

  it("skips tool call extraction for assistant messages with stopReason 'aborted'", () => {
    // When a request is aborted mid-stream, the assistant message may have incomplete
    // tool_use blocks (with partialJson). We should NOT create synthetic tool_results.
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_aborted", name: "Bash", arguments: {} }],
        stopReason: "aborted",
      },
      { role: "user", content: "retrying after abort" },
    ] as AgentMessage[];

    const result = repairToolUseResultPairing(input);

    // Should NOT add synthetic tool results for aborted messages
    expect(result.added).toHaveLength(0);
    // Messages should be passed through without synthetic insertions
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("user");
  });

  it("still repairs tool results for normal assistant messages with stopReason 'toolUse'", () => {
    // Normal tool calls (stopReason: "toolUse" or "stop") should still be repaired
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_normal", name: "read", arguments: {} }],
        stopReason: "toolUse",
      },
      { role: "user", content: "user message" },
    ] as AgentMessage[];

    const result = repairToolUseResultPairing(input);

    // Should add a synthetic tool result for the missing result
    expect(result.added).toHaveLength(1);
    expect(result.added[0]?.toolCallId).toBe("call_normal");
  });

  it("drops orphan tool results that follow an aborted assistant message", () => {
    // When an assistant message is aborted, any tool results that follow should be
    // dropped as orphans (since we skip extracting tool calls from aborted messages).
    // This addresses the edge case where a partial tool result was persisted before abort.
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_aborted", name: "exec", arguments: {} }],
        stopReason: "aborted",
      },
      {
        role: "toolResult",
        toolCallId: "call_aborted",
        toolName: "exec",
        content: [{ type: "text", text: "partial result" }],
        isError: false,
      },
      { role: "user", content: "retrying" },
    ] as AgentMessage[];

    const result = repairToolUseResultPairing(input);

    // The orphan tool result should be dropped
    expect(result.droppedOrphanCount).toBe(1);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("user");
    // No synthetic results should be added
    expect(result.added).toHaveLength(0);
  });
});

describe("limitHistoryTurns + sanitizeToolUseResultPairing integration", () => {
  it("repairs orphaned tool results created when limitHistoryTurns cuts mid-sequence", () => {
    // This test demonstrates the bug fixed by re-running repair after limiting.
    // Scenario: A session has tool_use/tool_result pairs that span user turns.
    // When limitHistoryTurns slices the transcript, it can create orphaned
    // tool_results whose matching tool_use was cut off.
    //
    // See: https://github.com/openclaw/openclaw/issues/4650

    // Simulate a transcript where a tool_result appears at the start after limiting.
    // This can happen when:
    // 1. Original transcript has [user][assistant tool_use:A][tool_result:A][user][assistant]...
    // 2. Validation modifies/drops the assistant message but keeps subsequent messages
    // 3. Or limiting slices in a way that orphans the tool_result
    const afterLimiting = [
      // This tool_result's matching tool_use was cut off by limiting
      {
        role: "toolResult",
        toolCallId: "toolu_orphaned_by_limit",
        toolName: "read",
        content: [{ type: "text", text: "result from previous context" }],
        isError: false,
        timestamp: 1000,
      },
      { role: "user", content: "continuing conversation" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here is the file content" },
          { type: "toolCall", id: "toolu_current", name: "write", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "toolu_current",
        toolName: "write",
        content: [{ type: "text", text: "written" }],
        isError: false,
        timestamp: 2000,
      },
      { role: "user", content: "thanks" },
    ] satisfies AgentMessage[];

    // Without the fix, this transcript would be sent to the API with an orphaned
    // tool_result, causing: "unexpected tool_use_id found in tool_result blocks"

    const report = repairToolUseResultPairing(afterLimiting);

    // The orphaned tool_result should be dropped
    expect(report.droppedOrphanCount).toBe(1);
    expect(report.messages[0]?.role).toBe("user");
    expect(report.messages).toHaveLength(4);

    // Valid tool_use/tool_result pair should remain intact
    const toolResults = report.messages.filter((m) => m.role === "toolResult") as Array<{
      toolCallId?: string;
    }>;
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.toolCallId).toBe("toolu_current");
  });

  it("handles the full sanitize -> limit -> sanitize flow", () => {
    // Simulate a long conversation that will be limited
    const fullTranscript = [
      // Turn 1: Old conversation that will be cut
      { role: "user", content: "old question 1" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_old_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "toolu_old_1",
        toolName: "read",
        content: [{ type: "text", text: "old result" }],
        isError: false,
        timestamp: 1000,
      },
      { role: "assistant", content: [{ type: "text", text: "old response" }] },

      // Turn 2: Also will be cut
      { role: "user", content: "old question 2" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_old_2", name: "exec", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "toolu_old_2",
        toolName: "exec",
        content: [{ type: "text", text: "old exec result" }],
        isError: false,
        timestamp: 2000,
      },
      { role: "assistant", content: [{ type: "text", text: "old response 2" }] },

      // Turn 3: Recent - will be kept
      { role: "user", content: "recent question" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_recent", name: "write", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "toolu_recent",
        toolName: "write",
        content: [{ type: "text", text: "recent result" }],
        isError: false,
        timestamp: 3000,
      },
      { role: "assistant", content: [{ type: "text", text: "recent response" }] },
      { role: "user", content: "thanks" },
    ] satisfies AgentMessage[];

    // Step 1: First sanitization (happens in sanitizeSessionTranscript)
    const sanitized = sanitizeToolUseResultPairing(fullTranscript);
    expect(sanitized).toHaveLength(13);

    // Step 2: Limit to 2 user turns (simulates dmHistoryLimit)
    const limited = limitHistoryTurns(sanitized, 2);

    // After limiting, we should have recent conversation only
    // The slice starts at the 3rd-to-last user message
    expect(limited.length).toBeLessThan(sanitized.length);

    // Step 3: Re-run repair after limiting (the fix)
    const repaired = sanitizeToolUseResultPairing(limited);

    // Verify no orphaned tool_results remain
    const toolResults = repaired.filter((m) => m.role === "toolResult") as Array<{
      toolCallId?: string;
    }>;
    const toolCalls = repaired
      .filter((m) => m.role === "assistant")
      .flatMap((m) => {
        const content = (m as { content?: unknown[] }).content;
        if (!Array.isArray(content)) {
          return [];
        }
        return content
          .filter(
            (c): c is { type: string; id: string } =>
              c !== null &&
              typeof c === "object" &&
              "type" in c &&
              "id" in c &&
              (c.type === "toolCall" || c.type === "toolUse"),
          )
          .map((c) => c.id);
      });

    // Every tool_result should have a matching tool_call
    for (const result of toolResults) {
      expect(toolCalls).toContain(result.toolCallId);
    }
  });

  it("inserts synthetic results when limiting cuts off tool_results but keeps tool_use", () => {
    // Edge case: What if limiting keeps the assistant with tool_use but somehow
    // the tool_result got separated and cut? The repair should insert synthetic results.

    const brokenTranscript = [
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "toolu_no_result", name: "dangerous_tool", arguments: {} },
        ],
      },
      // tool_result is missing (was cut off or never existed)
      { role: "user", content: "what happened?" },
    ] satisfies AgentMessage[];

    const report = repairToolUseResultPairing(brokenTranscript);

    // A synthetic error result should be inserted
    expect(report.added).toHaveLength(1);
    expect(report.added[0]?.toolCallId).toBe("toolu_no_result");
    expect(report.added[0]?.isError).toBe(true);

    // The repaired transcript should have valid pairing
    expect(report.messages[0]?.role).toBe("user");
    expect(report.messages[1]?.role).toBe("assistant");
    expect(report.messages[2]?.role).toBe("toolResult");
    expect(report.messages[3]?.role).toBe("user");
  });
});

describe("sanitizeToolCallInputs", () => {
  it("drops tool calls missing input or arguments", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read" }],
      },
      { role: "user", content: "hello" },
    ];

    const out = sanitizeToolCallInputs(input);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it("keeps valid tool calls and preserves text blocks", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "toolUse", id: "call_ok", name: "read", input: { path: "a" } },
          { type: "toolCall", id: "call_drop", name: "read" },
        ],
      },
    ];

    const out = sanitizeToolCallInputs(input);
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const types = Array.isArray(assistant.content)
      ? assistant.content.map((block) => (block as { type?: unknown }).type)
      : [];
    expect(types).toEqual(["text", "toolUse"]);
  });
});
