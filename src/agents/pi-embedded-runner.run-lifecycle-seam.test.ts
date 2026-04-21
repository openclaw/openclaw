import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAttemptResult } from "./pi-embedded-runner/run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./pi-embedded-runner/run.overflow-compaction.harness.js";
import { buildEmbeddedRunLifecycleReceipt } from "./pi-embedded-runner/run/lifecycle-seam.js";

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent B1 lifecycle seam scaffold", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("emits pass_start and pass_end without changing successful run behavior", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    const events: string[] = [];

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      lifecycleSeam: {
        onPassStart: async (event) => {
          events.push(`${event.event}:${event.passIndex}:${event.passKind}`);
        },
        onPassEnd: async (event) => {
          events.push(`${event.event}:${event.passIndex}:${event.outcome}`);
        },
      },
    });

    expect(result.meta.error).toBeUndefined();
    expect(events).toEqual(["pass_start:1:model_call", "pass_end:1:success"]);
  });

  it("preserves the golden path when a noop seam is installed", async () => {
    const baselineAttempt = makeAttemptResult({ promptError: null });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(baselineAttempt);
    const baseline = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
    });

    resetRunOverflowCompactionHarnessMocks();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    const receipts: ReturnType<typeof buildEmbeddedRunLifecycleReceipt>[] = [];
    const withSeam = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      lifecycleSeam: {
        onPassStart: async (event) => {
          receipts.push(buildEmbeddedRunLifecycleReceipt({ event, outcome: "observed" }));
        },
        onPassEnd: async (event) => {
          receipts.push(buildEmbeddedRunLifecycleReceipt({ event, outcome: "observed" }));
        },
        onPassTransitionDecision: async (event) => {
          receipts.push(
            buildEmbeddedRunLifecycleReceipt({
              event,
              outcome: "noop",
              reason: event.proposedReason ?? undefined,
            }),
          );
          return { next: "noop" as const };
        },
      },
    });

    expect(withSeam.payloads).toEqual(baseline.payloads);
    expect(withSeam.meta).toMatchObject({
      ...baseline.meta,
      durationMs: withSeam.meta.durationMs,
    });
    expect(receipts).toEqual([
      {
        runtimeSurface: "m13_lifecycle_seam_v1",
        lifecycleSeamVersion: 1,
        event: "pass_start",
        passIndex: 1,
        passKind: "model_call",
        correlationId: receipts[0]?.correlationId,
        envelopeOnly: true,
        decisionEffective: false,
        outcome: "observed",
      },
      {
        runtimeSurface: "m13_lifecycle_seam_v1",
        lifecycleSeamVersion: 1,
        event: "pass_end",
        passIndex: 1,
        passKind: "model_call",
        correlationId: receipts[0]?.correlationId,
        envelopeOnly: true,
        decisionEffective: false,
        outcome: "observed",
      },
      {
        runtimeSurface: "m13_lifecycle_seam_v1",
        lifecycleSeamVersion: 1,
        event: "pass_transition_decision",
        passIndex: 1,
        passKind: "model_call",
        correlationId: receipts[0]?.correlationId,
        envelopeOnly: true,
        decisionEffective: false,
        outcome: "noop",
      },
    ]);
  });

  it("threads the observe_only decision mode through the runner without changing behavior", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    const decisions: Array<{ event: string; next: string }> = [];

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      lifecycleDecisionMode: "observe_only",
      lifecycleSeam: {
        onPassTransitionDecision: async (event) => {
          decisions.push({ event: event.event, next: "noop" });
          return { next: "noop", unsupportedCapabilities: ["decide"] };
        },
      },
    });

    expect(result.meta.error).toBeUndefined();
    expect(decisions).toEqual([{ event: "pass_transition_decision", next: "noop" }]);
  });

  it("emits assistant_retry when the assistant ends the pass with an error", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        lastAssistant: {
          stopReason: "error",
          errorMessage: "rate limited",
        } as never,
      }),
    );
    const events: string[] = [];

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      lifecycleSeam: {
        onPassEnd: async (event) => {
          events.push(`${event.event}:${event.passIndex}:${event.outcome}`);
        },
      },
    });

    expect(result.meta.livenessState).toBe("abandoned");
    expect(events).toEqual(["pass_end:1:assistant_retry"]);
  });

  it("fails closed on decision events when a seam returns non-noop control", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: new Error("plain prompt failure"),
      }),
    );

    await expect(
      runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        lifecycleSeam: {
          onPassTransitionDecision: vi.fn(async () => ({ next: "halt" as const })),
        },
      }),
    ).rejects.toThrow(/decision mode is observe_only/i);
  });

  it("fails closed in decide mode until transition execution is explicitly wired", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: new Error("plain prompt failure"),
      }),
    );

    await expect(
      runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        lifecycleDecisionMode: "decide",
        lifecycleSeam: {
          onPassTransitionDecision: vi.fn(async () => ({ next: "halt" as const })),
        },
      }),
    ).rejects.toThrow(/before transition execution is wired/i);
  });
});
