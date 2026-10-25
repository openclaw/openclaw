import { describe, expect, it } from "vitest";
import type { CliOutput } from "./cli-output-contracts.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";
import { extractCliErrorMessage, formatCliOutputError, parseCliOutput } from "./cli-output.js";
import {
  createGeminiBackend,
  createClaudeBackend,
  createPluginParser,
  joinJsonlFrames,
  claudeTextDelta,
} from "./cli-output.test-helpers.js";
import { createClaudeApiErrorFixture } from "./test-helpers/claude-api-error-fixture.js";

type ParseCliOutputParams = Parameters<typeof parseCliOutput>[0];

function parseCliJsonl(raw: string, backend: ParseCliOutputParams["backend"], providerId: string) {
  return parseCliOutput({ raw, backend, providerId, outputMode: "jsonl" });
}

function parseGemini(...frames: unknown[]) {
  return parseCliJsonl(joinJsonlFrames(...frames), createGeminiBackend(), "google-gemini-cli");
}

const geminiMessage = (content: string) => ({
  type: "message",
  role: "assistant",
  content,
  delta: true,
});
const resultFrame = (fields: Record<string, unknown>) => ({ type: "result", ...fields });
const effectsWarning = "Tool actions may already have run; verify their effects before retrying.";
const maxTurnsRetry = "Retry with a higher --max-turns value or a narrower task.";

function parseClaude(...frames: unknown[]) {
  return parseCliJsonl(
    joinJsonlFrames(...frames),
    { command: "claude", output: "jsonl", sessionIdFields: ["session_id"] },
    "claude-cli",
  );
}

function expectOutput(actual: CliOutput | null, expected: Partial<CliOutput>) {
  expect(actual).toEqual({ text: "", sessionId: undefined, usage: undefined, ...expected });
}

function hasDanglingSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

describe("formatCliOutputError", () => {
  it("keeps truncated session identity UTF-16 safe", () => {
    const sessionId = `${"s".repeat(199)}😀tail`;
    expect(hasDanglingSurrogate(sessionId.slice(0, 200))).toBe(true);

    const error = formatCliOutputError({
      text: "",
      sessionId,
      terminalFailure: { reason: "max_turns" },
    });

    expect(hasDanglingSurrogate(error)).toBe(false);
    expect(error).toContain(`Claude session: ${"s".repeat(199)}.`);
  });

  it("names the Claude terminal reason and the hook that stopped the turn", () => {
    const error = formatCliOutputError(
      {
        text: "",
        sessionId: "claude-session-1",
        terminalFailure: {
          reason: "turn_stopped",
          terminalReason: "hook_stopped",
          stopReason: "tool_use",
        },
      },
      { runId: "run-1", sessionId: "session-1" },
    );

    expect(error).toBe(
      "Claude CLI ended the turn without a reply (terminal_reason: hook_stopped, stop_reason: tool_use). " +
        "OpenClaw run: run-1. OpenClaw session: session-1. Claude session: claude-session-1. " +
        "Tool actions may already have run; verify their effects before retrying. " +
        "A Claude Code hook stopped this turn; user-scope hooks (including plugin hooks) " +
        "apply to headless runs — move or disable that hook.",
    );
  });

  it("omits the hook guidance for terminal reasons no hook caused", () => {
    const error = formatCliOutputError({
      text: "",
      terminalFailure: { reason: "turn_stopped", terminalReason: "aborted_tools" },
    });

    expect(error).toBe(
      "Claude CLI ended the turn without a reply (terminal_reason: aborted_tools). " +
        "Tool actions may already have run; verify their effects before retrying.",
    );
  });
});

