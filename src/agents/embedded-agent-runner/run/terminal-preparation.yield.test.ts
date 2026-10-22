import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { YIELD_DIAGNOSTIC_TEXT } from "./incomplete-turn-resolution.js";
import type { EmbeddedRunTerminalState } from "./terminal-outcome.js";
import { attemptResult, prepareAttempt } from "./terminal-preparation.test-support.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { expectComplete, makeTerminalInput } from "./terminal-resolution.test-support.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

type ToolError = NonNullable<Parameters<typeof makeEmbeddedRunnerAttempt>[0]["lastToolError"]>;
async function prepareYield(
  input: {
    yieldDetected?: boolean;
    assistantTexts?: string[];
    codeModeEngaged?: boolean;
    lastToolError?: ToolError;
    assistantErrorMessage?: string;
    continuation?: boolean;
    trigger?: "cron";
    terminalState?: EmbeddedRunTerminalState;
  } = {},
) {
  const assistant = buildEmbeddedRunnerAssistant({
    stopReason: "aborted",
    errorMessage: input.assistantErrorMessage,
    content: [{ type: "toolCall", id: "yield-call", name: "sessions_yield", arguments: {} }],
  });
  const attempt = makeEmbeddedRunnerAttempt({
    terminal:
      input.yieldDetected === false ? { kind: "ok" } : { kind: "aborted", source: "yield_cleanup" },
    assistantTexts: input.assistantTexts ?? [],
    lastAssistant: assistant,
    currentAttemptAssistant: undefined,
    // The subscriber retains message_end after yield strips the synthetic abort from history.
    currentAttemptCompletedAssistant: assistant,
    yieldDetected: input.yieldDetected ?? true,
    runtimeContinuationStarted: input.continuation ?? true,
    codeModeEngaged: input.codeModeEngaged,
    lastToolError: input.lastToolError ?? { toolName: "exec", error: "Command exited with code 1" },
    toolMetas: [{ toolName: "exec", isError: true }],
  });
  const terminal = makeTerminalInput({
    attempt,
    runParams: { trigger: input.trigger, authProfileStateMode: "read-only" },
    ...(input.terminalState ? { terminalState: input.terminalState } : {}),
  });
  const prepared = await prepareAttempt({
    runParams: terminal.runParams,
    attempt,
    model: "mock-1",
    activeErrorContext: { provider: "openai", model: "mock-1" },
    terminalState: terminal.terminalState,
  });
  return { attempt, terminal, prepared };
}

