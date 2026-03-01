import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  sanitizeToolCallInputs,
  sanitizeToolNameLengths,
  sanitizeToolUseResultPairing,
  repairToolUseResultPairing,
} from "./session-transcript-repair.js";

const TOOL_CALL_BLOCK_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);

function getAssistantToolCallBlocks(messages: AgentMessage[]) {
  const assistant = messages[0] as Extract<AgentMessage, { role: "assistant" }> | undefined;
  if (!assistant || !Array.isArray(assistant.content)) {
    return [] as Array<{ type?: unknown; id?: unknown; name?: unknown }>;
  }
  return assistant.content.filter((block) => {
    const type = (block as { type?: unknown }).type;
    return typeof type === "string" && TOOL_CALL_BLOCK_TYPES.has(type);
  }) as Array<{ type?: unknown; id?: unknown; name?: unknown }>;
}

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
    ] as unknown as AgentMessage[];

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
    ] as unknown as AgentMessage[];

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
    ] as unknown as AgentMessage[];

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
    ] as unknown as AgentMessage[];

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
    const toolCalls = getAssistantToolCallBlocks(out);

    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { id?: unknown }).id).toBe("call_ok");
  });

  it("drops tool calls with malformed or overlong names", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_ok", name: "read", arguments: {} },
          {
            type: "toolCall",
            id: "call_bad_chars",
            name: 'toolu_01abc <|tool_call_argument_begin|> {"command"',
            arguments: {},
          },
          {
            type: "toolUse",
            id: "call_too_long",
            name: `read_${"x".repeat(80)}`,
            input: {},
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallInputs(input);
    const toolCalls = getAssistantToolCallBlocks(out);

    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { name?: unknown }).name).toBe("read");
  });

  it("drops unknown tool names when an allowlist is provided", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_ok", name: "read", arguments: {} },
          { type: "toolCall", id: "call_unknown", name: "write", arguments: {} },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallInputs(input, { allowedToolNames: ["read"] });
    const toolCalls = getAssistantToolCallBlocks(out);

    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { name?: unknown }).name).toBe("read");
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

  it("trims leading whitespace from tool names", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: " read", arguments: {} }],
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallInputs(input);
    const toolCalls = getAssistantToolCallBlocks(out);

    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { name?: unknown }).name).toBe("read");
  });

  it("trims trailing whitespace from tool names", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_1", name: "exec ", input: { command: "ls" } }],
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallInputs(input);
    const toolCalls = getAssistantToolCallBlocks(out);

    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { name?: unknown }).name).toBe("exec");
  });

  it("trims both leading and trailing whitespace from tool names", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: " read ", arguments: {} },
          { type: "toolUse", id: "call_2", name: "  exec  ", input: {} },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallInputs(input);
    const toolCalls = getAssistantToolCallBlocks(out);

    expect(toolCalls).toHaveLength(2);
    expect((toolCalls[0] as { name?: unknown }).name).toBe("read");
    expect((toolCalls[1] as { name?: unknown }).name).toBe("exec");
  });

  it("trims tool names and matches against allowlist", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: " read ", arguments: {} },
          { type: "toolCall", id: "call_2", name: " write ", arguments: {} },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallInputs(input, { allowedToolNames: ["read"] });
    const toolCalls = getAssistantToolCallBlocks(out);

    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { name?: unknown }).name).toBe("read");
  });

  it("preserves other block properties when trimming tool names", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: " read ", arguments: { path: "/tmp/test" } },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallInputs(input);
    const toolCalls = getAssistantToolCallBlocks(out);

    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { name?: unknown }).name).toBe("read");
    expect((toolCalls[0] as { id?: unknown }).id).toBe("call_1");
    expect((toolCalls[0] as { arguments?: unknown }).arguments).toEqual({ path: "/tmp/test" });
  });
});

describe("sanitizeToolNameLengths", () => {
  it("returns original array when all names are within limit", () => {
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] },
      {
        role: "toolResult",
        toolCallId: "1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 1,
      },
    ] as unknown as AgentMessage[];

    const result = sanitizeToolNameLengths(messages);
    expect(result).toBe(messages);
  });

  it("truncates toolResult.toolName exceeding 200 chars", () => {
    const longName = "x".repeat(930);
    const messages = [
      {
        role: "toolResult",
        toolCallId: "1",
        toolName: longName,
        content: [{ type: "text", text: "Tool not found" }],
        isError: true,
        timestamp: 1,
      },
    ] as unknown as AgentMessage[];

    const result = sanitizeToolNameLengths(messages);
    expect(result).not.toBe(messages);
    const toolResult = result[0] as { toolName: string };
    expect(toolResult.toolName).toHaveLength(200);
    expect(toolResult.toolName).toBe("x".repeat(200));
  });

  it("truncates assistant toolCall block name exceeding 200 chars", () => {
    const longName = "a".repeat(300);
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run this" },
          { type: "toolCall", id: "1", name: longName, arguments: {} },
        ],
      },
    ] as unknown as AgentMessage[];

    const result = sanitizeToolNameLengths(messages);
    expect(result).not.toBe(messages);
    const assistant = result[0] as { content: Array<{ name?: string }> };
    expect(assistant.content[1].name).toHaveLength(200);
  });

  it("truncates both sides consistently for paired messages", () => {
    const longName = "tool_" + "z".repeat(250);
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: longName, arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: longName,
        content: [{ type: "text", text: "error" }],
        isError: true,
        timestamp: 1,
      },
    ] as unknown as AgentMessage[];

    const result = sanitizeToolNameLengths(messages);
    const assistantName = (result[0] as { content: Array<{ name?: string }> }).content[0].name;
    const toolResultName = (result[1] as { toolName: string }).toolName;
    expect(assistantName).toBe(toolResultName);
    expect(assistantName).toHaveLength(200);
  });

  it("does not modify names at exactly 200 chars", () => {
    const exactName = "b".repeat(200);
    const messages = [
      {
        role: "toolResult",
        toolCallId: "1",
        toolName: exactName,
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 1,
      },
    ] as unknown as AgentMessage[];

    const result = sanitizeToolNameLengths(messages);
    expect(result).toBe(messages);
  });

  it("handles toolUse and functionCall block types", () => {
    const longName = "c".repeat(201);
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "1", name: longName, input: {} },
          { type: "functionCall", id: "2", name: longName, arguments: {} },
        ],
      },
    ] as unknown as AgentMessage[];

    const result = sanitizeToolNameLengths(messages);
    const blocks = (result[0] as { content: Array<{ name?: string }> }).content;
    expect(blocks[0].name).toHaveLength(200);
    expect(blocks[1].name).toHaveLength(200);
  });

  it("passes through non-object messages unchanged", () => {
    const messages = [null, undefined, "text"] as unknown as AgentMessage[];
    const result = sanitizeToolNameLengths(messages);
    expect(result).toBe(messages);
  });
});
