import { DEFAULT_MISSING_TOOL_RESULT_TEXT } from "@openclaw/llm-core/types";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const user = (content: string) => ({ role: "user" as const, content });
const textAssistant = (text: string) => sparseAssistant([{ type: "text", text }]);
afterEach(() => vi.restoreAllMocks());

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
  it("does not inspect lower-priority result aliases when the canonical id is present", () => {
    const legacyId = vi.fn(() => "stale_call");
    const result = textToolResult("call_1", "read", "ok", { isError: false });
    Object.defineProperty(result, "toolUseId", { get: legacyId });
    const input = castAgentMessages([sparseAssistant([toolCall("call_1")]), result]);

    expect(repairToolUseResultPairing(input).messages).toBe(input);
    expect(legacyId).not.toHaveBeenCalled();
  });

  it("keeps matched parallel tool results and synthesizes only missing siblings", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const input = castAgentMessages([
      sparseAssistant([
        { type: "text", text: "checking" },
        toolCall("call_1"),
        toolCall("call_2", "exec"),
        toolCall("call_3", "write"),
      ]),
      user("user message that should come after tool use"),
      textToolResult("call_2", "exec", "ok", { isError: false }),
    ]);
    const expected = structuredClone(input);
    const result = repairToolUseResultPairing(input, {
      missingToolResultText: "aborted",
    });

    expect(result.added).toMatchObject([
      { toolCallId: "call_1", timestamp: 5_000 },
      { toolCallId: "call_3", timestamp: 5_000 },
    ]);
    expect(result.messages).toEqual([
      expected[0],
      result.added[0],
      expected[2],
      result.added[1],
      expected[1],
    ]);
    expect(JSON.stringify(result.added)).not.toContain("missing tool result");
  });

  it("keeps sparse legacy replay stable while preserving recorded synthetic creation times", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const source = castAgentMessages([sparseAssistant([toolCall("legacy")])]);
    const first = sanitizeToolUseResultPairing(source);
    clock.mockReturnValue(2_000);
    expect(sanitizeToolUseResultPairing(source)).toEqual(first);
    expect(first[1]).toMatchObject({ toolCallId: "legacy", timestamp: 0 });

    const recorded = makeMissingToolResult({ toolCallId: "legacy", toolName: "read" });
    expect(recorded.timestamp).toBe(2_000);
    clock.mockReturnValue(3_000);
    expect(sanitizeToolUseResultPairing([...source, recorded])[1]).toBe(recorded);
  });

  it("keeps parallel tool results when code-mode display turns arrive first", () => {
    // Display-only assistant turns must not cause synthetic results before real results arrive.
    const input = castAgentMessages([
      sparseAssistant([
        toolCall("call_search", "lcm_expand_query"),
        toolCall("call_status", "session_status"),
      ]),
      { ...textAssistant("Lcm Expand Query: missing tool result"), stopReason: "stop" },
      textToolResult("call_status", "session_status", "ok", { isError: false }),
      textToolResult("call_search", "lcm_expand_query", "expanded", { isError: false }),
      user("next turn"),
    ]);
    const expected = structuredClone(input);
    const result = repairToolUseResultPairing(input);

    expect(result.added).toHaveLength(0);
    expect(result.messages).toEqual([
      expected[0],
      expected[3],
      expected[2],
      expected[1],
      expected[4],
    ]);
  });

  it("moves late real results ahead of newer assistant tool calls instead of synthesizing", () => {
    const input = castAgentMessages([
      sparseAssistant([toolCall("call_read")]),
      sparseAssistant([toolCall("call_exec", "exec")]),
      textToolResult("call_read", "read", "real read output", { isError: false }),
      textToolResult("call_exec", "exec", "real exec output", { isError: false }),
    ]);
    const expected = structuredClone(input);
    const result = repairToolUseResultPairing(input);

    expect(result.added).toHaveLength(0);
    expect(result.messages).toEqual([expected[0], expected[2], expected[1], expected[3]]);
  });

  it("drops orphan tool results that do not match any tool call", () => {
    const input = castAgentMessages([
      user("hello"),
      textToolResult("call_orphan", "read", "orphan", { isError: false }),
      textAssistant("ok"),
    ]);

    const out = sanitizeToolUseResultPairing(input);
    expect(roles(out)).toEqual(["user", "assistant"]);
  });

  it("retains matching tool results that follow an aborted assistant message", () => {
    const input = castAgentMessages([
      { ...sparseAssistant([toolCall("call_aborted", "exec")]), stopReason: "aborted" },
      textToolResult("call_aborted", "exec", "partial result", { isError: false }),
      user("retrying"),
    ]);
    const expected = structuredClone(input);
    const result = repairToolUseResultPairing(input);

    expect(result.messages).toEqual(expected);
    expect(result.added).toHaveLength(0);
  });
});