describe("parseCliJsonl errors", () => {
  it.each([
    {
      name: "detailed result after a generic Gemini error",
      frames: [
        { type: "error", severity: "error" },
        resultFrame({ status: "error", error: { message: "Final Gemini failure" } }),
      ],
      expected: { errorText: "Final Gemini failure" },
    },
    {
      name: "Gemini warning without a provider error",
      frames: [
        { type: "error", severity: "warning", message: "Loop detected, stopping execution" },
        geminiMessage("final output"),
        resultFrame({ status: "success" }),
      ],
      expected: { text: "final output" },
    },
  ])("keeps $name", ({ frames, expected }) => {
    expectOutput(parseGemini(...frames), expected);
  });

  it("keeps an explicit Claude execution error that also reports a terminal reason", () => {
    expectOutput(
      parseCliJsonl(
        joinJsonlFrames(
          claudeTextDelta("partial"),
          resultFrame({
            subtype: "error_during_execution",
            is_error: true,
            session_id: "claude-execution-error",
            stop_reason: "error",
            terminal_reason: "error_during_execution",
            result: "",
            errors: ["API Error: 529 Overloaded"],
          }),
        ),
        createClaudeBackend("claude"),
        "claude-cli",
      ),
      {
        sessionId: "claude-execution-error",
        errorText: "API Error: 529 Overloaded",
      },
    );
  });

  it("extracts and classifies nested Claude API errors", () => {
    const { message, jsonl } = createClaudeApiErrorFixture();
    expect(extractCliErrorMessage(jsonl)).toBe(message);
    expectOutput(parseClaude(jsonl), { sessionId: "session-api-error", errorText: message });
  });

  it.each([
    {
      name: "max-turn limit",
      sessionId: "session-max-turns",
      fields: {
        subtype: "error_max_turns",
        num_turns: 2,
        stop_reason: "tool_use",
        errors: ["Reached maximum number of turns (1)"],
      },
      errorText: "Reached maximum number of turns (1)",
      terminalFailure: { reason: "max_turns", limit: 1 },
      attribution: { runId: "run-max-turns", sessionId: "openclaw-session-max-turns" },
      formatted:
        "Claude CLI stopped after reaching the maximum number of turns (limit: 1). OpenClaw run: run-max-turns. OpenClaw session: openclaw-session-max-turns. Claude session: session-max-turns.",
    },
    {
      name: "terminal-reason-only max-turn stop",
      sessionId: "session-terminal-reason-only",
      fields: {},
      errorText: "Reached maximum number of turns.",
      terminalFailure: { reason: "max_turns" },
      attribution: undefined,
      formatted:
        "Claude CLI stopped after reaching the maximum number of turns. Claude session: session-terminal-reason-only.",
    },
  ] as const)(
    "preserves actionable $name context",
    ({ sessionId, fields, errorText, terminalFailure, attribution, formatted }) => {
      const result = parseClaude(
        resultFrame({ session_id: sessionId, terminal_reason: "max_turns", ...fields }),
      );
      expectOutput(result, { sessionId, errorText, terminalFailure });
      expect(formatCliOutputError(result, attribution)).toBe(
        `${formatted} ${effectsWarning} ${maxTurnsRetry}`,
      );
    },
  );

  it("does not apply Claude terminal semantics to an explicit Gemini dialect", () => {
    const result = parseCliJsonl(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        terminal_reason: "max_turns",
        errors: ["Reached maximum number of turns (1)"],
      }),
      {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "gemini-stream-json",
      },
      "claude-cli",
    );

    expect(result?.terminalFailure).toBeUndefined();
  });
});

