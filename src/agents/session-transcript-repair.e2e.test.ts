import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
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