describe("repairToolUseResultPairing repeated per-turn ids", () => {
  const call = (id = "exec_0", stopReason = "toolUse") => ({
    ...sparseAssistant([toolCall(id, "exec")]),
    stopReason,
  });
  const result = (text: string, id = "exec_0", isError = false) =>
    textToolResult(id, "exec", text, { isError });
  const missing = DEFAULT_MISSING_TOOL_RESULT_TEXT;

  it.each([
    {
      name: "preserves valid repeated ids across assistant turns without allocating",
      input: [call(), result("first"), user("next"), call(), result("second")],
    },
    {
      name: "preserves every repeated-id occurrence within one assistant turn",
      input: [
        {
          ...call(),
          content: [
            toolCall("exec_0", "exec", { cmd: "first" }),
            toolCall("exec_0", "exec", { cmd: "second" }),
          ],
        },
        result("first"),
        result("second"),
      ],
    },
  ])("$name", ({ input: raw }) => {
    const input = castAgentMessages(raw);
    const repaired = repairToolUseResultPairing(input);
    expect(repaired.messages).toBe(input);
    expect(repaired.added).toEqual([]);
    expect(repaired.messages.filter((message) => message.role === "toolResult")).toEqual([
      result("first"),
      result("second"),
    ]);
  });

  it.each([
    {
      name: "synthesizes a later repeated-id occurrence without dropping the replacement",
      input: [call(), result("first"), user("next"), call()],
      expectedRoles: ["assistant", "toolResult", "user", "assistant", "toolResult"],
      texts: ["first", missing],
      idempotent: true,
    },
    {
      name: "keeps a later turn's adjacent repeated-id result local",
      input: [call(), call(), result("second")],
      texts: [missing, "second"],
    },
    {
      name: "does not guess between repeated ids when multiple delayed results are ambiguous",
      input: [call(), call(), result("locally first"), result("ambiguous extra")],
      texts: [missing, "locally first"],
    },
    {
      name: "treats an unresolved failed occurrence as an ambiguity blocker",
      input: [
        call(),
        call("exec_0", "error"),
        call("write_0"),
        result("ambiguous displaced output"),
        result("write output", "write_0"),
      ],
      drop: true,
      texts: [missing, "write output"],
      forbidden: "ambiguous displaced output",
    },
    {
      name: "drops a failed turn and its local repeated-id result without leaking it backward",
      input: [
        call(),
        call("exec_0", "error"),
        result("failed turn output", "exec_0", true),
        user("retry"),
      ],
      drop: true,
      expectedRoles: ["assistant", "toolResult", "user"],
      texts: [missing],
      forbidden: "failed turn output",
    },
  ])("$name", ({ input, drop, expectedRoles, texts, forbidden, idempotent }) => {
    const repaired = repairToolUseResultPairing(
      castAgentMessages(input),
      drop ? { erroredAssistantResultPolicy: "drop" } : undefined,
    );
    expect(repaired.added).toHaveLength(1);
    expect(roles(repaired.messages)).toEqual(
      expectedRoles ?? ["assistant", "toolResult", "assistant", "toolResult"],
    );
    expect(
      repaired.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => message.content.find((block) => block.type === "text")?.text),
    ).toEqual(texts);
    if (forbidden) {
      expect(JSON.stringify(repaired.messages)).not.toContain(forbidden);
    }
    if (idempotent) {
      expect(repairToolUseResultPairing(repaired.messages).messages).toBe(repaired.messages);
    }
  });
});

