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
const callAssistant = (id: string, name = "read", stopReason?: string) => ({
  ...sparseAssistant([toolCall(id, name)]),
  ...(stopReason ? { stopReason } : {}),
});
const realResult = (id: string, name = "read", text = "ok") =>
  textToolResult(id, name, text, { isError: false });
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

  it.each([
    {
      name: "keeps parallel results ahead of code-mode display turns",
      input: [
        sparseAssistant([
          toolCall("search", "lcm_expand_query"),
          toolCall("status", "session_status"),
        ]),
        { ...textAssistant("Lcm Expand Query: missing tool result"), stopReason: "stop" },
        realResult("status", "session_status"),
        realResult("search", "lcm_expand_query", "expanded"),
        user("next turn"),
      ],
      order: [0, 3, 2, 1, 4],
    },
    {
      name: "moves late real results ahead of newer assistant calls",
      input: [
        callAssistant("read"),
        callAssistant("exec", "exec"),
        realResult("read"),
        realResult("exec", "exec"),
      ],
      order: [0, 2, 1, 3],
    },
    {
      name: "retains matching results after an aborted assistant message",
      input: [
        callAssistant("aborted", "exec", "aborted"),
        realResult("aborted", "exec", "partial result"),
        user("retrying"),
      ],
      order: [0, 1, 2],
    },
    {
      name: "drops unframed orphan results",
      input: [user("hello"), realResult("orphan", "read", "orphan"), textAssistant("ok")],
      order: [0, 2],
    },
  ])("$name without synthesizing results", ({ input: raw, order }) => {
    const input = castAgentMessages(raw);
    const expected = structuredClone(order.map((index) => input[index]));
    const result = repairToolUseResultPairing(input);
    expect(result.added).toHaveLength(0);
    expect(result.messages).toEqual(expected);
  });
});

describe("repeated tool-call ids", () => {
  const call = (id = "exec_0", stopReason = "toolUse") => callAssistant(id, "exec", stopReason);
  const result = (text: string, id = "exec_0", isError = false) =>
    textToolResult(id, "exec", text, { isError });
  const missing = DEFAULT_MISSING_TOOL_RESULT_TEXT;
  it.each([
    ["across turns", [call(), result("first"), user("next"), call(), result("second")]],
    [
      "within one turn",
      [
        sparseAssistant([
          toolCall("exec_0", "exec", { cmd: "first" }),
          toolCall("exec_0", "exec", { cmd: "second" }),
        ]),
        result("first"),
        result("second"),
      ],
    ],
  ] as const)("preserves repeated ids %s without allocating", (_name, raw) => {
    const input = castAgentMessages([...raw]);
    const repaired = repairToolUseResultPairing(input);
    expect(repaired.messages).toBe(input);
    expect(repaired.added).toEqual([]);
    expect(repaired.messages.filter(({ role }) => role === "toolResult")).toEqual([
      result("first"),
      result("second"),
    ]);
  });

  it.each([
    {
      name: "missing later occurrence",
      input: [call(), result("first"), user("next"), call()],
      roles: ["assistant", "toolResult", "user", "assistant", "toolResult"],
      texts: ["first", missing],
      idempotent: true,
    },
    {
      name: "adjacent later result",
      input: [call(), call(), result("second")],
      texts: [missing, "second"],
    },
    {
      name: "ambiguous delayed results",
      input: [call(), call(), result("locally first"), result("ambiguous extra")],
      texts: [missing, "locally first"],
    },
    {
      name: "unresolved failed occurrence",
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
      name: "failed local occurrence",
      input: [
        call(),
        call("exec_0", "error"),
        result("failed turn output", "exec_0", true),
        user("retry"),
      ],
      drop: true,
      roles: ["assistant", "toolResult", "user"],
      texts: [missing],
      forbidden: "failed turn output",
    },
  ])(
    "repairs %s without cross-turn leakage",
    ({ input, drop, roles: expectedRoles, texts, forbidden, idempotent }) => {
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
    },
  );
});

describe("real results replace synthetic errors", () => {
  const synthetic = (id: string) => ({
    ...textToolResult(id, "read", DEFAULT_MISSING_TOOL_RESULT_TEXT, { isError: true }),
    details: { openclawSyntheticMissingToolResult: true },
  });
  it.each([
    [
      "alongside an orphan",
      [
        callAssistant("one"),
        synthetic("one"),
        realResult("orphan"),
        realResult("one", "read", "real"),
      ],
      [0, 3],
    ],
    [
      "after another tool turn",
      [
        callAssistant("one"),
        synthetic("one"),
        callAssistant("two", "write"),
        realResult("one", "read", "real"),
        realResult("two", "write", "second"),
      ],
      [0, 3, 2, 4],
    ],
  ] as const)("keeps the real result %s", (_name, raw, order) => {
    const input = castAgentMessages([...raw]);
    const expected = structuredClone(order.map((index) => input[index]));
    expect(repairToolUseResultPairing(input).messages).toEqual(expected);
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
