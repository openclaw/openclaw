// Verifies transcript repair pairs tool calls/results and sanitizes tool inputs.
import { DEFAULT_MISSING_TOOL_RESULT_TEXT } from "@openclaw/llm-core/types";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import {
  sanitizeToolCallInputs,
  makeMissingToolResult,
  sanitizeToolUseResultPairing,
  repairToolUseResultPairing,
  stripToolResultDetails,
} from "./session-transcript-repair.js";
import { castAgentMessages } from "./test-helpers/agent-message-fixtures.js";
import { sparseAssistant, textToolResult } from "./test-helpers/sparse-transcript.test-support.js";

const TOOL_CALL_BLOCK_TYPES = new Set([
  "toolCall",
  "toolUse",
  "functionCall",
  "tool_call",
  "tool_use",
  "function_call",
]);

function getAssistantToolCallBlocks(messages: AgentMessage[]) {
  // Helper inspects all legacy/current tool-call block spellings in assistant content.
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
  it("keeps matched parallel tool results and synthesizes only missing siblings", () => {
    const input = castAgentMessages([
      sparseAssistant([
        { type: "text", text: "checking" },
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        { type: "toolCall", id: "call_2", name: "exec", arguments: {} },
        { type: "toolCall", id: "call_3", name: "write", arguments: {} },
      ]),
      { role: "user", content: "user message that should come after tool use" },
      textToolResult("call_2", "exec", "ok", { isError: false }),
    ]);

    const result = repairToolUseResultPairing(input, {
      missingToolResultText: "aborted",
    });

    expect(result.added.map((message) => message.toolCallId)).toEqual(["call_1", "call_3"]);
    expect(result.messages.map((m) => m.role)).toEqual([
      "assistant",
      "toolResult",
      "toolResult",
      "toolResult",
      "user",
    ]);
    expect(
      getAssistantToolCallBlocks(result.messages).map(({ id, name }) => ({ id, name })),
    ).toEqual([
      { id: "call_1", name: "read" },
      { id: "call_2", name: "exec" },
      { id: "call_3", name: "write" },
    ]);
    expect((result.messages[1] as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect((result.messages[2] as { toolCallId?: string }).toolCallId).toBe("call_2");
    expect((result.messages[3] as { toolCallId?: string }).toolCallId).toBe("call_3");
    expect(JSON.stringify(result.added)).not.toContain("missing tool result");
  });

  it("keeps parallel tool results when code-mode display turns arrive first", () => {
    // Display-only assistant turns must not cause synthetic results before real results arrive.
    const input = castAgentMessages([
      sparseAssistant([
        { type: "toolCall", id: "call_search", name: "lcm_expand_query", arguments: {} },
        { type: "toolCall", id: "call_status", name: "session_status", arguments: {} },
      ]),
      {
        role: "assistant",
        content: [{ type: "text", text: "Lcm Expand Query: missing tool result" }],
        stopReason: "stop",
      },
      textToolResult("call_status", "session_status", "ok", { isError: false }),
      textToolResult("call_search", "lcm_expand_query", "expanded", { isError: false }),
      { role: "user", content: "next turn" },
    ]);

    const result = repairToolUseResultPairing(input);

    expect(result.added).toHaveLength(0);
    expect(result.messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "toolResult",
      "assistant",
      "user",
    ]);
    expect((result.messages[1] as { toolCallId?: string }).toolCallId).toBe("call_search");
    expect((result.messages[2] as { toolCallId?: string }).toolCallId).toBe("call_status");
    expect(result.moved).toBe(true);
  });

  it("moves late real results ahead of newer assistant tool calls instead of synthesizing", () => {
    const input = castAgentMessages([
      sparseAssistant([{ type: "toolCall", id: "call_read", name: "read", arguments: {} }]),
      sparseAssistant([{ type: "toolCall", id: "call_exec", name: "exec", arguments: {} }]),
      textToolResult("call_read", "read", "real read output", { isError: false }),
      textToolResult("call_exec", "exec", "real exec output", { isError: false }),
    ]);

    const result = repairToolUseResultPairing(input);

    expect(result.added).toHaveLength(0);
    expect(result.messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
    ]);
    expect((result.messages[1] as { toolCallId?: string; isError?: boolean }).toolCallId).toBe(
      "call_read",
    );
    expect((result.messages[1] as { isError?: boolean }).isError).toBe(false);
    expect((result.messages[3] as { toolCallId?: string; isError?: boolean }).toolCallId).toBe(
      "call_exec",
    );
    expect(JSON.stringify(result.messages)).not.toContain("missing tool result");
    expect(result.moved).toBe(true);
  });

  it("drops orphan tool results that do not match any tool call", () => {
    const input = castAgentMessages([
      { role: "user", content: "hello" },
      textToolResult("call_orphan", "read", "orphan", { isError: false }),
      sparseAssistant([{ type: "text", text: "ok" }]),
    ]);

    const out = sanitizeToolUseResultPairing(input);
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  function createAbortedAssistantTranscript() {
    return castAgentMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_aborted", name: "exec", arguments: {} }],
        stopReason: "aborted",
      },
      textToolResult("call_aborted", "exec", "partial result", { isError: false }),
      { role: "user", content: "retrying" },
    ]);
  }

  it("retains matching tool results that follow an aborted assistant message", () => {
    // Aborted assistant turns do not synthesize missing tool results, but real
    // matching results in the same span remain part of the repaired transcript.
    const input = createAbortedAssistantTranscript();

    const result = repairToolUseResultPairing(input);

    expect(result.droppedOrphanCount).toBe(0);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("toolResult");
    expect(result.messages[2]?.role).toBe("user");
    expect(result.added).toHaveLength(0);
  });
});

