import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  sanitizeToolCallInputs,
  sanitizeToolUseResultPairing,
  repairToolUseResultPairing,
} from "./session-transcript-repair.js";

describe("sanitizeToolUseResultPairing", () => {
  const buildDuplicateToolResultInput = (opts?: {
    middleMessage?: unknown;
    secondText?: string;
  }): AgentMessage[] =>
    [
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
      ...(opts?.middleMessage ? [opts.middleMessage as AgentMessage] : []),
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: opts?.secondText ?? "second" }],
        isError: false,
      },
    ] as unknown as AgentMessage[];

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
    ] as unknown as AgentMessage[];

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
      ...buildDuplicateToolResultInput(),
      { role: "user", content: "ok" },
    ] as AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.filter((m) => m.role === "toolResult")).toHaveLength(1);
  });

  it("drops duplicate tool results for the same id across the transcript", () => {
    const input = buildDuplicateToolResultInput({
      middleMessage: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      secondText: "second (duplicate)",
    });

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
    ] as unknown as AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("strips tool_use blocks from errored assistant messages to prevent 400 loops", () => {
    // When an assistant message has stopReason: "error", its tool_use blocks may be
    // incomplete (partialJson: true). Leaving them in the transcript causes permanent
    // 400 errors: "unexpected tool_use_id found in tool_result blocks".
    // The fix: strip tool_use blocks, keep text content.
    // See: https://github.com/openclaw/openclaw/issues/14322
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_error", name: "exec", arguments: {} }],
        stopReason: "error",
      },
      { role: "user", content: "something went wrong" },
    ] as unknown as AgentMessage[];

    const result = repairToolUseResultPairing(input);

    // Should NOT add synthetic tool results for errored messages
    expect(result.added).toHaveLength(0);
    // The tool-only assistant message should be dropped entirely
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
  });

  it("strips tool_use blocks from aborted assistant messages to prevent 400 loops", () => {
    // When a request is aborted mid-stream, the assistant message may have incomplete
    // tool_use blocks (with partialJson). Leaving them causes permanent 400 errors.
    // See: https://github.com/openclaw/openclaw/issues/14322
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_aborted", name: "Bash", arguments: {} }],
        stopReason: "aborted",
      },
      { role: "user", content: "retrying after abort" },
    ] as unknown as AgentMessage[];

    const result = repairToolUseResultPairing(input);

    // Should NOT add synthetic tool results for aborted messages
    expect(result.added).toHaveLength(0);
    // The tool-only assistant message should be dropped
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
  });

  it("preserves text content from errored assistant messages while stripping tool_use", () => {
    // When an errored assistant message contains both text and tool_use blocks,
    // keep the text (partial reasoning) but strip the tool_use blocks.
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command..." },
          { type: "toolCall", id: "call_partial", name: "Bash", arguments: {} },
        ],
        stopReason: "error",
      },
      { role: "user", content: "what happened?" },
    ] as AgentMessage[];

    const result = repairToolUseResultPairing(input);

    expect(result.added).toHaveLength(0);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe("assistant");
    // Only text content should remain
    const content = (result.messages[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(1);
    expect((content[0] as { type: string }).type).toBe("text");
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
    ] as unknown as AgentMessage[];

    const result = repairToolUseResultPairing(input);

    // Should add a synthetic tool result for the missing result
    expect(result.added).toHaveLength(1);
    expect(result.added[0]?.toolCallId).toBe("call_normal");
  });

  it("drops orphan tool results that follow an aborted assistant message", () => {
    // When an assistant message is aborted, tool_use blocks are stripped and any
    // tool results that follow become orphans and should be dropped.
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
    ] as unknown as AgentMessage[];

    const result = repairToolUseResultPairing(input);

    // The orphan tool result should be dropped, and the tool-only assistant message too
    expect(result.droppedOrphanCount).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    // No synthetic results should be added
    expect(result.added).toHaveLength(0);
  });
});

describe("sanitizeToolCallInputs", () => {
  it("drops tool calls missing input or arguments", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read" }],
      },
      { role: "user", content: "hello" },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallInputs(input);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it("drops tool calls with missing or blank name/id", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_ok", name: "read", arguments: {} },
          { type: "toolCall", id: "call_empty_name", name: "", arguments: {} },
          { type: "toolUse", id: "call_blank_name", name: "   ", input: {} },
          { type: "functionCall", id: "", name: "exec", arguments: {} },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallInputs(input);
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCalls = Array.isArray(assistant.content)
      ? assistant.content.filter((block) => {
          const type = (block as { type?: unknown }).type;
          return typeof type === "string" && ["toolCall", "toolUse", "functionCall"].includes(type);
        })
      : [];

    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { id?: unknown }).id).toBe("call_ok");
  });

  it("keeps valid tool calls and preserves text blocks", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "toolUse", id: "call_ok", name: "read", input: { path: "a" } },
          { type: "toolCall", id: "call_drop", name: "read" },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallInputs(input);
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const types = Array.isArray(assistant.content)
      ? assistant.content.map((block) => (block as { type?: unknown }).type)
      : [];
    expect(types).toEqual(["text", "toolUse"]);
  });

  it("drops tool calls with partialJson: true even when input is present", () => {
    // When streaming is interrupted, tool_use blocks may have partialJson: true
    // and an empty/incomplete input object. These should be treated as incomplete.
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "call_partial", name: "Bash", input: {}, partialJson: true },
        ],
      },
      { role: "user", content: "hello" },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallInputs(input);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("issue #14322: corrupted tool_use/tool_result pair from interrupted streaming", () => {
  it("full scenario: interrupted stream does not poison session permanently", () => {
    // Reproduces the exact scenario from issue #14322:
    // 1. Normal tool calls complete successfully
    // 2. A tool call gets interrupted mid-stream (stopReason: "error", partialJson: true)
    // 3. User sends another message
    // Expected: the session should be cleaned up so the next API call works
    const input = [
      // Normal completed tool call
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_ok", name: "read", arguments: { path: "a.txt" } }],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call_ok",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
      },
      // Interrupted tool call with partialJson
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me also check..." },
          { type: "toolUse", id: "call_broken", name: "Bash", input: {}, partialJson: true },
        ],
        stopReason: "error",
      },
      // User retries
      { role: "user", content: "please try again" },
    ] as AgentMessage[];

    // First sanitize tool call inputs (drops partialJson blocks)
    const afterInputSanitize = sanitizeToolCallInputs(input);
    // Then repair pairing
    const result = repairToolUseResultPairing(afterInputSanitize);

    // The normal tool call/result pair should be preserved
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("toolResult");
    // The errored assistant message should have text content preserved
    // but no tool_use blocks (they were stripped by sanitizeToolCallInputs
    // because of partialJson, leaving only text, so errored-stripping
    // in repairToolUseResultPairing keeps the text-only message)
    expect(result.messages[2]?.role).toBe("assistant");
    const content = (result.messages[2] as { content: unknown[] }).content;
    expect(content).toHaveLength(1);
    expect((content[0] as { type: string }).type).toBe("text");
    // User message preserved
    expect(result.messages[3]?.role).toBe("user");
    // No synthetic results added for the broken call
    expect(result.added).toHaveLength(0);
  });
});
