import { describe, expect, it } from "vitest";
import type { CliOutput } from "./cli-output-contracts.js";
import { parseCliOutput } from "./cli-output.js";
import {
  createOpenAiCompatibleCliUsageCases,
  joinJsonlFrames,
  claudeTextDelta,
} from "./cli-output.test-helpers.js";

type ParseCliOutputParams = Parameters<typeof parseCliOutput>[0];

const OPENAI_COMPATIBLE_CLI_USAGE_CASES = [
  ...createOpenAiCompatibleCliUsageCases(),
  {
    name: "all-zero token fields are treated as absent usage",
    raw: {
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      total_tokens: 0,
    },
    normalized: undefined,
  },
] as const;

function parseCliJson(raw: string, backend: ParseCliOutputParams["backend"], providerId = "") {
  return parseCliOutput({ raw, backend, providerId, outputMode: "json" });
}

function parseCliJsonl(raw: string, backend: ParseCliOutputParams["backend"], providerId: string) {
  return parseCliOutput({ raw, backend, providerId, outputMode: "jsonl" });
}

function claudeStream(raw: string, explicitDialect = false) {
  return parseCliJsonl(
    raw,
    {
      command: "claude",
      output: "jsonl",
      sessionIdFields: ["session_id"],
      ...(explicitDialect ? { jsonlDialect: "claude-stream-json" as const } : {}),
    },
    "claude-cli",
  );
}

function jsonRecord(input: object, command = "claude", providerId = `${command}-cli`) {
  return parseCliJson(
    JSON.stringify(input),
    { command, output: "json", sessionIdFields: ["session_id"] },
    providerId,
  );
}

const jsonAnswer = (text = "", sessionId?: string) => ({
  text,
  sessionId,
  usage: undefined,
});
const jsonError = (errorText: string, sessionId?: string): CliOutput => ({
  ...jsonAnswer("", sessionId),
  errorText,
});
const stoppedResult = (terminal_reason = "hook_stopped", stop_reason = "tool_use") => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "stopped-session",
  terminal_reason,
  stop_reason,
  result: "",
});
const stoppedAnswer = (terminalReason = "hook_stopped", stopReason = "tool_use") => ({
  ...jsonAnswer("", "stopped-session"),
  errorText: `Claude CLI ended the turn without a reply (terminal_reason: ${terminalReason}, stop_reason: ${stopReason}).`,
  terminalFailure: { reason: "turn_stopped", terminalReason, stopReason },
});