const sendError = { toolName: "sessions_send", error: "Gateway delivery is unconfirmed" };
const execError = { toolName: "exec", error: "Command exited with code 1" };
it.each([
  [[], sendError, true, "Agent run aborted"],
  [["Checking the task.", "Waiting for the child."], sendError, true, "Agent run aborted"],
  [[], execError, true, undefined],
  [[], execError, false, undefined],
] satisfies [string[], ToolError, boolean, string | undefined][])(
  "preserves paused payloads %j after %j (continuation=%s)",
  async (assistantTexts, lastToolError, continuation, assistantErrorMessage) => {
    const { attempt, terminal, prepared } = await prepareYield({
      assistantTexts,
      lastToolError,
      continuation,
      assistantErrorMessage,
    });
    expect(attempt.lastToolError).toBe(lastToolError);
    expect(terminal.terminalState.outcome.status).toBe("ok");
    expect(prepared.payloadsWithToolMedia?.map((payload) => payload.text) ?? []).toEqual(
      assistantTexts,
    );
    expect(prepared.payloadsWithToolMedia?.some((payload) => payload.isError)).not.toBe(true);
    const summary = { unresolvedError: { toolName: lastToolError.toolName } };
    expect(prepared.attemptToolSummary).toMatchObject(summary);
    const result = await resolveEmbeddedRunTerminal({ ...terminal, prepared });
    expectComplete(result);
    expect(result.result.meta).toMatchObject({
      yielded: true,
      aborted: false,
      livenessState: "paused",
      toolSummary: summary,
    });
    expect(result.result.meta.error).toBeUndefined();
    expect(result.result.payloads ?? []).toEqual(
      continuation
        ? assistantTexts.map((text) => ({ text, replyToTag: false }))
        : [{ text: YIELD_DIAGNOSTIC_TEXT }],
    );
    expect(terminal.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
  },
);

it.each([
  [false, { reason: "completed", status: "ok", stopReason: "stop" }],
  [true, { reason: "failed", status: "error", error: "Provider failed" }],
  [
    true,
    {
      reason: "hard_timeout",
      status: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
    },
  ],
] satisfies [boolean, EmbeddedRunTerminalState["outcome"]][])(
  "retains tool errors (yield=%s, outcome=%j)",
  async (yieldDetected, outcome) => {
    const { prepared } = await prepareYield({
      yieldDetected,
      terminalState: { outcome, signalOwnedInterruption: false },
    });
    const warning = prepared.payloadsWithToolMedia?.find((payload) => payload.isError);
    expect(warning).toMatchObject({ text: expect.stringContaining("failed"), isError: true });
    expect(getReplyPayloadMetadata(warning ?? {})).toMatchObject({
      toolErrorWarning: { toolName: "exec" },
    });
  },
);

it("preserves restart presentation when a yielded turn is cancelled", async () => {
  const { prepared } = await prepareYield({
    terminalState: {
      outcome: { reason: "cancelled", status: "error", stopReason: "restart" },
      signalOwnedInterruption: true,
    },
  });
  expect(prepared.payloadsWithToolMedia).toEqual([
    expect.objectContaining({ text: "Gateway restarting…" }),
  ]);
  expect(prepared.payloadsWithToolMedia?.[0]?.isError).not.toBe(true);
});

it.each([
  [
    true,
    "UNKNOWN_TOOL_ID",
    "Unknown tool id: MCP.notes.read. Use openclaw.tools.search to find a tool, openclaw.tools.describe to inspect it, then openclaw.tools.call with the exact id or name.",
  ],
  [undefined, "SYSTEM_RUN_DENIED", "SYSTEM_RUN_DENIED: approval required"],
] as const)("retains cron %s/%s diagnostics without warning", async (codeMode, code, error) => {
  const lastToolError = {
    toolName: "exec",
    error,
    ...(!codeMode ? { errorCode: code } : {}),
  };
  const { attempt, prepared } = await prepareYield({
    lastToolError,
    codeModeEngaged: codeMode,
    trigger: "cron",
  });
  expect(prepared.payloadsWithToolMedia ?? []).toEqual([]);
  expect(attempt.lastToolError).toBe(lastToolError);
  expect(prepared[codeMode ? "terminalToolFailure" : "failureSignal"]).toEqual({
    source: "tool",
    toolName: "exec",
    code,
    ...(!codeMode ? { kind: "execution_denied", message: error, fatalForCron: true } : {}),
  });
});

describe("terminal preparation failure signals", () => {
  it("classifies cron exec denials from tool error metadata", async () => {
    // Cron execution denials are fatal because retrying the same scheduled turn
    // cannot collect interactive approval.
    const prepared = await prepareAttempt({
      runParams: { trigger: "cron" },
      attempt: attemptResult({
        lastToolError: {
          toolName: "exec",
          errorCode: "SYSTEM_RUN_DENIED",
          error: "SYSTEM_RUN_DENIED: approval required",
        },
      }),
    });
    expect(prepared.failureSignal).toEqual({
      kind: "execution_denied",
      source: "tool",
      toolName: "exec",
      code: "SYSTEM_RUN_DENIED",
      message: "SYSTEM_RUN_DENIED: approval required",
      fatalForCron: true,
    });
  });

  it("classifies invalid request denials from tool error metadata", async () => {
    const prepared = await prepareAttempt({
      runParams: { trigger: "cron" },
      attempt: attemptResult({
        lastToolError: {
          toolName: "bash",
          errorCode: "INVALID_REQUEST",
          error: "INVALID_REQUEST: approval denied",
        },
      }),
    });
    expect(prepared.failureSignal?.code).toBe("INVALID_REQUEST");
  });

  it("does not mark non-cron runs", async () => {
    const prepared = await prepareAttempt({
      runParams: { trigger: "user" },
      attempt: attemptResult({
        lastToolError: {
          toolName: "exec",
          errorCode: "SYSTEM_RUN_DENIED",
          error: "SYSTEM_RUN_DENIED: approval required",
        },
      }),
    });
    expect(prepared.failureSignal).toBeUndefined();
  });

  it("does not mark non-exec validation errors as execution denials", async () => {
    const prepared = await prepareAttempt({
      runParams: { trigger: "cron" },
      attempt: attemptResult({
        lastToolError: {
          toolName: "browser",
          errorCode: "INVALID_REQUEST",
          error: "INVALID_REQUEST: url required",
        },
      }),
    });
    expect(prepared.failureSignal).toBeUndefined();
  });

  it("does not mark tool output that merely mentions host denial tokens", async () => {
    // Match structured error metadata, not arbitrary command output that happens
    // to mention a denial code.
    const prepared = await prepareAttempt({
      runParams: { trigger: "cron" },
      attempt: attemptResult({
        lastToolError: {
          toolName: "exec",
          error: "The fetched page says SYSTEM_RUN_DENIED in its troubleshooting section.",
        },
      }),
    });
    expect(prepared.failureSignal).toBeUndefined();
  });

  it("does not infer approval-binding denials when the structured code is omitted", async () => {
    const prepared = await prepareAttempt({
      runParams: { trigger: "cron" },
      attempt: attemptResult({
        lastToolError: {
          toolName: "exec",
          error: "Approval cannot safely bind this interpreter/runtime command",
        },
      }),
    });
    expect(prepared.failureSignal).toBeUndefined();
  });

  it("uses a structured code even when the message is omitted", async () => {
    const prepared = await prepareAttempt({
      runParams: { trigger: "cron" },
      attempt: attemptResult({
        lastToolError: {
          toolName: "exec",
          errorCode: "SYSTEM_RUN_DENIED",
        },
      }),
    });
    expect(prepared.failureSignal).toEqual({
      kind: "execution_denied",
      source: "tool",
      toolName: "exec",
      code: "SYSTEM_RUN_DENIED",
      message: "SYSTEM_RUN_DENIED",
      fatalForCron: true,
    });
  });
});
