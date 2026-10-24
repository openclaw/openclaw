/** Tests normalized agent run terminal outcomes and sticky timeout/cancel behavior. */
import { describe, expect, it } from "vitest";
import { extractAgentRunTerminalError } from "./agent-run-result.js";
import {
  buildAgentRunTerminalOutcome as buildOutcome,
  buildAgentRunTerminalOutcomeFromWaitResult as fromWait,
  isStickyAgentRunTerminalOutcome as isSticky,
  mergeAgentRunAttemptTerminal as mergeAttempt,
  mergeAgentRunTerminalOutcome as mergeOutcome,
  normalizeAgentRunAttemptTerminal as normalizeAttempt,
  projectAgentRunAttemptTerminal as projectAttempt,
  setAgentRunAttemptTerminalFailure as setAttemptFailure,
  type AgentRunAttemptTerminal as AttemptTerminal,
} from "./agent-run-terminal-outcome.js";

const expectNormalized = (input: Parameters<typeof normalizeAttempt>[0]) =>
  expect(normalizeAttempt(input));
const expectOutcome = (input: Parameters<typeof buildOutcome>[0]) => expect(buildOutcome(input));
const hardTimeout = (endedAt = 200) =>
  buildOutcome({ status: "timeout", timeoutPhase: "provider", endedAt });
const cancellation = (stopReason: string, endedAt: number) =>
  buildOutcome({ status: "error", stopReason, endedAt });
const timeoutOutcome = { reason: "hard_timeout", status: "timeout" } as const;
const warning = { pendingStage: "checkpoint", elapsedMs: 120_000, timeoutMs: 120_000 };
const observedCompaction = { kind: "timeout", phase: "compaction", source: "observation" } as const;
const runtimeTimeout = { kind: "timeout", phase: "prompt", source: "runtime" } as const;
const externalAbort = { kind: "aborted", source: "external" } as const;
const runtimeAbort = { kind: "aborted", source: "runtime" } as const;
const failedAttempt = (error: unknown, source: "prompt" | "compaction" = "prompt") =>
  ({ kind: "failed", source, error }) as const;
const timedOutAttempt = (error: unknown, source: "external" | "runtime") =>
  ({
    kind: "timeout",
    phase: "compaction",
    source,
    aborted: true,
    failure: { source: "prompt", error },
  }) as const;

describe("agent run terminal outcome", () => {
  it.each([
    { metadata: { livenessState: "abandoned" }, reason: "aborted", sticky: false },
    { metadata: { livenessState: "blocked" }, reason: "blocked", sticky: false },
  ])("preserves auth revocation wait precedence with $metadata", ({ metadata, reason, sticky }) => {
    const outcome = fromWait({
      status: "error",
      stopReason: "auth-revoked",
      ...metadata,
    });

    expect(outcome).toMatchObject({ reason, stopReason: "auth-revoked" });
    expect(isSticky(outcome)).toBe(sticky);
  });

  it("keeps restart cancellation sticky over late completion", () => {
    const restartCancel = buildOutcome({
      status: "timeout",
      stopReason: "restart",
      timeoutPhase: "gateway_draining",
      providerStarted: true,
      endedAt: 100,
    });
    const lateCompletion = buildOutcome({ status: "ok", endedAt: 200 });

    expect(restartCancel).toMatchObject({
      reason: "cancelled",
      status: "error",
      stopReason: "restart",
    });
    expect(isSticky(restartCancel)).toBe(true);
    expect(mergeOutcome(restartCancel, lateCompletion)).toBe(restartCancel);
  });

  it.each([
    [
      "timeout outranks restart",
      { status: "timeout", stopReason: "restart", timeoutPhase: "provider" },
      { ...timeoutOutcome, stopReason: "restart", timeoutPhase: "provider" },
    ],
    [
      "provider errors are not implicitly timeouts",
      { status: "error", error: "auth failed", stopReason: "error" },
      { reason: "failed", status: "error", error: "auth failed", providerStarted: true },
    ],
    [
      "timeout survives a successful end event",
      { status: "ok", timeoutPhase: "provider" },
      timeoutOutcome,
    ],
    [
      "timeout outranks blocked liveness",
      { status: "error", error: "timed out", livenessState: "blocked", timeoutPhase: "provider" },
      { ...timeoutOutcome, error: "timed out", livenessState: "blocked" },
    ],
  ] as const)("%s", (_name, input, expected) => {
    expectOutcome({ ...input, providerStarted: true }).toMatchObject(expected);
  });

  it("prefers hard timeout evidence over default rpc cancellation metadata", () => {
    const timeout = buildOutcome({
      status: "timeout",
      stopReason: "rpc",
      timeoutPhase: "provider",
      providerStarted: true,
      endedAt: 200,
    });
    const earlierCompletion = buildOutcome({ status: "ok", endedAt: 190 });

    expect(timeout).toMatchObject({ reason: "hard_timeout", status: "timeout" });
    expect(isSticky(timeout)).toBe(true);
    expect(mergeOutcome(timeout, earlierCompletion)).toBe(earlierCompletion);
  });

  it("classifies abandoned successful waits as incomplete failures", () => {
    expectOutcome({
      status: "ok",
      livenessState: "abandoned",
    }).toEqual({
      reason: "abandoned",
      status: "error",
      error: "Agent run ended before producing a complete result.",
      livenessState: "abandoned",
    });
  });

  it("keeps a hard timeout over later aborts or failures for the same run", () => {
    const timeout = hardTimeout();
    for (const late of [
      cancellation("aborted", 250),
      buildOutcome({ status: "error", error: "late rejection", endedAt: 260 }),
    ]) {
      expect(mergeOutcome(timeout, late)).toBe(timeout);
    }
  });

  it("keeps the first proven sticky outcome regardless of callback ordering", () => {
    const timeout = hardTimeout();
    const earlierCancellation = cancellation("rpc", 190);
    const laterCancellation = cancellation("restart", 210);

    for (const [other, expected] of [
      [earlierCancellation, earlierCancellation],
      [laterCancellation, timeout],
    ] as const) {
      expect(mergeOutcome(timeout, other)).toBe(expected);
      expect(mergeOutcome(other, timeout)).toBe(expected);
    }
  });

  it("keeps supersession over generic cancellation regardless of callback ordering", () => {
    const superseded = cancellation("superseded", 200);
    const cancelled = cancellation("rpc", 201);

    expect(isSticky(superseded)).toBe(true);
    expect(mergeOutcome(superseded, cancelled)).toBe(superseded);
    expect(mergeOutcome(cancelled, superseded)).toBe(superseded);
  });

  it("keeps timeout ahead of simultaneous supersession", () => {
    const timeout = hardTimeout();
    const superseded = cancellation("superseded", 200);
    for (const [current, incoming] of [
      [timeout, superseded],
      [superseded, timeout],
    ] as const) {
      expect(mergeOutcome(current, incoming).reason).toBe("hard_timeout");
    }
  });
});

