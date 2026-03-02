import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  sanitizeToolCallInputs,
  sanitizeToolUseResultPairing,
  repairToolUseResultPairing,
  stripToolResultDetails,
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

  it("repairs blank tool result names from matching tool calls", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "   ",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    const toolResult = out.find((message) => message.role === "toolResult") as {
      toolName?: string;
    };

    expect(toolResult?.toolName).toBe("read");
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
  function sanitizeAssistantContent(
    content: unknown[],
    options?: Parameters<typeof sanitizeToolCallInputs>[1],
  ) {
    return sanitizeToolCallInputs(
      [
        {
          role: "assistant",
          content,
        },
      ] as unknown as AgentMessage[],
      options,
    );
  }

  function sanitizeAssistantToolCalls(
    content: unknown[],
    options?: Parameters<typeof sanitizeToolCallInputs>[1],
  ) {
    return getAssistantToolCallBlocks(sanitizeAssistantContent(content, options));
  }

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

  it.each([
    {
      name: "drops tool calls with missing or blank name/id",
      content: [
        { type: "toolCall", id: "call_ok", name: "read", arguments: {} },
        { type: "toolCall", id: "call_empty_name", name: "", arguments: {} },
        { type: "toolUse", id: "call_blank_name", name: "   ", input: {} },
        { type: "functionCall", id: "", name: "exec", arguments: {} },
      ],
      options: undefined,
      expectedIds: ["call_ok"],
    },
    {
      name: "drops tool calls with malformed or overlong names",
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
      options: undefined,
      expectedIds: ["call_ok"],
    },
    {
      name: "drops unknown tool names when an allowlist is provided",
      content: [
        { type: "toolCall", id: "call_ok", name: "read", arguments: {} },
        { type: "toolCall", id: "call_unknown", name: "write", arguments: {} },
      ],
      options: { allowedToolNames: ["read"] },
      expectedIds: ["call_ok"],
    },
  ])("$name", ({ content, options, expectedIds }) => {
    const toolCalls = sanitizeAssistantToolCalls(content, options);
    const ids = toolCalls
      .map((toolCall) => (toolCall as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string");

    expect(ids).toEqual(expectedIds);
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

  it.each([
    {
      name: "trims leading whitespace from tool names",
      content: [{ type: "toolCall", id: "call_1", name: " read", arguments: {} }],
      options: undefined,
      expectedNames: ["read"],
    },
    {
      name: "trims trailing whitespace from tool names",
      content: [{ type: "toolUse", id: "call_1", name: "exec ", input: { command: "ls" } }],
      options: undefined,
      expectedNames: ["exec"],
    },
    {
      name: "trims both leading and trailing whitespace from tool names",
      content: [
        { type: "toolCall", id: "call_1", name: " read ", arguments: {} },
        { type: "toolUse", id: "call_2", name: "  exec  ", input: {} },
      ],
      options: undefined,
      expectedNames: ["read", "exec"],
    },
    {
      name: "trims tool names and matches against allowlist",
      content: [
        { type: "toolCall", id: "call_1", name: " read ", arguments: {} },
        { type: "toolCall", id: "call_2", name: " write ", arguments: {} },
      ],
      options: { allowedToolNames: ["read"] },
      expectedNames: ["read"],
    },
  ])("$name", ({ content, options, expectedNames }) => {
    const toolCalls = sanitizeAssistantToolCalls(content, options);
    const names = toolCalls
      .map((toolCall) => (toolCall as { name?: unknown }).name)
      .filter((name): name is string => typeof name === "string");
    expect(names).toEqual(expectedNames);
  });

  it("preserves toolUse input shape for sessions_spawn when no attachments are present", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "call_1",
            name: "sessions_spawn",
            input: { task: "hello" },
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallInputs(input);
    const toolCalls = getAssistantToolCallBlocks(out) as Array<Record<string, unknown>>;

    expect(toolCalls).toHaveLength(1);
    expect(Object.hasOwn(toolCalls[0] ?? {}, "input")).toBe(true);
    expect(Object.hasOwn(toolCalls[0] ?? {}, "arguments")).toBe(false);
    expect((toolCalls[0] ?? {}).input).toEqual({ task: "hello" });
  });

  it("redacts sessions_spawn attachments for mixed-case and padded tool names", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "call_1",
            name: "  SESSIONS_SPAWN  ",
            input: {
              task: "hello",
              attachments: [{ name: "a.txt", content: "SECRET" }],
            },
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallInputs(input);
    const toolCalls = getAssistantToolCallBlocks(out) as Array<Record<string, unknown>>;

    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] ?? {}).name).toBe("SESSIONS_SPAWN");
    const inputObj = (toolCalls[0]?.input ?? {}) as Record<string, unknown>;
    const attachments = (inputObj.attachments ?? []) as Array<Record<string, unknown>>;
    expect(attachments[0]?.content).toBe("__OPENCLAW_REDACTED__");
  });
  it("preserves other block properties when trimming tool names", () => {
    const toolCalls = sanitizeAssistantToolCalls([
      { type: "toolCall", id: "call_1", name: " read ", arguments: { path: "/tmp/test" } },
    ]);

    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { name?: unknown }).name).toBe("read");
    expect((toolCalls[0] as { id?: unknown }).id).toBe("call_1");
    expect((toolCalls[0] as { arguments?: unknown }).arguments).toEqual({ path: "/tmp/test" });
  });
});

describe("stripToolResultDetails", () => {
  it("removes details only from toolResult messages", () => {
    const input = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        details: { internal: true },
      },
      { role: "assistant", content: [{ type: "text", text: "keep me" }], details: { no: "touch" } },
      { role: "user", content: "hello" },
    ] as unknown as AgentMessage[];

    const out = stripToolResultDetails(input) as unknown as Array<Record<string, unknown>>;

    expect(Object.hasOwn(out[0] ?? {}, "details")).toBe(false);
    expect((out[0] ?? {}).role).toBe("toolResult");

    // Non-toolResult messages are preserved as-is.
    expect(Object.hasOwn(out[1] ?? {}, "details")).toBe(true);
    expect((out[1] ?? {}).role).toBe("assistant");
    expect((out[2] ?? {}).role).toBe("user");
  });

  it("returns the same array reference when there are no toolResult details", () => {
    const input = [
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
      },
      { role: "user", content: "b" },
    ] as unknown as AgentMessage[];

    const out = stripToolResultDetails(input);
    expect(out).toBe(input);
  });
});
