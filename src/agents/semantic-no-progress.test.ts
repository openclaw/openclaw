import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { DecisionRuntimeV1 } from "../decisions/types.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import { recordLoopOutcome } from "./agent-tools.before-tool-call.diagnostics.js";
import { createSemanticNoProgressObserver } from "./semantic-no-progress.js";
import { recordToolCall, recordToolCallOutcome } from "./tool-loop-detection.js";

type TestDecisionRuntime = {
  evaluate: (
    ...args: Parameters<DecisionRuntimeV1["evaluate"]>
  ) => ReturnType<DecisionRuntimeV1["evaluate"]>;
};

const evidence = {
  detector: "generic_repeat",
  level: "warning" as const,
  count: 10,
};

function outcome(verdict: string, probability = 0.9): TestDecisionRuntime {
  return {
    evaluate: vi.fn(async () => ({
      status: "ok" as const,
      provenance: {
        providerId: "fixture",
        rubricVersion: "semantic-no-progress-shadow-v1",
        runtimeGeneration: "fixture",
      },
      result: {
        model: "fixture",
        answers: {
          verdict: {
            type: "choice" as const,
            choice: verdict,
            probabilities: {
              progress: verdict === "progress" ? probability : 1 - probability,
              stalled: verdict === "stalled" ? probability : 1 - probability,
              regressing: verdict === "regressing" ? probability : 1 - probability,
              uncertain: verdict === "uncertain" ? probability : 1 - probability,
            },
          },
        },
      },
    })),
  };
}

function trajectoryEntry(index: number) {
  return {
    toolName: "read",
    toolParams: { path: `/tmp/item-${index}` },
    result: { content: [{ type: "text", text: `result-${index}` }] },
    toolCallOrdinal: index,
  };
}