describe("agent run attempt terminal", () => {
  it("preserves a degraded completion through normalization, merging, and projection", () => {
    const settlementWarning = { ...warning, pendingStage: "onPartialReply" };
    const degraded = normalizeAttempt({ settlementWarning });
    expect(degraded).toEqual({ kind: "ok", settlementWarning });
    for (const [current, incoming] of [
      [{ kind: "ok" }, degraded],
      [degraded, { kind: "ok" }],
    ] as const) {
      const terminal = mergeAttempt(current, incoming);
      expect(projectAttempt(terminal)).toMatchObject({
        settlementWarning,
        aborted: false,
        failed: false,
        interrupted: false,
        timedOut: false,
        promptError: null,
      });
    }
  });

  it("keeps failure precedence over a settlement warning", () => {
    const degraded = { kind: "ok", settlementWarning: warning } as const;
    const terminal = normalizeAttempt({
      promptError: "provider failed",
      settlementWarning: degraded.settlementWarning,
    });
    expect(terminal.kind).toBe("failed");
    for (const [current, incoming] of [
      [terminal, degraded],
      [degraded, terminal],
    ] as const) {
      const merged = mergeAttempt(current, incoming);
      expect(merged.kind).toBe("failed");
      expect(projectAttempt(merged).settlementWarning).toBeUndefined();
    }
  });

  it("merges observation-only timeout phases without creating a run timeout", () => {
    const toolExecution = { ...observedCompaction, phase: "tool_execution" } as const;

    for (const [current, incoming] of [
      [toolExecution, observedCompaction],
      [observedCompaction, toolExecution],
    ] as const) {
      const terminal = mergeAttempt(current, incoming);
      expect(terminal).toEqual(observedCompaction);
      expect(projectAttempt(terminal).timedOut).toBe(false);
    }
  });

  it("keeps timeout phase and source precedence in the canonical owner", () => {
    const failure = new Error("provider failed while aborting");
    const compactionFailure = failedAttempt(failure, "compaction");
    const failed = mergeAttempt({ kind: "ok" }, failedAttempt(failure));
    const externallyAborted = mergeAttempt(failed, externalAbort);
    const timedOut = mergeAttempt(externallyAborted, {
      kind: "timeout",
      phase: "compaction",
      source: "run_budget",
    });

    expect(timedOut).toEqual(timedOutAttempt(failure, "external"));

    expect([
      mergeAttempt({ kind: "timeout", phase: "prompt", source: "idle" }, externalAbort),
      mergeAttempt(runtimeAbort, observedCompaction),
      mergeAttempt(externalAbort, { kind: "aborted", source: "yield_cleanup" }),
      mergeAttempt(runtimeAbort, { kind: "aborted", source: "yield_cleanup" }),
    ]).toEqual([
      { kind: "timeout", phase: "prompt", source: "external", aborted: true },
      { kind: "aborted", source: "runtime", timeoutObservation: "compaction" },
      { kind: "aborted", source: "external" },
      { kind: "aborted", source: "runtime" },
    ]);
    const observedAbort = mergeAttempt(runtimeAbort, observedCompaction);
    expect([
      mergeAttempt(observedAbort, externalAbort),
      mergeAttempt(observedAbort, runtimeTimeout),
      mergeAttempt(runtimeTimeout, observedCompaction),
    ]).toEqual([
      { kind: "aborted", source: "external", timeoutObservation: "compaction" },
      { kind: "timeout", phase: "compaction", source: "runtime", aborted: true },
      { kind: "timeout", phase: "compaction", source: "runtime" },
    ]);
    const failedObservation = { ...compactionFailure, timeoutObservation: "compaction" } as const;
    expect(mergeAttempt(compactionFailure, observedCompaction)).toEqual(failedObservation);
    expect(mergeAttempt(observedCompaction, compactionFailure)).toEqual(failedObservation);
  });

  it("converges across terminal observation orderings", () => {
    const error = new Error("provider failed");
    const facts = [failedAttempt(error), runtimeAbort, observedCompaction, runtimeTimeout] as const;
    const orders = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [2, 0, 3, 1],
      [1, 3, 0, 2],
    ] as const;

    for (const order of orders) {
      const terminal = order.reduce<AttemptTerminal>(
        (current, index) => mergeAttempt(current, facts[index]),
        { kind: "ok" },
      );
      expect(terminal).toEqual(timedOutAttempt(error, "runtime"));
    }
  });

  it("normalizes the shipped harness shape through the same precedence owner", () => {
    const error = new Error("request timed out");
    expectNormalized({
      aborted: true,
      externalAbort: true,
      promptError: error,
      promptErrorSource: "prompt",
      timedOut: true,
      timedOutDuringCompaction: true,
    }).toEqual(timedOutAttempt(error, "external"));
    for (const input of [
      { timedOut: true, idleTimedOut: true, timedOutByRunBudget: true },
      { timedOutByRunBudget: true },
    ]) {
      expectNormalized(input).toEqual({ kind: "timeout", phase: "prompt", source: "run_budget" });
    }
    expect(projectAttempt(normalizeAttempt({ timedOut: true }))).toMatchObject({
      timedOut: true,
      aborted: false,
    });
    expectNormalized({ externalAbort: true }).toEqual(externalAbort);
    expectNormalized({
      promptError: error,
      promptErrorSource: "compaction",
      timedOutDuringCompaction: true,
    }).toEqual({ ...failedAttempt(error, "compaction"), timeoutObservation: "compaction" });
    const abortedCompaction = normalizeAttempt({
      aborted: true,
      timedOutDuringCompaction: true,
    });
    expect(abortedCompaction).toEqual({
      kind: "aborted",
      source: "runtime",
      timeoutObservation: "compaction",
    });
    expect(projectAttempt(abortedCompaction)).toMatchObject({
      aborted: true,
      timedOut: false,
      timedOutDuringCompaction: true,
    });
    expect(
      setAttemptFailure(
        { ...failedAttempt(error, "compaction"), timeoutObservation: "compaction" },
        { source: "prompt", error: new Error("replacement") },
      ),
    ).toMatchObject({
      kind: "failed",
      source: "prompt",
      timeoutObservation: "compaction",
    });
  });
});

describe("agent run terminal error projection", () => {
  it("accepts a healthy provider-started model stop", () => {
    expect(
      extractAgentRunTerminalError({
        meta: { stopReason: "stop", providerStarted: true, finalAssistantVisibleText: "Done." },
      }),
    ).toBeUndefined();
  });

  it.each([
    [{ stopReason: "timeout", timeoutPhase: "provider" }, "Inference timed out."],
    [{ stopReason: "aborted" }, "agent run aborted"],
  ] as const)("rejects a partial CLI result with %j", (meta, expected) => {
    expect(
      extractAgentRunTerminalError({
        payloads: [{ text: "I'll start checking." }],
        meta: {
          ...meta,
          aborted: true,
          providerStarted: true,
          finalAssistantVisibleText: "I'll start checking.",
        },
      }),
    ).toBe(expected);
  });

  it("preserves the owner error before a secondary payload diagnostic", () => {
    expect(
      extractAgentRunTerminalError({
        payloads: [{ text: "Secondary failure", isError: true }],
        meta: { error: { kind: "incomplete_turn", message: "The owner failed." } },
      }),
    ).toBe("The owner failed.");
  });
});
