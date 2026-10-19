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

const toolCall = (id: string, name = "read", args: Record<string, unknown> = {}) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const signedAssistant = (thinkingSignature: string, ...calls: unknown[]) =>
  sparseAssistant([{ type: "thinking", thinking: "Recorded work", thinkingSignature }, ...calls]);
const legacyRead = (id: string, path: string) => ({
  type: "toolUse",
  id,
  name: "read",
  input: { path },
});
const bareResult = (toolCallId: string, text: string) => ({
  role: "toolResult",
  toolCallId,
  content: [{ type: "text", text }],
});
const partialCall = (id: string, partialJson: string, args: Record<string, unknown> = {}) => ({
  ...toolCall(id, "Bash", args),
  partialJson,
});
const signedRead = { allowedToolNames: ["read"], allowProviderOwnedThinkingReplay: true };
const roles = (messages: AgentMessage[]) => messages.map(({ role }) => role);

const TOOL_CALL_BLOCK_TYPES = new Set([
  "toolCall",
  "toolUse",
  "functionCall",
  "tool_call",
  "tool_use",
  "function_call",
]);

function getAssistantToolCallBlocks(
  messages: AgentMessage[],
): Array<{ type?: unknown; id?: unknown; name?: unknown }> {
  const assistant = messages[0];
  if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) {
    return [];
  }
  return assistant.content.filter(({ type }) => TOOL_CALL_BLOCK_TYPES.has(type));
}

