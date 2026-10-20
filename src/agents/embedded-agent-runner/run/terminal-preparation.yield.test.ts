import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { YIELD_DIAGNOSTIC_TEXT } from "./incomplete-turn-resolution.js";
import type { EmbeddedRunTerminalState } from "./terminal-outcome.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import { preparationInput } from "./terminal-preparation.test-support.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { expectComplete, makeTerminalInput } from "./terminal-resolution.test-support.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

type AttemptOverrides = NonNullable<Parameters<typeof makeEmbeddedRunnerAttempt>[0]>;
function prepareYield(
  input: Pick<
    AttemptOverrides,
    | "yieldDetected"
    | "assistantTexts"
    | "codeModeEngaged"
    | "lastToolError"
    | "sourceReplyDelivered"
  > & {
    assistantErrorMessage?: string;
    continuation?: boolean;
    trigger?: Parameters<typeof prepareEmbeddedRunTerminal>[0]["runParams"]["trigger"];
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
    sourceReplyDelivered: input.sourceReplyDelivered,
  });
  const terminal = makeTerminalInput({
    attempt,
    runParams: { trigger: input.trigger, authProfileStateMode: "read-only" },
    ...(input.terminalState ? { terminalState: input.terminalState } : {}),
  });
  const prepared = prepareEmbeddedRunTerminal(
    preparationInput({
      runParams: terminal.runParams,
      attempt,
      model: "mock-1",
      activeErrorContext: { provider: "openai", model: "mock-1" },
      terminalState: terminal.terminalState,
    }),
  );
  return { attempt, terminal, prepared };
}

describe("yielded terminal payloads", () => {
  it("records producer source delivery without an extracted messaging target", () => {
    const { prepared } = prepareYield({ sourceReplyDelivered: true });
    expect(prepared.agentMeta.terminalReceipt?.sourceReplyDelivered).toBe(true);
  });
  const sendError = { toolName: "sessions_send", error: "Gateway delivery is unconfirmed" };
  const execError = { toolName: "exec", error: "Command exited with code 1" };
  it.each([
    [[], sendError, true, "Agent run aborted"],
    [["Checking the task.", "Waiting for the child."], sendError, true, "Agent run aborted"],
    [[], execError, true, undefined],
    [[], execError, false, undefined],
  ] satisfies [
    string[],
    NonNullable<AttemptOverrides["lastToolError"]>,
    boolean,
    string | undefined,
  ][])(
    "preserves paused payloads %j after %j (continuation=%s)",
    async (assistantTexts, lastToolError, continuation, assistantErrorMessage) => {
      const { attempt, terminal, prepared } = prepareYield({
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
    (yieldDetected, outcome) => {
      const { prepared } = prepareYield({
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

  it("preserves restart presentation when a yielded turn is cancelled", () => {
    const { prepared } = prepareYield({
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

  it("retains safe Code Mode cron failure metadata during a clean yield", () => {
    const { prepared } = prepareYield({
      codeModeEngaged: true,
      trigger: "cron",
      lastToolError: {
        toolName: "exec",
        error:
          "Unknown tool id: MCP.notes.read. Use openclaw.tools.search to find a tool, openclaw.tools.describe to inspect it, then openclaw.tools.call with the exact id or name.",
      },
    });
    expect(prepared.payloadsWithToolMedia ?? []).toEqual([]);
    expect(prepared.terminalToolFailure).toEqual({
      source: "tool",
      toolName: "exec",
      code: "UNKNOWN_TOOL_ID",
    });
  });

  it("retains fatal cron denial diagnostics without warning on a clean yield", () => {
    const denial = {
      toolName: "exec",
      errorCode: "SYSTEM_RUN_DENIED",
      error: "SYSTEM_RUN_DENIED: approval required",
    };
    const { attempt, prepared } = prepareYield({ lastToolError: denial, trigger: "cron" });
    expect(prepared.payloadsWithToolMedia ?? []).toEqual([]);
    expect(attempt.lastToolError).toBe(denial);
    expect(prepared.failureSignal).toEqual({
      kind: "execution_denied",
      source: "tool",
      toolName: "exec",
      code: "SYSTEM_RUN_DENIED",
      message: denial.error,
      fatalForCron: true,
    });
  });
});