describe("repairToolUseResultPairing prefers real result over synthetic error", () => {
  function makeSyntheticResult(toolCallId: string) {
    return {
      ...textToolResult(toolCallId, "read", DEFAULT_MISSING_TOOL_RESULT_TEXT, { isError: true }),
      details: { openclawSyntheticMissingToolResult: true },
    };
  }

  it("keeps a legacy real result's outcome while dropping its synthetic predecessor and an orphan", () => {
    const input = castAgentMessages([
      sparseAssistant([toolCall("call_1")]),
      makeSyntheticResult("call_1"),
      textToolResult("call_orphan", "read", "orphan", { isError: false }),
      textToolResult("", "read", "real output", { isError: false }),
    ]);

    const result = repairToolUseResultPairing(input);

    expect(result.messages).toEqual([input[0], { ...input[3], toolCallId: "call_1" }]);
  });

  it("late real result after another assistant turn replaces prior synthetic", () => {
    const input = castAgentMessages([
      sparseAssistant([toolCall("call_1")]),
      makeSyntheticResult("call_1"),
      sparseAssistant([toolCall("call_2", "write")]),
      textToolResult("call_1", "read", "real output", { isError: false }),
      textToolResult("call_2", "write", "second output", { isError: false }),
    ]);

    const result = repairToolUseResultPairing(input);

    const toolResults = result.messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toMatchObject([
      { toolCallId: "call_1", content: [{ text: "real output" }] },
      { toolCallId: "call_2", content: [{ text: "second output" }] },
    ]);
    expect(toolResults[0]?.isError).not.toBe(true);
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
        toolCall("call_ok"),
        toolCall("call_empty_name", ""),
        { type: "toolUse", id: "call_blank_name", name: "   ", input: {} },
        { type: "functionCall", id: "", name: "exec", arguments: {} },
      ],
    },
    {
      name: "drops tool calls with malformed or overlong names",
      content: [
        toolCall("call_ok"),
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
          { ...toolCall("call_empty|fc_789", "session_status"), partialJson: "" },
          // Interrupted Anthropic and Responses calls remain incomplete, even with parsed args.
          partialCall("toolu_123", '{"command":'),
          partialCall("call_truncated|fc_456", '{"command":"ls"', { command: "ls" }),
          // Missing required input is also an interrupted artifact and should drop.
          { ...legacyRead("call_partial2", ""), input: null, partialJson: '{"path":' },
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

  const mutable = () => sparseAssistant([toolCall("call_shared", "read", { path: "a" })]);
  const mutableResult = () => bareResult("call_shared", "mutable result");
  const signed = (signature: string) => signedAssistant(signature, legacyRead("call_shared", "b"));
  it.each([
    {
      name: "drops signed-thinking assistant turns with partialJson tool calls",
      input: [
        {
          ...signedAssistant("sig_partial", {
            ...toolCall("call_partial|fc_123", "exec"),
            partialJson: '{"command":"ls"}',
          }),
          stopReason: "toolUse",
        },
      ],
      allowedToolNames: ["exec"],
      kept: [],
    },
    {
      name: "drops signed-thinking assistant turns when sibling tool calls reuse an id",
      input: [
        signedAssistant(
          "sig_duplicate",
          toolCall("call_shared", "read", { path: "a" }),
          legacyRead("call_shared", "b"),
        ),
      ],
      kept: [],
    },
    {
      name: "drops only later signed-thinking assistant turns that reuse an earlier signed tool id",
      input: [
        signedAssistant("sig_first", toolCall("call_shared", "read", { path: "a" })),
        signed("sig_second"),
      ],
      kept: [0],
    },
    {
      name: "preserves signed-thinking turns that reuse a mutable earlier tool id",
      input: [
        mutable(),
        mutableResult(),
        signed("sig_later"),
        { ...bareResult("stale_call", "signed result"), toolUseId: "call_shared" },
      ],
      unchanged: true,
      kept: [0, 1, 2, 3],
    },
    {
      name: "drops signed-thinking reused ids when their real result is displaced",
      input: [
        mutable(),
        mutableResult(),
        signed("sig_later"),
        { role: "user", content: [{ type: "text", text: "interstitial" }] },
        bareResult("call_shared", "signed result"),
      ],
      kept: [0, 1, 3, 4],
    },
  ])("$name", ({ input: raw, kept, unchanged, allowedToolNames }) => {
    const input = castAgentMessages(raw);
    const expected = structuredClone(kept.map((index) => input[index]));
    const output = sanitizeToolCallInputs(input, {
      ...signedRead,
      ...(allowedToolNames ? { allowedToolNames } : {}),
    });
    expect(output).toStrictEqual(expected);
    if (unchanged) {
      expect(output).toBe(input);
    }
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
      { ...textToolResult("call_1", "read", "ok"), details: { internal: true } },
      { ...textAssistant("keep me"), details: { no: "touch" } },
      user("hello"),
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