describe("repairToolUseResultPairing repeated per-turn ids", () => {
  function makeAssistant(id: string, stopReason: "toolUse" | "error" = "toolUse") {
    return {
      role: "assistant" as const,
      content: [{ type: "toolCall", id, name: "exec", arguments: {} }],
      stopReason,
    };
  }

  function makeResult(id: string, text: string, isError = false) {
    return {
      role: "toolResult" as const,
      toolCallId: id,
      toolName: "exec",
      content: [{ type: "text", text }],
      isError,
    };
  }

  function resultTexts(messages: AgentMessage[]) {
    return messages
      .filter((message) => message.role === "toolResult")
      .map((message) => message.content.find((block) => block.type === "text")?.text);
  }

  it("preserves valid repeated ids across assistant turns without allocating", () => {
    const input = castAgentMessages([
      makeAssistant("exec_0"),
      makeResult("exec_0", "first"),
      { role: "user", content: "next" },
      makeAssistant("exec_0"),
      makeResult("exec_0", "second"),
    ]);

    const result = repairToolUseResultPairing(input);

    expect(result.messages).toBe(input);
    expect(result.added).toHaveLength(0);
    expect(result.droppedDuplicateCount).toBe(0);
    expect(resultTexts(result.messages)).toEqual(["first", "second"]);
  });

  it("preserves every repeated-id occurrence within one assistant turn", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "exec_0", name: "exec", arguments: { cmd: "first" } },
          { type: "toolCall", id: "exec_0", name: "exec", arguments: { cmd: "second" } },
        ],
        stopReason: "toolUse",
      },
      makeResult("exec_0", "first"),
      makeResult("exec_0", "second"),
    ]);

    const result = repairToolUseResultPairing(input);

    expect(result.messages).toBe(input);
    expect(result.added).toHaveLength(0);
    expect(result.droppedDuplicateCount).toBe(0);
    expect(resultTexts(result.messages)).toEqual(["first", "second"]);
  });

  it("synthesizes a later repeated-id occurrence without dropping the replacement", () => {
    const input = castAgentMessages([
      makeAssistant("exec_0"),
      makeResult("exec_0", "first"),
      { role: "user", content: "next" },
      makeAssistant("exec_0"),
    ]);

    const first = repairToolUseResultPairing(input);
    const second = repairToolUseResultPairing(first.messages);

    expect(first.added).toHaveLength(1);
    expect(first.messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(resultTexts(first.messages)).toEqual(["first", DEFAULT_MISSING_TOOL_RESULT_TEXT]);
    expect(second.messages).toBe(first.messages);
  });

  it("keeps a later turn's adjacent repeated-id result local", () => {
    const input = castAgentMessages([
      makeAssistant("exec_0"),
      makeAssistant("exec_0"),
      makeResult("exec_0", "second"),
    ]);

    const result = repairToolUseResultPairing(input);

    expect(result.added).toHaveLength(1);
    expect(resultTexts(result.messages)).toEqual([DEFAULT_MISSING_TOOL_RESULT_TEXT, "second"]);
  });

  it("does not guess between repeated ids when multiple delayed results are ambiguous", () => {
    const input = castAgentMessages([
      makeAssistant("exec_0"),
      makeAssistant("exec_0"),
      makeResult("exec_0", "locally first"),
      makeResult("exec_0", "ambiguous extra"),
    ]);

    const result = repairToolUseResultPairing(input);

    expect(result.added).toHaveLength(1);
    expect(result.droppedDuplicateCount).toBe(1);
    expect(resultTexts(result.messages)).toEqual([
      DEFAULT_MISSING_TOOL_RESULT_TEXT,
      "locally first",
    ]);
  });

  it("treats an unresolved failed occurrence as an ambiguity blocker", () => {
    const input = castAgentMessages([
      makeAssistant("exec_0"),
      makeAssistant("exec_0", "error"),
      makeAssistant("write_0"),
      makeResult("exec_0", "ambiguous displaced output"),
      makeResult("write_0", "write output"),
    ]);

    const result = repairToolUseResultPairing(input, {
      erroredAssistantResultPolicy: "drop",
    });

    expect(result.droppedOrphanCount).toBe(1);
    expect(result.messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
    ]);
    expect(resultTexts(result.messages)).toEqual([
      DEFAULT_MISSING_TOOL_RESULT_TEXT,
      "write output",
    ]);
    expect(JSON.stringify(result.messages)).not.toContain("ambiguous displaced output");
  });

  it("drops a failed turn and its local repeated-id result without leaking it backward", () => {
    const input = castAgentMessages([
      makeAssistant("exec_0"),
      makeAssistant("exec_0", "error"),
      makeResult("exec_0", "failed turn output", true),
      { role: "user", content: "retry" },
    ]);

    const result = repairToolUseResultPairing(input, {
      erroredAssistantResultPolicy: "drop",
    });

    expect(result.added).toHaveLength(1);
    expect(result.messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(resultTexts(result.messages)).toEqual([DEFAULT_MISSING_TOOL_RESULT_TEXT]);
    expect(JSON.stringify(result.messages)).not.toContain("failed turn output");
  });
});

