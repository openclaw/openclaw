import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { YIELD_DIAGNOSTIC_TEXT } from "./incomplete-turn-resolution.js";
import type { EmbeddedRunTerminalState } from "./terminal-outcome.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

function prepareYield(
  input: {
    yieldDetected?: boolean;
    continuation?: boolean;
    codeModeEngaged?: boolean;
    trigger?: Parameters<typeof prepareEmbeddedRunTerminal>[0]["runParams"]["trigger"];
    terminalState?: EmbeddedRunTerminalState;
    lastToolError?: NonNullable<Parameters<typeof makeEmbeddedRunnerAttempt>[0]>["lastToolError"];
  } = {},
) {
  const assistant = buildEmbeddedRunnerAssistant({
    stopReason: "aborted",
    content: [{ type: "toolCall", id: "yield-call", name: "sessions_yield", arguments: {} }],
  });
  const attempt = makeEmbeddedRunnerAttempt({
    terminal:
      input.yieldDetected === false ? { kind: "ok" } : { kind: "aborted", source: "yield_cleanup" },
    assistantTexts: [],
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
  const prepared = prepareEmbeddedRunTerminal({
    runParams: {
      ...terminal.runParams,
      admittedRunContext: createTestAdmittedRunContext("run:terminal-resolution"),
    },
    attempt,
    provider: "openai",
    model: "mock-1",
    activeErrorContext: { provider: "openai", model: "mock-1" },
    authProfileStore: { version: 1, profiles: {} },
    sessionIdUsed: attempt.sessionIdUsed,
    outerContextTokenMeta: {},
    usageAccumulator: createUsageAccumulator(),
    contextRecoveryState: createEmbeddedRunContextRecoveryState(),
    resolvedToolResultFormat: "markdown",
    terminalState: terminal.terminalState,
  });
  return { attempt, terminal, prepared };
}

describe("yielded terminal payloads after an earlier tool failure", () => {
  it.each([true, false])(
    "preserves paused-turn continuation semantics (continuation: %s)",
    async (continuation) => {
      const { attempt, terminal, prepared } = prepareYield({ continuation });
      expect(terminal.terminalState.outcome.status).toBe("ok");
      expect(prepared.payloadsWithToolMedia ?? []).toEqual([]);
      expect(attempt.lastToolError).toEqual({
        toolName: "exec",
        error: "Command exited with code 1",
      });
      expect(prepared.attemptToolSummary).toMatchObject({ unresolvedError: { toolName: "exec" } });

      const result = await resolveEmbeddedRunTerminal({ ...terminal, ...prepared });
      expect(result.action).toBe("complete");
      if (result.action !== "complete") {
        throw new Error("Expected a paused terminal result, not a retry");
      }
      expect(result.result.meta).toMatchObject({
        yielded: true,
        aborted: false,
        livenessState: "paused",
      });
      expect(result.result.meta.error).toBeUndefined();
      expect(result.result.payloads ?? []).toEqual(
        continuation ? [] : [{ text: YIELD_DIAGNOSTIC_TEXT }],
      );
      expect(terminal.activateInternalPrompt).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "an ordinary completed turn",
      yieldDetected: false,
      outcome: { reason: "completed", status: "ok", stopReason: "stop" },
    },
    {
      name: "a failed yielded turn",
      yieldDetected: true,
      outcome: { reason: "failed", status: "error", error: "Provider failed" },
    },
    {
      name: "a timed-out yielded turn",
      yieldDetected: true,
      outcome: {
        reason: "hard_timeout",
        status: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
    },
  ] satisfies {
    name: string;
    yieldDetected: boolean;
    outcome: EmbeddedRunTerminalState["outcome"];
  }[])("retains tool-error presentation for $name", ({ yieldDetected, outcome }) => {
    const { prepared } = prepareYield({
      yieldDetected,
      terminalState: { outcome, signalOwnedInterruption: false },
    });
    const warning = prepared.payloadsWithToolMedia?.find((payload) => payload.isError);
    expect(warning).toMatchObject({ text: expect.stringContaining("failed"), isError: true });
    expect(getReplyPayloadMetadata(warning ?? {})).toMatchObject({
      toolErrorWarning: { toolName: "exec" },
    });
  });

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
