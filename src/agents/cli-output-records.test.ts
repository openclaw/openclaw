import { describe, expect, it, vi } from "vitest";
import { parseCliOutput } from "./cli-output.js";
import { createOpenAiCompatibleCliUsageCases } from "./cli-output.test-helpers.js";

type ParseCliOutputParams = Parameters<typeof parseCliOutput>[0];

const usageCases = createOpenAiCompatibleCliUsageCases();
const OPENAI_COMPATIBLE_CLI_USAGE_CASES = [
  usageCases[0],
  usageCases[5],
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

function normalizedUsage(values: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}) {
  return {
    input: values.input,
    output: values.output,
    cacheRead: values.cacheRead,
    cacheWrite: values.cacheWrite,
    total: values.total,
  };
}

describe("parseCliJson", () => {
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
      command: "claude",
      sessionIdFields: ["session_id"],
      providerId: "claude-cli",
      expected: {
        text: "",
        sessionId: "session-json-max-turns",
        usage: undefined,
        errorText: "Reached maximum number of turns (3)",
        terminalFailure: { reason: "max_turns", limit: 3 },
      },
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
      command: "claude",
      sessionIdFields: ["session_id"],
      providerId: "claude-cli",
      expected: {
        text: "",
        sessionId: "session-json-ede",
        usage: undefined,
        errorText: "API Error: 529 Overloaded",
      },
    },
    {
      name: "classifies Claude is_error JSON results as provider errors",
      input: {
        type: "result",
        subtype: "success",
        is_error: true,
        result: 'API Error: 400 {"error":{"message":"Bad request"}}',
      },
      command: "claude",
      sessionIdFields: ["session_id"],
      providerId: "claude-cli",
      expected: {
        text: "",
        sessionId: undefined,
        usage: undefined,
        errorText: "Bad request",
      },
    },
  ])("$name", ({ input, command, sessionIdFields, providerId, expected }) => {
    const result = parseCliJson(
      JSON.stringify(input),
      { command, output: "json", ...(sessionIdFields ? { sessionIdFields } : {}) },
      providerId,
    );

    expect(result).toEqual(expected);
  });

  it("keeps earlier assistant text when a later terminal result is reply-less", () => {
    const result = parseCliJson(
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "partial answer" }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "session-json-earlier-text",
          stop_reason: "tool_use",
          terminal_reason: "hook_stopped",
          result: "",
        }),
      ].join("\n"),
      { command: "claude", output: "json", sessionIdFields: ["session_id"] },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "partial answer",
      sessionId: "session-json-earlier-text",
      usage: undefined,
    });
  });

  it.each(["Claude Code starting..."])(
    "recovers mixed-output session metadata after %s",
    (banner) => {
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
    },
  );

  it("retains visible raw output for ambiguous unmatched prose quotes", () => {
    const raw = 'banner "unterminated prose {"result":"ok"} note "done"';

    expect(parseCliJson(raw, { command: "custom", output: "json" })).toEqual({
      text: raw,
      sessionId: undefined,
    });
  });

  it.each([
    {
      name: "falls back to Gemini stats when usage exists without token fields",
      input: {
        session_id: "gemini-session-789",
        response: "Gemini says hello",
        usage: {},
        stats: {
          total_tokens: 21,
          input_tokens: 13,
          output_tokens: 5,
          cached: 8,
          input: 5,
        },
      },
      expected: {
        text: "Gemini says hello",
        sessionId: "gemini-session-789",
        usage: normalizedUsage({ input: 5, output: 5, cacheRead: 8, total: 21 }),
      },
    },
  ])("$name", ({ input, expected }) => {
    const result = parseCliJson(JSON.stringify(input), {
      command: "gemini",
      output: "json",
      sessionIdFields: ["session_id"],
    });

    expect(result).toEqual(expected);
  });

  it.each(OPENAI_COMPATIBLE_CLI_USAGE_CASES)(
    "normalizes $name from CLI JSON output",
    ({ raw, normalized }) => {
      const result = parseCliJson(
        JSON.stringify({
          session_id: "openai-compatible-session",
          response: "OpenAI-compatible response",
          usage: raw,
        }),
        {
          command: "openai-compatible",
          output: "json",
          sessionIdFields: ["session_id"],
        },
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
    // The dialect, not the provider id, owns Claude Code's terminal semantics:
    // a plugin backend that declares `claude-stream-json` gets the same stop
    // classification as the bundled `claude-cli`, and one that does not stays
    // on the generic result path.
    const result = parseCliJsonl(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "acme-hook-stopped",
        stop_reason: "tool_use",
        terminal_reason: "hook_stopped",
        result: "",
      }),
      { ...backend, output: "jsonl", sessionIdFields: ["session_id"] },
      "acme-cli",
    );

    expect([result.errorText, result.terminalFailure]).toEqual(expected);
  });
});

describe("parseCliOutput", () => {
  it("applies a backend JSONL hook when reparsing complete output", () => {
    const parseJsonlEvent = vi.fn(() => ({
      kind: "result" as const,
      errorText: "invalid request format: malformed backend result",
    }));

    expect(
      parseCliOutput({
        raw: JSON.stringify({ type: "result", result: "malformed" }),
        backend: { command: "acme", output: "jsonl" },
        providerId: "acme-cli",
        parseJsonlEvent,
        outputMode: "jsonl",
      }),
    ).toEqual({
      text: "",
      sessionId: undefined,
      usage: undefined,
      errorText: "invalid request format: malformed backend result",
    });
    expect(parseJsonlEvent).toHaveBeenCalledOnce();
  });

  it("keeps the missing-result failure after compaction-only metadata", () => {
    const result = parseCliOutput({
      raw: JSON.stringify({ type: "system", subtype: "status", status: "compacting" }),
      backend: {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      parseJsonlLifecycleEvent: () => ({ kind: "compaction", phase: "start" }),
      outputMode: "jsonl",
    });

    expect(result).toEqual({
      text: "",
      sessionId: undefined,
      usage: undefined,
      errorText: "CLI stream-json output ended without a result event.",
    });
  });
});