describe("repairToolUseResultPairing prefers real result over synthetic error", () => {
  function makeSyntheticResult(toolCallId: string) {
    return {
      role: "toolResult" as const,
      toolCallId,
      toolName: "read",
      content: [{ type: "text", text: DEFAULT_MISSING_TOOL_RESULT_TEXT }],
      details: { openclawSyntheticMissingToolResult: true },
      isError: true,
    };
  }

  function makeRealResult(toolCallId: string, text = "real output") {
    return {
      role: "toolResult" as const,
      toolCallId,
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
    };
  }

  function makeAssistant(toolCallId: string) {
    return {
      role: "assistant" as const,
      content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: {} }],
    };
  }

  it("returns discarded results in transcript order", () => {
    const input = castAgentMessages([
      makeAssistant("call_1"),
      makeSyntheticResult("call_1"),
      makeRealResult("call_orphan", "orphan"),
      makeRealResult("call_1"),
    ]);

    const result = repairToolUseResultPairing(input);

    expect(result.discarded).toEqual([input[1], input[2]]);
  });

  it("late real result after another assistant turn replaces prior synthetic", () => {
    const input = castAgentMessages([
      makeAssistant("call_1"),
      makeSyntheticResult("call_1"),
      {
        role: "assistant" as const,
        content: [{ type: "toolCall", id: "call_2", name: "write", arguments: {} }],
      },
      makeRealResult("call_1"),
      textToolResult("call_2", "write", "second output", { isError: false }),
    ]);

    const result = repairToolUseResultPairing(input);

    const toolResults = result.messages.filter((m) => m.role === "toolResult") as Array<{
      toolCallId?: string;
      isError?: boolean;
      content?: Array<{ text?: string }>;
    }>;
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]?.toolCallId).toBe("call_1");
    expect(toolResults[0]?.isError).not.toBe(true);
    expect(toolResults[0]?.content?.[0]?.text).toBe("real output");
    expect(toolResults[1]?.toolCallId).toBe("call_2");
    expect(toolResults[1]?.content?.[0]?.text).toBe("second output");
    expect(result.discarded).toEqual([input[1]]);
  });
});