describe("createCliJsonlStreamingParser errors", () => {
  it("streams Gemini result errors as provider errors", () => {
    const deltas: Array<{ text: string; delta: string; sessionId?: string }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: createGeminiBackend(),
      providerId: "google-gemini-cli",
      onAssistantDelta: (delta) => deltas.push(delta),
    });

    parser.push(
      joinJsonlFrames(
        geminiMessage("partial output"),
        resultFrame({ status: "error", error: { message: "Gemini stream failed" } }),
      ) + "\n",
    );
    parser.finish();

    expect(deltas).toEqual([
      {
        text: "partial output",
        delta: "partial output",
        sessionId: undefined,
        usage: undefined,
      },
    ]);
    expectOutput(parser.getOutput(), {
      errorText: "Gemini stream failed",
    });
  });

  it("turns plugin-owned JSONL parser exceptions into bounded provider errors", () => {
    let calls = 0;
    const parser = createPluginParser({
      parseJsonlEvent: (line) => {
        calls += 1;
        if (line.includes("result")) {
          return { kind: "result", text: "must not replace the parser error" };
        }
        throw new Error("invalid custom event");
      },
    });

    parser.push('{"type":"broken"}\n{"type":"result"}\n');
    parser.finish();

    expect(calls).toBe(1);
    expectOutput(parser.getOutput(), {
      errorText: "CLI backend acme-cli JSONL parser failed: invalid custom event",
    });
  });

  it.each(["", "preserved answer"])(
    "keeps plugin-owned terminal errors and text %j ahead of later result summaries",
    (text) => {
      const usageEvents: Array<{ usage: unknown; isTerminal: boolean }> = [];
      const parser = createPluginParser({
        parseJsonlEvent: (line) =>
          line === "failed"
            ? { kind: "result", text, errorText: "provider failed" }
            : {
                kind: "result",
                text: "must not replace the provider error",
                sessionId: "late-successor",
                usage: { input: 2, output: 1, total: 3 },
              },
        onUsage: (usage, isTerminal) => usageEvents.push({ usage, isTerminal }),
      });

      parser.push("failed\nsummary\n");
      parser.finish();

      expectOutput(parser.getOutput(), {
        text,
        sessionId: "late-successor",
        usage: { input: 2, output: 1, total: 3 },
        errorText: "provider failed",
      });
      expect(usageEvents).toEqual([{ usage: { input: 2, output: 1, total: 3 }, isTerminal: true }]);
    },
  );

  it("preserves plugin-owned session ids emitted after terminal errors", () => {
    const sessionIds: string[] = [];
    const parser = createPluginParser({
      parseJsonlEvent: () => [
        { kind: "result", errorText: "provider failed" },
        { kind: "sessionId", sessionId: "late-successor" },
      ],
      onSessionId: (sessionId) => sessionIds.push(sessionId),
    });

    parser.push("terminal\n");
    parser.finish();

    expect(sessionIds).toEqual(["late-successor"]);
    expectOutput(parser.getOutput(), {
      sessionId: "late-successor",
      errorText: "provider failed",
    });
  });

  it.each([
    {
      name: "streamed text before an empty result",
      first: { kind: "text" as const, text: "streamed answer" },
      last: { kind: "result" as const, text: "  " },
      expected: { text: "streamed answer" },
    },
    {
      name: "result text before a metadata-only summary",
      first: { kind: "result" as const, text: "completed answer" },
      last: {
        kind: "result" as const,
        sessionId: "summary-session",
        usage: { input: 5, output: 3, total: 8 },
      },
      expected: {
        text: "completed answer",
        sessionId: "summary-session",
        usage: { input: 5, output: 3, total: 8 },
      },
    },
  ])("preserves plugin $name", ({ first, last, expected }) => {
    const parser = createPluginParser({
      parseJsonlEvent: (line) => (line === "first" ? first : last),
    });
    parser.push("first\nlast\n");
    parser.finish();
    expectOutput(parser.getOutput(), expected);
  });

  it.each([
    ["without a result", undefined, "delegated answer"],
    ["with an empty result", "  ", "delegated answer"],
    ["with an authoritative result", "final answer", "final answer"],
  ] as const)("retains mixed plugin text precedence %s", (_label, resultText, expectedText) => {
    const parser = createPluginParser({
      parseJsonlEvent: (line) => {
        if (line === "session") {
          return { kind: "sessionId", sessionId: "custom-session" };
        }
        if (line === "prefix") {
          return { kind: "text", text: "streamed prefix" };
        }
        if (line === "result") {
          return { kind: "result", text: resultText };
        }
        return null;
      },
    });

    parser.push(
      [
        "session",
        "prefix",
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "delegated answer" },
        }),
        ...(resultText === undefined ? [] : ["result"]),
        "",
      ].join("\n"),
    );
    parser.finish();

    expectOutput(parser.getOutput(), {
      text: expectedText,
      sessionId: "custom-session",
    });
  });
});