describe("semantic no-progress shadow observer", () => {
  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
  });

  it("keeps normal outcomes in a bounded ring and only calls Decision with deterministic evidence", async () => {
    const runtime = outcome("stalled");
    const observer = createSemanticNoProgressObserver({
      signal: new AbortController().signal,
      assertActive: vi.fn(),
      agentId: "main",
      goal: "Finish the bounded shadow observation",
      runtime,
    });

    await observer.observeOutcome(trajectoryEntry(0));
    expect(runtime.evaluate).not.toHaveBeenCalled();
    await observer.observeOutcome({ ...trajectoryEntry(1), evidence });

    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
    const [batch, options] = vi.mocked(runtime.evaluate).mock.calls[0] ?? [];
    expect(options).toMatchObject({
      agentId: "main",
      purpose: "semantic-no-progress-shadow",
      rubricVersion: "semantic-no-progress-shadow-v1",
    });
    if (!batch) {
      throw new Error("Decision batch missing");
    }
    expect(batch.state).toMatchObject({
      goal: "Finish the bounded shadow observation",
      trajectoryVersion: 2,
      deterministicEvidence: evidence,
      trajectory: [
        { tool: "read", action: JSON.stringify({ path: "/tmp/item-0" }) },
        { tool: "read", action: JSON.stringify({ path: "/tmp/item-1" }) },
      ],
    });
    expect(batch.questions.verdict).toMatchObject({ type: "choice" });
    expect(observer.snapshot()).toMatchObject({
      latestJudgment: { verdict: "stalled", probability: 0.9, trajectorySize: 2 },
      trajectoryVersion: 2,
      metrics: {
        observedOutcomes: 2,
        decisionCalls: 1,
        staleDecisions: 0,
        candidateFollowOnCalls: 0,
        verdicts: { stalled: 1 },
      },
    });

    for (let index = 2; index < 14; index += 1) {
      await observer.observeOutcome(trajectoryEntry(index));
    }
    await observer.observeOutcome({ ...trajectoryEntry(14), evidence });
    const secondBatch = vi.mocked(runtime.evaluate).mock.calls[1]?.[0];
    if (!secondBatch) {
      throw new Error("expected a second Decision batch");
    }
    const secondTrajectory = (secondBatch.state as { trajectory: unknown[] }).trajectory;
    expect(secondTrajectory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "read",
          action: JSON.stringify({ path: "/tmp/item-14" }),
        }),
      ]),
    );
    expect(secondTrajectory).toHaveLength(8);
    expect(observer.snapshot().metrics.candidateFollowOnCalls).toBe(13);
  });

  it("does not revive a retained classification after consent is withdrawn and restored", async () => {
    let eligible = true;
    const runtime = outcome("stalled");
    const observer = createSemanticNoProgressObserver({
      signal: new AbortController().signal,
      assertActive: vi.fn(),
      isEligible: () => eligible,
      runtime,
    });
    await observer.observeOutcome({ ...trajectoryEntry(1), evidence });
    expect(observer.snapshot().latestJudgment?.verdict).toBe("stalled");
    eligible = false;
    expect(observer.snapshot().latestJudgment).toBeUndefined();
    eligible = true;
    expect(observer.snapshot().latestJudgment).toBeUndefined();
    await observer.observeOutcome({ ...trajectoryEntry(2), evidence });
    expect(observer.snapshot().latestJudgment).toMatchObject({
      verdict: "stalled",
      trajectorySize: 1,
    });
    await observer.close();
    expect(observer.snapshot().latestJudgment).toBeUndefined();
  });

  it.each([false, true])(
    "discards an in-flight classification after consent removal (restored=%s)",
    async (restoreConsent) => {
      const started = createDeferred();
      const release = createDeferred();
      let eligible = true;
      const answer = outcome("stalled");
      const runtime: TestDecisionRuntime = {
        evaluate: vi.fn(async (batch, options) => {
          started.resolve();
          await release.promise;
          return answer.evaluate(batch, options);
        }),
      };
      const observer = createSemanticNoProgressObserver({
        signal: new AbortController().signal,
        assertActive: vi.fn(),
        isEligible: () => eligible,
        runtime,
      });
      const pending = observer.observeOutcome({ ...trajectoryEntry(0), evidence });
      await started.promise;
      eligible = false;
      expect(observer.snapshot().latestJudgment).toBeUndefined();
      if (restoreConsent) {
        eligible = true;
      }
      release.resolve();
      await pending;
      if (!restoreConsent) {
        await observer.observeOutcome({ ...trajectoryEntry(1), evidence });
      }
      expect(observer.snapshot().latestJudgment).toBeUndefined();
      expect(runtime.evaluate).toHaveBeenCalledTimes(1);
      await observer.close();
    },
  );

  it("allows one in-flight Decision and joins it on close", async () => {
    let resolveDecision: (() => void) | undefined;
    const runtime: TestDecisionRuntime = {
      evaluate: vi.fn(
        () =>
          new Promise<Awaited<ReturnType<TestDecisionRuntime["evaluate"]>>>((resolve) => {
            resolveDecision = () =>
              resolve({
                status: "ok",
                provenance: {
                  providerId: "fixture",
                  rubricVersion: "semantic-no-progress-shadow-v1",
                  runtimeGeneration: "fixture",
                },
                result: {
                  model: "fixture",
                  answers: {
                    verdict: {
                      type: "choice",
                      choice: "uncertain",
                      probabilities: {
                        progress: 0.25,
                        stalled: 0.25,
                        regressing: 0.25,
                        uncertain: 0.25,
                      },
                    },
                  },
                },
              });
          }),
      ),
    };
    const observer = createSemanticNoProgressObserver({
      signal: new AbortController().signal,
      assertActive: vi.fn(),
      runtime,
    });
    const first = observer.observeOutcome({ ...trajectoryEntry(1), evidence });
    const second = observer.observeOutcome({ ...trajectoryEntry(2), evidence });
    await Promise.resolve();
    expect(observer.snapshot().metrics.skippedWhilePending).toBe(1);
    let closed = false;
    const close = observer.close().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    resolveDecision?.();
    await Promise.all([first, second, close]);
    expect(closed).toBe(true);
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
  });

  it("propagates caller cancellation while retaining no detached provider work", async () => {
    const controller = new AbortController();
    let settle: (() => void) | undefined;
    const runtime: TestDecisionRuntime = {
      evaluate: vi.fn(
        () =>
          new Promise<Awaited<ReturnType<TestDecisionRuntime["evaluate"]>>>((resolve) => {
            settle = () =>
              resolve({
                status: "unavailable",
                reason: "deadline",
              });
          }),
      ),
    };
    const observer = createSemanticNoProgressObserver({
      signal: controller.signal,
      assertActive: vi.fn(),
      runtime,
    });
    const pending = observer.observeOutcome({ ...trajectoryEntry(1), evidence });
    controller.abort(new Error("caller stopped"));
    settle?.();
    await expect(pending).rejects.toThrow("caller stopped");
    await observer.close();
  });

  it.each([
    [
      "a typed unavailable result",
      vi.fn(async () => ({ status: "unavailable" as const, reason: "transport" as const })),
    ],
    [
      "an unexpected provider exception",
      vi.fn(async () => {
        throw new Error("provider exploded");
      }),
    ],
  ])("records %s as a non-authoritative uncertain judgment", async (_label, evaluate) => {
    const observer = createSemanticNoProgressObserver({
      signal: new AbortController().signal,
      assertActive: vi.fn(),
      runtime: { evaluate },
    });

    await observer.observeOutcome({ ...trajectoryEntry(1), evidence });

    expect(observer.snapshot()).toMatchObject({
      latestJudgment: { verdict: "uncertain", evidence },
      metrics: {
        unavailableDecisions: 1,
        verdicts: { uncertain: 1 },
      },
    });
    await observer.close();
  });

  it("propagates admitted-owner loss instead of converting it to uncertainty", async () => {
    const ownerLost = new Error("admitted owner lost");
    let assertions = 0;
    const observer = createSemanticNoProgressObserver({
      signal: new AbortController().signal,
      assertActive: () => {
        assertions += 1;
        if (assertions >= 4) {
          throw ownerLost;
        }
      },
      runtime: outcome("stalled"),
    });

    await expect(observer.observeOutcome({ ...trajectoryEntry(1), evidence })).rejects.toBe(
      ownerLost,
    );
    expect(observer.snapshot().latestJudgment).toBeUndefined();
    expect(observer.snapshot().metrics.verdicts.uncertain).toBe(0);
    await observer.close();
  });

  it("rechecks the admitted owner after runtime resolution before provider work", async () => {
    const assertActive = vi.fn();
    const runtime = outcome("progress");
    vi.mocked(runtime.evaluate).mockImplementationOnce(async () => {
      expect(assertActive).toHaveBeenCalledTimes(3);
      return {
        status: "ok",
        provenance: {
          providerId: "fixture",
          rubricVersion: "semantic-no-progress-shadow-v1",
          runtimeGeneration: "fixture",
        },
        result: {
          model: "fixture",
          answers: {
            verdict: {
              type: "choice",
              choice: "progress",
              probabilities: { progress: 1 },
            },
          },
        },
      };
    });
    const observer = createSemanticNoProgressObserver({
      signal: new AbortController().signal,
      assertActive,
      runtime,
    });

    await observer.observeOutcome({ ...trajectoryEntry(1), evidence });

    expect(assertActive).toHaveBeenCalledTimes(4);
  });

  it("discards a Decision result when a newer outcome changes the captured trajectory", async () => {
    let resolveDecision: (() => void) | undefined;
    const runtime: TestDecisionRuntime = {
      evaluate: vi.fn(
        () =>
          new Promise<Awaited<ReturnType<TestDecisionRuntime["evaluate"]>>>((resolve) => {
            resolveDecision = () =>
              resolve({
                status: "ok",
                provenance: {
                  providerId: "fixture",
                  rubricVersion: "semantic-no-progress-shadow-v1",
                  runtimeGeneration: "fixture",
                },
                result: {
                  model: "fixture",
                  answers: {
                    verdict: {
                      type: "choice",
                      choice: "stalled",
                      probabilities: { stalled: 1 },
                    },
                  },
                },
              });
          }),
      ),
    };
    const observer = createSemanticNoProgressObserver({
      signal: new AbortController().signal,
      assertActive: vi.fn(),
      runtime,
    });
    const first = observer.observeOutcome({ ...trajectoryEntry(1), evidence });
    await vi.waitFor(() => expect(runtime.evaluate).toHaveBeenCalledTimes(1));
    await observer.observeOutcome(trajectoryEntry(2));
    resolveDecision?.();
    await first;

    expect(observer.snapshot()).toMatchObject({
      trajectoryVersion: 2,
      metrics: { staleDecisions: 1, verdicts: { stalled: 0 } },
    });
    expect(observer.snapshot().latestJudgment).toBeUndefined();
    await observer.close();
  });

  it("uses the real recordLoopOutcome boundary and gates the Decision on the existing detector", async () => {
    const sessionKey = "semantic-no-progress-production-boundary";
    const runId = "semantic-no-progress-run";
    const state = getDiagnosticSessionState({ sessionKey, sessionId: sessionKey });
    const config = { enabled: true, semanticNoProgress: "shadow" as const };
    const observer = {
      observeOutcome: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      snapshot: vi.fn(() => ({
        trajectoryVersion: 0,
        metrics: {
          observedOutcomes: 0,
          decisionCalls: 0,
          unavailableDecisions: 0,
          invalidDecisions: 0,
          staleDecisions: 0,
          skippedWhilePending: 0,
          candidateFollowOnCalls: 0,
          verdicts: { progress: 0, stalled: 0, regressing: 0, uncertain: 0 },
        },
      })),
    };
    const ctx = {
      sessionKey,
      sessionId: sessionKey,
      runId,
      loopDetection: config,
      semanticNoProgressObserver: observer,
    };
    const repeatedArgs = { path: "/tmp/repeated" };
    const repeatedResult = { content: [{ type: "text", text: "unchanged" }], details: {} };

    for (let index = 0; index < 10; index += 1) {
      const toolCallId = `prior-${index}`;
      recordToolCall(state, "read", repeatedArgs, toolCallId, config, { runId });
      recordToolCallOutcome(state, {
        toolName: "read",
        toolParams: repeatedArgs,
        toolCallId,
        result: repeatedResult,
        config,
        runId,
      });
    }
    const toolCallId = "current";
    recordToolCall(state, "read", repeatedArgs, toolCallId, config, { runId });
    await recordLoopOutcome({
      ctx,
      toolName: "read",
      toolParams: repeatedArgs,
      toolCallId,
      result: repeatedResult,
      toolCallOrdinal: 11,
    });

    expect(observer.observeOutcome).toHaveBeenCalledTimes(1);
    expect(observer.observeOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "read",
        toolParams: repeatedArgs,
        result: repeatedResult,
        toolCallOrdinal: 11,
        evidence: expect.objectContaining({ detector: "generic_repeat" }),
      }),
    );
  });
  it("preserves bounded thrown error details without stack paths", async () => {
    const runtime = outcome("stalled");
    const observer = createSemanticNoProgressObserver({
      signal: new AbortController().signal,
      assertActive: vi.fn(),
      runtime,
    });
    await observer.observeOutcome({
      ...trajectoryEntry(1),
      error: new Error("generated destination: edit source template"),
      evidence,
    });
    const batch = vi.mocked(runtime.evaluate).mock.calls[0]?.[0];
    expect(batch?.state).toMatchObject({
      trajectory: [
        expect.objectContaining({ error: "Error: generated destination: edit source template" }),
      ],
    });
    await observer.close();
  });

  it("captures existing ping-pong evidence after the completed call without mutating history", async () => {
    const sessionKey = "semantic-ping-pong";
    const runId = "semantic-ping-pong-run";
    const state = getDiagnosticSessionState({ sessionKey });
    const config = { enabled: true, semanticNoProgress: "shadow" as const };
    const observeOutcome = vi.fn(async () => undefined);
    const observer = {
      observeOutcome,
      close: vi.fn(async () => undefined),
      snapshot: createSemanticNoProgressObserver({
        signal: new AbortController().signal,
        assertActive: vi.fn(),
      }).snapshot,
    };
    for (let index = 0; index < 11; index++) {
      const toolName = index % 2 ? "write" : "read";
      const toolParams = { path: "/synthetic/same" };
      const toolCallId = `alternating-${index}`;
      recordToolCall(state, toolName, toolParams, toolCallId, config, { runId });
      await recordLoopOutcome({
        ctx: { sessionKey, runId, loopDetection: config, semanticNoProgressObserver: observer },
        toolName,
        toolParams,
        toolCallId,
        result: "unchanged",
      });
    }
    expect(observeOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ evidence: expect.objectContaining({ detector: "ping_pong" }) }),
    );
    expect(state.toolCallHistory).toHaveLength(11);
    expect(state.toolCallHistory?.at(-1)?.resultHash).toBeDefined();
  });
});