describe("sanitizeToolCallInputs legacy block filtering", () => {
  it("drops malformed snake_case tool call blocks", () => {
    const input = castAgentMessages([
      sparseAssistant([
        { type: "text", text: "before" },
        { type: "tool_use", id: "tool_1", name: "read" },
        { type: "tool_call", tool_call_id: "tool_2", name: "write", arguments: {} },
        { type: "function_call", call_id: "tool_3", name: "exec", arguments: "{}" },
      ]),
    ]);

    const out = sanitizeToolCallInputs(input, { allowedToolNames: ["write", "exec"] });

    expect(getAssistantToolCallBlocks(out).map(({ type, name }) => ({ type, name }))).toEqual([
      { type: "tool_call", name: "write" },
      { type: "function_call", name: "exec" },
    ]);
  });
});

describe("sanitizeToolCallInputs allowed-name filtering", () => {
  it.each([false, true])("preserves completed removed tools (signed thinking: %s)", (signed) => {
    const assistant = sparseAssistant([
      ...(signed
        ? [{ type: "thinking", thinking: "Recorded work", thinkingSignature: "sig_old" }]
        : []),
      { type: "toolCall", id: "old_call", name: "removed_plugin", arguments: { action: "done" } },
    ]);
    const input = castAgentMessages([
      assistant,
      textToolResult("old_call", "removed_plugin", "completed-action-id", { isError: false }),
    ]);
    const options = { allowedToolNames: ["read"], allowProviderOwnedThinkingReplay: signed };
    expect(sanitizeToolCallInputs(input, options)).toBe(input);
    expect(sanitizeToolCallInputs(castAgentMessages([assistant]), options)).toEqual([]);
    for (const result of [
      textToolResult("other_call", "removed_plugin", "unrelated result", { isError: false }),
      makeMissingToolResult({ toolCallId: "old_call", toolName: "removed_plugin" }),
    ]) {
      expect(sanitizeToolCallInputs(castAgentMessages([assistant, result]), options)).toEqual([
        result,
      ]);
    }
    const later = sparseAssistant([
      { type: "toolCall", id: "old_call", name: "read", arguments: {} },
    ]);
    const laterResult = textToolResult("old_call", "read", "later result", { isError: false });
    expect(
      sanitizeToolCallInputs(castAgentMessages([assistant, later, laterResult]), options),
    ).toEqual([later, laterResult]);
  });

  function sanitizeAssistantContent(
    content: unknown[],
    options?: Parameters<typeof sanitizeToolCallInputs>[1],
  ) {
    return sanitizeToolCallInputs(
      castAgentMessages([
        {
          role: "assistant",
          content,
        },
      ]),
      options,
    );
  }

  function sanitizeAssistantToolCalls(
    content: unknown[],
    options?: Parameters<typeof sanitizeToolCallInputs>[1],
  ) {
    return getAssistantToolCallBlocks(sanitizeAssistantContent(content, options));
  }

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
  ])("$name", ({ content, options, expectedIds }) => {
    const toolCalls = sanitizeAssistantToolCalls(content, options);
    const ids = toolCalls
      .map((toolCall) => (toolCall as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string");

    expect(ids).toEqual(expectedIds);
  });

  it("keeps finalized OpenAI Responses calls and drops partialJson streaming artifacts", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          // complete tool call — kept as-is
          { type: "toolCall", id: "call_ok", name: "read", arguments: { path: "/a" } },
          // Legacy generic Responses transport persisted finalized toolUse
          // turns with partialJson; repair strips the scratch field.
          {
            type: "toolCall",
            id: "call_partial|fc_123",
            name: "Bash",
            arguments: { command: "ls" },
            partialJson: '{"command": "ls"}',
          },
          {
            type: "toolCall",
            id: "call_empty|fc_789",
            name: "session_status",
            arguments: {},
            partialJson: "",
          },
          // Anthropic can persist initialized tool calls with arguments: {}
          // plus partialJson if the stream aborts before content_block_stop.
          // Those incomplete artifacts must be dropped.
          {
            type: "toolCall",
            id: "toolu_123",
            name: "Bash",
            arguments: {},
            partialJson: '{"command":',
          },
          // An OpenAI-shaped id and parsed partial arguments do not prove that
          // response.output_item.done arrived.
          {
            type: "toolCall",
            id: "call_truncated|fc_456",
            name: "Bash",
            arguments: { command: "ls" },
            partialJson: '{"command":"ls"',
          },
          // Missing required input is also an interrupted artifact and should drop.
          {
            type: "toolUse",
            id: "call_partial2",
            name: "read",
            input: null,
            partialJson: '{"path":',
          },
        ],
      },
      { role: "user", content: "retry" },
    ]);
    const out = sanitizeToolCallInputs(input);
    const toolCalls = getAssistantToolCallBlocks(out);
    const ids = toolCalls.map((t) => (t as { id?: unknown }).id);
    expect(ids).toEqual(["call_ok", "call_partial|fc_123", "call_empty|fc_789"]);
    expect(toolCalls[1]).not.toHaveProperty("partialJson");
    expect(toolCalls[2]).not.toHaveProperty("partialJson");
  });

  it.each(["stop"] as const)(
    "drops OpenAI Responses partialJson blocks on %s assistant turns",
    (stopReason) => {
      const input = castAgentMessages([
        {
          role: "assistant",
          stopReason,
          content: [
            {
              type: "toolCall",
              id: "call_partial|fc_123",
              name: "Bash",
              arguments: { command: "ls" },
              partialJson: '{"command":"ls"}',
            },
          ],
        },
        { role: "user", content: "retry" },
      ]);

      const out = sanitizeToolCallInputs(input);
      expect(getAssistantToolCallBlocks(out)).toHaveLength(0);
    },
  );

  it("drops signed-thinking assistant turns when sibling tool calls are not replay-safe", () => {
    const input = castAgentMessages([
      sparseAssistant([
        {
          type: "thinking",
          thinking: "Let me check the gateway config.",
          thinkingSignature: "sig_gateway",
        },
        {
          type: "toolCall",
          id: "call_gateway",
          name: "gateway",
          arguments: {
            action: "config.get",
            path: "channels.telegram",
          },
        },
      ]),
    ]);

    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["read"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toStrictEqual([]);
  });

  it("drops signed-thinking assistant turns with partialJson tool calls", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "thinking",
            thinking: "Let me run a command.",
            thinkingSignature: "sig_partial",
          },
          {
            type: "toolCall",
            id: "call_partial|fc_123",
            name: "exec",
            arguments: {},
            partialJson: '{"command":"ls"}',
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["exec"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toStrictEqual([]);
  });

  it("drops signed-thinking assistant turns when sibling tool calls reuse an id", () => {
    const input = castAgentMessages([
      sparseAssistant([
        {
          type: "thinking",
          thinking: "Let me reuse the tool id.",
          thinkingSignature: "sig_duplicate",
        },
        { type: "toolCall", id: "call_shared", name: "read", arguments: { path: "a" } },
        { type: "toolUse", id: "call_shared", name: "read", input: { path: "b" } },
      ]),
    ]);

    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["read"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toStrictEqual([]);
  });

  it("drops only later signed-thinking assistant turns that reuse an earlier signed tool id", () => {
    const firstAssistant = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "First signed replay turn.",
          thinkingSignature: "sig_first",
        },
        { type: "toolCall", id: "call_shared", name: "read", arguments: { path: "a" } },
      ],
    } as const;
    const input = castAgentMessages([
      firstAssistant,
      sparseAssistant([
        {
          type: "thinking",
          thinking: "Second signed replay turn.",
          thinkingSignature: "sig_second",
        },
        { type: "toolUse", id: "call_shared", name: "read", input: { path: "b" } },
      ]),
    ]);

    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["read"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toEqual([firstAssistant]);
  });

  it("preserves signed-thinking turns that reuse a mutable earlier tool id", () => {
    const input = castAgentMessages([
      sparseAssistant([
        { type: "toolCall", id: "call_shared", name: "read", arguments: { path: "a" } },
      ]),
      {
        role: "toolResult",
        toolCallId: "call_shared",
        content: [{ type: "text", text: "mutable result" }],
      },
      sparseAssistant([
        {
          type: "thinking",
          thinking: "Signed replay can keep its provider-owned id.",
          thinkingSignature: "sig_later",
        },
        { type: "toolUse", id: "call_shared", name: "read", input: { path: "b" } },
      ]),
      {
        role: "toolResult",
        toolCallId: "stale_call",
        toolUseId: "call_shared",
        content: [{ type: "text", text: "signed result" }],
      },
    ]);

    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["read"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toBe(input);
  });

  it("drops signed-thinking reused ids when their real result is displaced", () => {
    const firstAssistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_shared", name: "read", arguments: { path: "a" } }],
    } as const;
    const firstResult = {
      role: "toolResult",
      toolCallId: "call_shared",
      content: [{ type: "text", text: "mutable result" }],
    } as const;
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "interstitial" }],
    } as const;
    const displacedResult = {
      role: "toolResult",
      toolCallId: "call_shared",
      content: [{ type: "text", text: "signed result" }],
    } as const;
    const input = castAgentMessages([
      firstAssistant,
      firstResult,
      sparseAssistant([
        {
          type: "thinking",
          thinking: "Signed replay has a displaced result.",
          thinkingSignature: "sig_later",
        },
        { type: "toolUse", id: "call_shared", name: "read", input: { path: "b" } },
      ]),
      userMessage,
      displacedResult,
    ]);

    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["read"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toEqual([firstAssistant, firstResult, userMessage, displacedResult]);
  });

  it.each([
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
});

describe("stripToolResultDetails", () => {
  it("strips opaque details and keeps synthetic projections stable", () => {
    const input = castAgentMessages([
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        details: { internal: true },
      },
      { role: "assistant", content: [{ type: "text", text: "keep me" }], details: { no: "touch" } },
      { role: "user", content: "hello" },
      {
        ...makeMissingToolResult({ toolCallId: "missing", toolName: "read" }),
        details: { internal: true, openclawSyntheticMissingToolResult: true },
      },
    ]);

    const out = stripToolResultDetails(input) as unknown as Array<Record<string, unknown>>;

    expect(Object.hasOwn(out[0] ?? {}, "details")).toBe(false);
    expect((out[0] ?? {}).role).toBe("toolResult");

    // Non-toolResult messages are preserved as-is.
    expect(Object.hasOwn(out[1] ?? {}, "details")).toBe(true);
    expect((out[1] ?? {}).role).toBe("assistant");
    expect((out[2] ?? {}).role).toBe("user");
    expect(out[3]?.details).toEqual({ openclawSyntheticMissingToolResult: true });
    expect(stripToolResultDetails(out)).toBe(out);
  });
});
