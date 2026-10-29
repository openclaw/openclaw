import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
} from "../../run-termination.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  isEmbeddedRunTerminalAbort,
  isEmbeddedRunTerminalInterrupted,
  isEmbeddedRunTerminalTimeout,
  resolveEmbeddedRunAttemptTerminalOutcome,
  resolveEmbeddedRunAttemptTerminalState,
} from "./terminal-outcome.js";

type EmbeddedRunAttemptTerminalInput = Parameters<
  typeof resolveEmbeddedRunAttemptTerminalOutcome
>[0]["attempt"];

function makeAttempt(
  terminal: EmbeddedRunAttemptTerminalInput["terminal"] = { kind: "ok" },
): EmbeddedRunAttemptTerminalInput {
  return { terminal };
}

function makeAssistant(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return makeAgentAssistantMessage({ stopReason, content: [], timestamp: 0 });
}

describe("embedded run attempt terminal outcome", () => {
  it.each([
    { name: "ordinary error", refusal: false, category: undefined, expected: "Provider detail." },
    {
      name: "bounded refusal category",
      refusal: true,
      category: "cyber",
      expected:
        "The provider refused this request (category: cyber). Revise the request and try again.",
    },
    {
      name: "untrusted refusal category",
      refusal: true,
      category: "cyber\nProvider detail.",
      expected: "The provider refused this request. Revise the request and try again.",
    },
    {
      name: "missing refusal category",
      refusal: true,
      category: undefined,
      expected: "The provider refused this request. Revise the request and try again.",
    },
  ])("projects $name without exposing refusal explanations", ({ refusal, category, expected }) => {
    const assistant: AssistantMessage = {
      ...makeAssistant("error"),
      errorMessage: "Provider detail.",
      diagnostics: refusal
        ? [
            {
              type: "provider_refusal",
              timestamp: 0,
              details: { category, explanation: "Provider detail." },
            },
          ]
        : undefined,
    };
    const original = structuredClone(assistant);

    expect(
      resolveEmbeddedRunAttemptTerminalOutcome({ attempt: makeAttempt(), assistant }),
    ).toMatchObject({ reason: "failed", status: "error", error: expected });
    expect(assistant).toEqual(original);
  });

  it.each<
    [string, EmbeddedRunAttemptTerminalInput["terminal"], string, boolean, boolean, AbortSignal?]
  >([
    [
      "run-budget prompt timeout",
      { kind: "timeout", phase: "prompt", source: "run_budget" },
      "hard_timeout",
      false,
      true,
    ],
    [
      "idle prompt timeout",
      { kind: "timeout", phase: "prompt", source: "idle" },
      "hard_timeout",
      false,
      true,
    ],
    ["yield-only cleanup", { kind: "aborted", source: "yield_cleanup" }, "completed", false, false],
    ["external cancellation", { kind: "aborted", source: "external" }, "aborted", true, false],
    ["user signal before completion", { kind: "ok" }, "aborted", true, false, AbortSignal.abort()],
    [
      "writer takeover",
      {
        kind: "aborted",
        source: "external",
        failure: { source: "prompt", error: createAgentRunSupersededAbortError() },
      },
      "superseded",
      true,
      false,
      AbortSignal.abort(createAgentRunSupersededAbortError()),
    ],
  ])(
    "carries %s through canonical interruption predicates",
    (_name, terminal, reason, aborted, timedOut, abortSignal) => {
      const outcome = resolveEmbeddedRunAttemptTerminalOutcome({
        attempt: makeAttempt(terminal),
        assistant: abortSignal ? undefined : makeAssistant("stop"),
        abortSignal,
      });
      expect(outcome.reason).toBe(reason);
      if (aborted) {
        expect(outcome).toMatchObject({ status: "error", stopReason: reason });
      }
      expect(isEmbeddedRunTerminalAbort(outcome)).toBe(aborted);
      expect(isEmbeddedRunTerminalTimeout(outcome)).toBe(timedOut);
      expect(isEmbeddedRunTerminalInterrupted(outcome)).toBe(aborted || timedOut);
    },
  );

  it("captures signal ownership before a later cancellation can reclassify completion", () => {
    const controller = new AbortController();
    const terminal = resolveEmbeddedRunAttemptTerminalState({
      attempt: makeAttempt(),
      assistant: makeAssistant("stop"),
      abortSignal: controller.signal,
    });

    controller.abort();

    expect(terminal).toEqual({
      outcome: { reason: "completed", status: "ok", stopReason: "stop" },
      signalOwnedInterruption: false,
    });
  });

  it("starts successful settled finalization without inheriting the original abort signal", () => {
    const controller = new AbortController();
    controller.abort();
    const originalTerminal = resolveEmbeddedRunAttemptTerminalState({
      attempt: makeAttempt(),
      assistant: undefined,
      abortSignal: controller.signal,
    });

    expect(originalTerminal).toMatchObject({
      outcome: { reason: "aborted", status: "error", stopReason: "aborted" },
      signalOwnedInterruption: true,
    });
    expect(
      resolveEmbeddedRunAttemptTerminalState({
        attempt: makeAttempt(),
        assistant: makeAssistant("stop"),
      }),
    ).toEqual({
      outcome: { reason: "completed", status: "ok", stopReason: "stop" },
      signalOwnedInterruption: false,
    });
  });

  const wrappedRestart = new Error("wrapped restart", { cause: createAgentRunRestartAbortError() });
  wrappedRestart.name = "AbortError";
  const staleAssistant = {
    ...makeAssistant("error"),
    errorMessage: "stale assistant error",
    diagnostics: [
      { type: "provider_refusal" as const, timestamp: 0, details: { category: "cyber" } },
    ],
  };
  it.each<
    [
      string,
      EmbeddedRunAttemptTerminalInput["terminal"],
      AssistantMessage | undefined,
      Partial<ReturnType<typeof resolveEmbeddedRunAttemptTerminalOutcome>>,
      AbortSignal?,
      string[]?,
    ]
  >([
    [
      "prompt timeout before generic assistant abort",
      { kind: "timeout", phase: "prompt", source: "runtime" },
      makeAssistant("aborted"),
      {
        reason: "hard_timeout",
        status: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      undefined,
      ["stopReason"],
    ],
    [
      "restart before generic assistant abort",
      { kind: "aborted", source: "runtime", failure: { source: "prompt", error: wrappedRestart } },
      makeAssistant("aborted"),
      { reason: "cancelled", status: "error", stopReason: "restart" },
    ],
    [
      "runtime abort before successful assistant",
      { kind: "aborted", source: "runtime" },
      makeAssistant("stop"),
      { reason: "aborted", status: "error", stopReason: "aborted" },
    ],
    [
      "attributed prompt timeout before restart",
      { kind: "timeout", phase: "prompt", source: "runtime" },
      undefined,
      {
        reason: "hard_timeout",
        status: "timeout",
        stopReason: "restart",
        timeoutPhase: "provider",
      },
      AbortSignal.abort(createAgentRunRestartAbortError()),
    ],
    [
      "caller timeout before attempt flags settle",
      { kind: "ok" },
      undefined,
      { reason: "timed_out", status: "timeout", stopReason: "timeout" },
      AbortSignal.abort(Object.assign(new Error("request timed out"), { name: "TimeoutError" })),
      ["timeoutPhase", "providerStarted"],
    ],
    [
      "current prompt failure before stale successful assistant",
      { kind: "failed", source: "prompt", error: new Error("database is locked") },
      makeAssistant("stop"),
      { reason: "failed", status: "error", error: "database is locked" },
    ],
    [
      "null current failure before stale assistant refusal",
      { kind: "failed", source: "prompt", error: null },
      staleAssistant,
      { reason: "failed", status: "error" },
      undefined,
      ["error"],
    ],
    [
      "compaction timeout before mechanical abort",
      { kind: "timeout", phase: "compaction", source: "runtime" },
      undefined,
      { reason: "timed_out", status: "timeout" },
    ],
    [
      "tool timeout before mechanical abort",
      { kind: "timeout", phase: "tool_execution", source: "runtime" },
      undefined,
      { reason: "timed_out", status: "timeout" },
    ],
    [
      "recovered compaction observation remains non-terminal",
      { kind: "timeout", phase: "compaction", source: "observation" },
      makeAssistant("stop"),
      { reason: "completed", status: "ok", stopReason: "stop" },
    ],
    [
      "failure detail remains terminal on compaction observation",
      {
        kind: "timeout",
        phase: "compaction",
        source: "observation",
        failure: { source: "compaction", error: new Error("settlement failed") },
      },
      makeAssistant("stop"),
      { reason: "failed", status: "error", error: "settlement failed" },
    ],
  ])(
    "preserves terminal precedence: %s",
    (_name, terminal, assistant, expected, abortSignal, absent = []) => {
      const outcome = resolveEmbeddedRunAttemptTerminalOutcome({
        attempt: makeAttempt(terminal),
        assistant,
        abortSignal,
      });
      expect(outcome).toMatchObject(expected);
      for (const field of absent) {
        expect(outcome).not.toHaveProperty(field);
      }
    },
  );

  it("preserves nested failure details without exposing credentials", () => {
    const credential = "sk-test-" + "x".repeat(32);
    const outcome = resolveEmbeddedRunAttemptTerminalOutcome({
      attempt: makeAttempt({
        kind: "failed",
        source: "prompt",
        error: new Error("request failed", {
          cause: new Error(`database is locked; api_key=${credential}`),
        }),
      }),
      assistant: undefined,
    });

    expect(outcome.error).toContain("request failed");
    expect(outcome.error).toContain("database is locked");
    expect(outcome.error).not.toContain(credential);
  });
});