describe("parseCliJson", () => {
  it.each([
    {
      name: "default alias order past blank and nonstring fields",
      fields: undefined,
      record: {
        session_id: false,
        sessionId: " ",
        conversation_id: " first ",
        conversationId: "second",
      },
      expected: "first",
    },
    {
      name: "configured alias order",
      fields: ["missing", "blank", "chosen", "session_id"],
      record: { blank: " ", chosen: " custom ", session_id: "default" },
      expected: "custom",
    },
    {
      name: "explicitly disabled alias selection",
      fields: [],
      record: { session_id: "default" },
      expected: undefined,
    },
  ])("preserves $name", ({ fields, record, expected }) => {
    expect(
      parseCliJson(JSON.stringify({ ...record, result: "answer" }), {
        command: "model-cli",
        sessionIdFields: fields,
      }),
    ).toEqual({ text: "answer", sessionId: expected, usage: undefined });
  });

  it.each([
    {
      name: "preserves Claude max-turn terminal context in JSON mode",
      input: {
        type: "result",
        subtype: "error_max_turns",
        session_id: "session-json-max-turns",
        terminal_reason: "max_turns",
        errors: ["Reached maximum number of turns (3)"],
      },
      expected: {
        ...jsonAnswer("", "session-json-max-turns"),
        errorText: "Reached maximum number of turns (3)",
        terminalFailure: { reason: "max_turns", limit: 3 },
      },
    },
    {
      name: "records a Claude hook-stopped terminal result in JSON mode",
      input: { ...stoppedResult(), num_turns: 4, permission_denials: [] },
      expected: stoppedAnswer(),
    },
    {
      name: "bounds and flattens the CLI-controlled terminal reason it repeats back",
      input: stoppedResult("hook_stopped", "y".repeat(200)),
      expected: stoppedAnswer("hook_stopped", "y".repeat(64)),
    },
    {
      name: "records an aborted-tools terminal result as a turn stop",
      input: stoppedResult("aborted_tools"),
      expected: stoppedAnswer("aborted_tools"),
    },
    {
      name: "keeps a stopped Claude turn that still delivered result text",
      input: { ...stoppedResult(), result: "partial answer" },
      expected: jsonAnswer("partial answer", "stopped-session"),
    },
    {
      name: "surfaces Claude error_during_execution errors[] and skips ede_diagnostic telemetry",
      input: {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "session-json-ede",
        errors: ["[ede_diagnostic] tool_use_ids=[toolu_1]", "API Error: 529 Overloaded"],
      },
      expected: jsonError("API Error: 529 Overloaded", "session-json-ede"),
    },
    {
      name: "classifies Claude is_error JSON results as provider errors",
      input: {
        type: "result",
        subtype: "success",
        is_error: true,
        result: 'API Error: 400 {"error":{"message":"Bad request"}}',
      },
      expected: jsonError("Bad request"),
    },
    {
      name: "classifies generic is_error JSON results as provider errors",
      input: { is_error: true, result: "429 rate limit exceeded" },
      command: "custom",
      expected: jsonError("429 rate limit exceeded"),
    },
    {
      name: "does not classify null JSON result error fields as provider errors",
      input: { type: "result", error: null, message: "done" },
      command: "custom",
      expected: jsonAnswer("done"),
    },
    {
      name: "classifies JSON status error result payloads as provider errors",
      input: { type: "result", status: "error", result: "rate limit" },
      command: "custom",
      expected: jsonError("rate limit"),
    },
  ])("$name", ({ input, command, expected }) => {
    expect(jsonRecord(input, command)).toEqual(expected);
  });

  it("keeps earlier assistant text when a later terminal result is reply-less", () => {
    const result = parseCliJson(
      joinJsonlFrames(
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "partial answer" }] },
        },
        stoppedResult(),
      ),
      { command: "claude", output: "json", sessionIdFields: ["session_id"] },
      "claude-cli",
    );

    expect(result).toEqual(jsonAnswer("partial answer", "stopped-session"));
  });

  it.each([
    "Claude Code starting...",
    'banner "example {"type":"error","message":"fake"}"',
    'banner "use { to begin JSON"',
    String.raw`banner "example {\"type\":\"error\",\"message\":\"fake\"}"`,
  ])("recovers mixed-output session metadata after %s", (banner) => {
    const result = parseCliJson(
      [
        banner,
        '{"type":"init","session_id":"session-789"}',
        '{"type":"result","result":"Claude says hi","usage":{"input_tokens":9,"output_tokens":4}}',
      ].join("\n"),
      {
        command: "claude",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "Claude says hi",
      sessionId: "session-789",
      usage: {
        input: 9,
        output: 4,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("keeps records around quoted examples and ignores later quoted errors", () => {
    const raw = [
      '{"session_id":"session-mixed"}',
      '"use { for JSON"',
      '{"result":"done"}',
      'note "example {"type":"error","message":"fake"}"',
    ].join(" ");

    const parsed = parseCliJson(raw, { command: "custom", output: "json" });
    expect(parsed?.text, "CLI_QUOTED_RECORDS_LOST").toBe("done");
    expect(parsed).toMatchObject({
      sessionId: "session-mixed",
      usage: undefined,
    });
  });

  it("retains visible raw output for ambiguous unmatched prose quotes", () => {
    const raw = 'banner "unterminated prose {"result":"ok"} note "done"';

    expect(parseCliJson(raw, { command: "custom", output: "json" })).toEqual({
      text: raw,
      sessionId: undefined,
    });
  });

  it.each([
    { name: "absent usage", usage: undefined, input: 5 },
    { name: "empty usage", usage: {}, input: 5 },
    { name: "cache-subtracted input fallback", usage: undefined, input: undefined },
  ])("reads Gemini stats with $name", ({ usage, input }) => {
    const result = jsonRecord(
      {
        session_id: "gemini-session",
        response: "Gemini says hello",
        usage,
        stats: { total_tokens: 21, input_tokens: 13, output_tokens: 5, cached: 8, input },
      },
      "gemini",
      "",
    );
    expect(result).toEqual({
      text: "Gemini says hello",
      sessionId: "gemini-session",
      usage: { input: 5, output: 5, cacheRead: 8, total: 21 },
    });
  });

  it.each(["claude", "gemini"])("unwraps nested result JSON only for Claude (%s)", (command) => {
    const nestedResult = JSON.stringify({
      type: "result",
      result: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "actual response text",
      }),
    });
    const result = jsonRecord(
      {
        session_id: "nested-session",
        result: nestedResult,
      },
      command,
      command === "claude" ? "claude-cli" : "gemini",
    );

    expect(result).toEqual(
      jsonAnswer(command === "claude" ? "actual response text" : nestedResult, "nested-session"),
    );
  });

  it.each(OPENAI_COMPATIBLE_CLI_USAGE_CASES)(
    "normalizes $name from CLI JSON output",
    ({ raw, normalized }) => {
      const result = jsonRecord(
        {
          session_id: "openai-compatible-session",
          response: "OpenAI-compatible response",
          usage: raw,
        },
        "openai-compatible",
        "openai-compatible-cli",
      );

      expect(result).toEqual({
        text: "OpenAI-compatible response",
        sessionId: "openai-compatible-session",
        usage: normalized,
      });
    },
  );
});

describe("parseCliJsonl", () => {
  it.each([
    {
      name: "records a reply-less terminal stop for any claude-stream-json backend",
      backend: { command: "acme-agent", jsonlDialect: "claude-stream-json" as const },
      expected: [
        "Claude CLI ended the turn without a reply (terminal_reason: hook_stopped, stop_reason: tool_use).",
        { reason: "turn_stopped", terminalReason: "hook_stopped", stopReason: "tool_use" },
      ],
    },
    {
      name: "leaves terminal_reason alone outside the claude-stream-json dialect",
      backend: { command: "acme-agent" },
      expected: [undefined, undefined],
    },
  ])("$name", ({ backend, expected }) => {
    const result = parseCliJsonl(
      JSON.stringify(stoppedResult()),
      { ...backend, output: "jsonl", sessionIdFields: ["session_id"] },
      "acme-cli",
    );

    expect([result.errorText, result.terminalFailure]).toEqual(expected);
  });
});

describe("parseCliOutput", () => {
  it.each([
    {
      name: "uses streamed Claude assistant text when the result envelope is missing",
      raw: joinJsonlFrames(
        { type: "init", session_id: "session-stream-missing-result" },
        claudeTextDelta("partial answer"),
      ),
      expected: {
        text: "partial answer",
        sessionId: "session-stream-missing-result",
        usage: undefined,
      },
    },
    {
      name: "fails stream-json output without result or assistant text instead of returning raw JSONL",
      raw: JSON.stringify({ type: "init", session_id: "session-empty" }),
      expected: {
        text: "",
        sessionId: "session-empty",
        usage: undefined,
        errorText: "CLI stream-json output ended without a result event.",
      },
    },
  ])("$name", ({ raw, expected }) => {
    expect(claudeStream(raw)).toEqual(expected);
  });

  it("keeps the missing-result failure after compaction-only metadata", () => {
    const result = claudeStream(
      JSON.stringify({ type: "system", subtype: "status", status: "compacting" }),
      true,
    );

    expect(result).toEqual({
      text: "",
      sessionId: undefined,
      usage: undefined,
      errorText: "CLI stream-json output ended without a result event.",
    });
  });
});