describe("sanitizeToolUseResultPairing", () => {
  it("keeps matched parallel tool results and synthesizes only missing siblings", () => {
    const input = castAgentMessages([
      sparseAssistant([
        { type: "text", text: "checking" },
        toolCall("call_1"),
        toolCall("call_2", "exec"),
        toolCall("call_3", "write"),
      ]),
      { role: "user", content: "user message that should come after tool use" },
      textToolResult("call_2", "exec", "ok", { isError: false }),
    ]);

    const result = repairToolUseResultPairing(input, {
      missingToolResultText: "aborted",
    });

    expect(result.added.map((message) => message.toolCallId)).toEqual(["call_1", "call_3"]);
    expect(roles(result.messages)).toEqual([
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
    expect(result.messages.slice(1, 4)).toMatchObject([
      { toolCallId: "call_1" },
      { toolCallId: "call_2" },
      { toolCallId: "call_3" },
    ]);
    expect(JSON.stringify(result.added)).not.toContain("missing tool result");
  });

  it("keeps parallel tool results when code-mode display turns arrive first", () => {
    // Display-only assistant turns must not cause synthetic results before real results arrive.
    const input = castAgentMessages([
      sparseAssistant([
        toolCall("call_search", "lcm_expand_query"),
        toolCall("call_status", "session_status"),
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
    expect(roles(result.messages)).toEqual([
      "assistant",
      "toolResult",
      "toolResult",
      "assistant",
      "user",
    ]);
    expect(result.messages.slice(1, 3)).toMatchObject([
      { toolCallId: "call_search" },
      { toolCallId: "call_status" },
    ]);
    expect(result.moved).toBe(true);
  });

  it("moves late real results ahead of newer assistant tool calls instead of synthesizing", () => {
    const input = castAgentMessages([
      sparseAssistant([toolCall("call_read")]),
      sparseAssistant([toolCall("call_exec", "exec")]),
      textToolResult("call_read", "read", "real read output", { isError: false }),
      textToolResult("call_exec", "exec", "real exec output", { isError: false }),
    ]);

    const result = repairToolUseResultPairing(input);

    expect(result.added).toHaveLength(0);
    expect(roles(result.messages)).toEqual(["assistant", "toolResult", "assistant", "toolResult"]);
    expect(result.messages[1]).toMatchObject({ toolCallId: "call_read", isError: false });
    expect(result.messages[3]).toMatchObject({ toolCallId: "call_exec" });
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
    expect(roles(out)).toEqual(["user", "assistant"]);
  });

  it("retains matching tool results that follow an aborted assistant message", () => {
    const input = castAgentMessages([
      { ...sparseAssistant([toolCall("call_aborted", "exec")]), stopReason: "aborted" },
      textToolResult("call_aborted", "exec", "partial result", { isError: false }),
      { role: "user", content: "retrying" },
    ]);

    const result = repairToolUseResultPairing(input);

    expect(result.droppedOrphanCount).toBe(0);
    expect(roles(result.messages)).toEqual(["assistant", "toolResult", "user"]);
    expect(result.added).toHaveLength(0);
  });
});

describe("repairToolUseResultPairing repeated per-turn ids", () => {
  function makeAssistant(id: string, stopReason: "toolUse" | "error" = "toolUse") {
    return { ...sparseAssistant([toolCall(id, "exec")]), stopReason };
  }

  function makeResult(id: string, text: string, isError = false) {
    return textToolResult(id, "exec", text, { isError });
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
          toolCall("exec_0", "exec", { cmd: "first" }),
          toolCall("exec_0", "exec", { cmd: "second" }),
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
    expect(roles(first.messages)).toEqual([
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
    expect(roles(result.messages)).toEqual(["assistant", "toolResult", "assistant", "toolResult"]);
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
    expect(roles(result.messages)).toEqual(["assistant", "toolResult", "user"]);
    expect(resultTexts(result.messages)).toEqual([DEFAULT_MISSING_TOOL_RESULT_TEXT]);
    expect(JSON.stringify(result.messages)).not.toContain("failed turn output");
  });
});

describe("repairToolUseResultPairing prefers real result over synthetic error", () => {
  function makeSyntheticResult(toolCallId: string) {
    return {
      ...textToolResult(toolCallId, "read", DEFAULT_MISSING_TOOL_RESULT_TEXT, { isError: true }),
      details: { openclawSyntheticMissingToolResult: true },
    };
  }

  function makeRealResult(toolCallId: string, text = "real output") {
    return textToolResult(toolCallId, "read", text, { isError: false });
  }

  function makeAssistant(toolCallId: string) {
    return sparseAssistant([toolCall(toolCallId)]);
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
      sparseAssistant([toolCall("call_2", "write")]),
      makeRealResult("call_1"),
      textToolResult("call_2", "write", "second output", { isError: false }),
    ]);

    const result = repairToolUseResultPairing(input);

    const toolResults = result.messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toMatchObject([
      { toolCallId: "call_1", content: [{ text: "real output" }] },
      { toolCallId: "call_2", content: [{ text: "second output" }] },
    ]);
    expect(toolResults[0]?.isError).not.toBe(true);
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
      toolCall("old_call", "removed_plugin", { action: "done" }),
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
    const later = sparseAssistant([toolCall("old_call")]);
    const laterResult = textToolResult("old_call", "read", "later result", { isError: false });
    expect(
      sanitizeToolCallInputs(castAgentMessages([assistant, later, laterResult]), options),
    ).toEqual([later, laterResult]);
  });

  function sanitizeAssistantToolCalls(
    content: unknown[],
    options?: Parameters<typeof sanitizeToolCallInputs>[1],
  ) {
    return getAssistantToolCallBlocks(
      sanitizeToolCallInputs(castAgentMessages([sparseAssistant(content)]), options),
    );
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
    },
    {
      name: "drops tool calls with malformed or overlong names",
      content: [
        { type: "toolCall", id: "call_ok", name: "read", arguments: {} },
        toolCall("call_bad_chars", 'toolu_01abc <|tool_call_argument_begin|> {"command"'),
        {
          type: "toolUse",
          id: "call_too_long",
          name: `read_${"x".repeat(80)}`,
          input: {},
        },
      ],
    },
  ])("$name", ({ content }) => {
    const toolCalls = sanitizeAssistantToolCalls(content);
    const ids = toolCalls
      .map((block) => block.id)
      .filter((id): id is string => typeof id === "string");

    expect(ids).toEqual(["call_ok"]);
  });

  it("keeps finalized OpenAI Responses calls and drops partialJson streaming artifacts", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          toolCall("call_ok", "read", { path: "/a" }),
          // Finalized legacy Responses calls lose only their scratch buffer.
          partialCall("call_partial|fc_123", '{"command": "ls"}', { command: "ls" }),
          {
            type: "toolCall",
            id: "call_empty|fc_789",
            name: "session_status",
            arguments: {},
            partialJson: "",
          },
          // Interrupted Anthropic and Responses calls remain incomplete, even with parsed args.
          partialCall("toolu_123", '{"command":'),
          partialCall("call_truncated|fc_456", '{"command":"ls"', { command: "ls" }),
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
    const toolCalls = getAssistantToolCallBlocks(sanitizeToolCallInputs(input));
    const ids = toolCalls.map((block) => block.id);
    expect(ids).toEqual(["call_ok", "call_partial|fc_123", "call_empty|fc_789"]);
    expect(toolCalls[1]).not.toHaveProperty("partialJson");
    expect(toolCalls[2]).not.toHaveProperty("partialJson");
  });

  it("drops OpenAI Responses partialJson blocks on stop assistant turns", () => {
    const input = castAgentMessages([
      {
        ...sparseAssistant([
          partialCall("call_partial|fc_123", '{"command":"ls"}', { command: "ls" }),
        ]),
        stopReason: "stop",
      },
      { role: "user", content: "retry" },
    ]);
    expect(getAssistantToolCallBlocks(sanitizeToolCallInputs(input))).toHaveLength(0);
  });

  it("drops signed-thinking assistant turns with partialJson tool calls", () => {
    const input = castAgentMessages([
      {
        ...signedAssistant("sig_partial", {
          ...toolCall("call_partial|fc_123", "exec"),
          partialJson: '{"command":"ls"}',
        }),
        stopReason: "toolUse",
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
      signedAssistant(
        "sig_duplicate",
        toolCall("call_shared", "read", { path: "a" }),
        legacyRead("call_shared", "b"),
      ),
    ]);

    expect(sanitizeToolCallInputs(input, signedRead)).toStrictEqual([]);
  });

  it("drops only later signed-thinking assistant turns that reuse an earlier signed tool id", () => {
    const firstAssistant = signedAssistant(
      "sig_first",
      toolCall("call_shared", "read", { path: "a" }),
    );
    const input = castAgentMessages([
      firstAssistant,
      signedAssistant("sig_second", legacyRead("call_shared", "b")),
    ]);

    expect(sanitizeToolCallInputs(input, signedRead)).toEqual([firstAssistant]);
  });

  it("preserves signed-thinking turns that reuse a mutable earlier tool id", () => {
    const input = castAgentMessages([
      sparseAssistant([toolCall("call_shared", "read", { path: "a" })]),
      bareResult("call_shared", "mutable result"),
      signedAssistant("sig_later", legacyRead("call_shared", "b")),
      {
        ...bareResult("stale_call", "signed result"),
        toolUseId: "call_shared",
      },
    ]);

    expect(sanitizeToolCallInputs(input, signedRead)).toBe(input);
  });

  it("drops signed-thinking reused ids when their real result is displaced", () => {
    const firstAssistant = sparseAssistant([toolCall("call_shared", "read", { path: "a" })]);
    const firstResult = bareResult("call_shared", "mutable result");
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "interstitial" }],
    } as const;
    const displacedResult = bareResult("call_shared", "signed result");
    const input = castAgentMessages([
      firstAssistant,
      firstResult,
      signedAssistant("sig_later", legacyRead("call_shared", "b")),
      userMessage,
      displacedResult,
    ]);

    expect(sanitizeToolCallInputs(input, signedRead)).toEqual([
      firstAssistant,
      firstResult,
      userMessage,
      displacedResult,
    ]);
  });

  it("trims tool names and matches against allowlist", () => {
    const toolCalls = sanitizeAssistantToolCalls(
      [toolCall("call_1", " read "), toolCall("call_2", " write ")],
      { allowedToolNames: ["read"] },
    );
    const names = toolCalls
      .map((block) => block.name)
      .filter((name): name is string => typeof name === "string");
    expect(names).toEqual(["read"]);
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

    expect(Object.hasOwn(out[1] ?? {}, "details")).toBe(true);
    expect((out[1] ?? {}).role).toBe("assistant");
    expect((out[2] ?? {}).role).toBe("user");
    expect(out[3]?.details).toEqual({ openclawSyntheticMissingToolResult: true });
    expect(stripToolResultDetails(out)).toBe(out);
  });
});
