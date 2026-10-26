import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../../../shared/async-work-scope.js";
import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../../agent-run-terminal-outcome.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import {
  createSubagentTestGate,
  installLifecycleWorkerAckFixture,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
  retainSubagentRunRuntimeOwner,
} from "./subagent-run-generation.js";

function createHarness() {
  const entry = createSubagentRunRecord({
    runId: "completion-test",
    generation: 1,
    childSessionKey: "agent:main:subagent:completion-test",
    createdAt: 0,
    execution: { status: "terminal", endedAt: 1, outcome: { status: "error", error: "failed" } },
    cleanupHandled: true,
  });
  const runs = new Map([[entry.runId, entry]]);
  installLifecycleWorkerAckFixture(runs);
  const resumeError = new Error("synthetic resume failure");
  const dependencies = {
    runs,
    resumed: new Set([getSubagentRunRuntimeKey(entry)]),
    retryTimers: new Set<ReturnType<typeof setTimeout>>(),
    completeSubagentRun: vi
      .fn<(_: SubagentCompletionRequest) => Promise<void>>()
      .mockRejectedValue(new Error("synthetic completion failure")),
    resumeRun: vi.fn<() => void>(() => {
      throw resumeError;
    }),
    scheduleSweep: vi.fn(),
  };
  const warn = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
  const runtime = createSubagentRegistryCompletionRuntime(dependencies);
  const request: SubagentCompletionRequest = {
    runId: entry.runId,
    expectedEntry: entry,
    endedAt: 1,
    outcome: { status: "error", error: "failed" },
    reason: SUBAGENT_ENDED_REASON_ERROR,
    triggerCleanup: true,
  };
  const state = () => ({
    completed: dependencies.completeSubagentRun.mock.calls.length,
    resumes: dependencies.resumeRun.mock.calls.length,
    sweeps: dependencies.scheduleSweep.mock.calls.length,
    timers: dependencies.retryTimers.size,
    roots: getActiveGatewayRootWorkCount(),
    handled: entry.cleanupHandled,
    retained: dependencies.resumed.has(getSubagentRunRuntimeKey(entry)),
  });
  return {
    ...dependencies,
    warn,
    entry,
    runtime,
    request,
    complete: (source: string, overrides: Partial<SubagentCompletionRequest> = {}) =>
      runtime.completeSubagentRunWithRecovery({ ...request, ...overrides }, source),
    finalize: () =>
      runtime.finalizeInterruptedSubagentRun({ runId: entry.runId, error: "interrupted" }),
    expectState: (expected: Partial<ReturnType<typeof state>>) =>
      expect(state()).toMatchObject(expected),
  };
}

async function bindCompletionToLaunch(
  parentKind: "absent" | "released",
  launch: AsyncWorkScope,
  complete: () => Promise<void>,
) {
  const bind = () => launch.run(() => AsyncLocalStorage.bind(complete));
  if (parentKind === "absent") {
    return bind();
  }
  const parent = tryBeginGatewayRootWorkAdmission("collector-launch");
  if (!parent) {
    throw new Error("Expected an admitted collector launch");
  }
  try {
    return await parent.run(async () => bind());
  } finally {
    parent.release();
  }
}

describe("subagent completion rejection ownership", () => {
  let h: ReturnType<typeof createHarness>;
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
    h = createHarness();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetGatewayWorkAdmission();
    h.warn.mockRestore();
  });

  it.each(["absent", "released"] as const)(
    "captures a collector result after its launch scope closes with %s parent",
    async (parentKind) => {
      const launch = new AsyncWorkScope();
      await using rootDrain = {
        [Symbol.asyncDispose]: () =>
          vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0)),
      };
      await using capture = createSubagentTestGate();
      await using cleanup = createSubagentTestGate();
      let completionSignal: AbortSignal | undefined;
      let settled = false;
      let cleanupFinished = false;
      h.completeSubagentRun.mockImplementation(async () => {
        completionSignal = getAsyncWorkSignal();
        void cleanup.track(
          trackAsyncWork(async () => {
            await cleanup.wait();
            cleanupFinished = true;
          }),
        );
        await capture.wait();
        h.entry.completion = { required: false, resultText: "result-1", capturedAt: 2 };
      });
      const invoke = await bindCompletionToLaunch(parentKind, launch, () =>
        h.complete("subagent-wait", {
          outcome: { status: "ok" },
          reason: SUBAGENT_ENDED_REASON_COMPLETE,
        }),
      );
      await launch.drain();
      const completion = capture.track(
        invoke().finally(() => {
          settled = true;
        }),
      );
      await Promise.race([capture.entered, completion]);
      expect(completionSignal).toBeDefined();
      expect(completionSignal).not.toBe(launch.signal);
      expect(completionSignal?.aborted).toBe(false);
      expect(settled).toBe(false);
      expect(h.entry.completion?.resultText).toBeUndefined();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      capture.release();
      await expect(completion).resolves.toBeUndefined();
      expect(h.entry.completion?.resultText).toBe("result-1");
      expect(cleanupFinished).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      cleanup.release();
      await cleanup.drain();
      h.expectState({ resumes: 0, sweeps: 0 });
      await rootDrain[Symbol.asyncDispose]();
    },
  );

  it.each(["current", "replacement", "generation"] as const)(
    "defers retired-launch completion during restart and rechecks the %s owner",
    async (change) => {
      const launch = new AsyncWorkScope();
      h.completeSubagentRun.mockResolvedValue(undefined);
      const invoke = await bindCompletionToLaunch("released", launch, () =>
        h.complete("subagent-wait"),
      );
      await launch.drain();
      markGatewayRestartDraining();
      await invoke();
      h.expectState({ completed: 0, timers: 1, roots: 0 });
      if (change === "replacement") {
        h.runs.set(h.entry.runId, { ...h.entry });
      } else if (change === "generation") {
        h.entry.generation = 2;
      }
      resetGatewayWorkAdmission();
      await vi.advanceTimersByTimeAsync(1_000);
      h.expectState({ completed: change === "current" ? 1 : 0, timers: 0, roots: 0 });
    },
  );

  it.each([
    { kind: "timeout", reason: SUBAGENT_ENDED_REASON_COMPLETE },
    { kind: "cancellation", reason: SUBAGENT_ENDED_REASON_KILLED },
  ] as const)("contains the $kind grace callback's escaped rejection", async ({ kind, reason }) => {
    const schedule =
      kind === "timeout"
        ? h.runtime.pendingLifecycle.scheduleTimeout
        : h.runtime.pendingLifecycle.scheduleCancellation;
    schedule({ runId: h.entry.runId, expectedEntry: h.entry, endedAt: 1, error: "failed" });
    await vi.advanceTimersByTimeAsync(AGENT_RUN_TERMINAL_RETRY_GRACE_MS);
    h.expectState({ completed: 2, retained: false, roots: 0 });
    expect(h.completeSubagentRun).toHaveBeenLastCalledWith(expect.objectContaining({ reason }));
    expect(h.resumeRun).toHaveBeenCalledExactlyOnceWith(h.entry.runId);
    expect(isSameSubagentRunOwner(h.runs.get(h.entry.runId), h.entry)).toBe(true);
    expect(h.runs.get(h.entry.runId)?.cleanupHandled).toBe(false);
  });

  it("retries interrupted finalization after restart and retires the fired timer", async () => {
    markGatewayRestartDraining();
    await expect(h.finalize()).resolves.toBe(1);
    expect(h.retryTimers.size).toBe(1);
    resetGatewayWorkAdmission();
    await vi.advanceTimersByTimeAsync(1_000);
    h.expectState({ completed: 3, timers: 0, roots: 0 });
  });

  it("propagates an unknown SQLite outcome from interrupted finalization during restart drain", async () => {
    const error = new SqliteWorkerError("completion commit outcome is unknown", "outcome-unknown");
    h.completeSubagentRun.mockRejectedValueOnce(error);
    markGatewayRestartDraining();

    await expect(h.finalize()).rejects.toBe(error);
    h.expectState({ completed: 1, timers: 0, resumes: 0, sweeps: 0 });
    expect(h.warn).not.toHaveBeenCalled();
  });

  it.each(
    [1, 2].flatMap((attempt) =>
      ["removal", "replacement", "generation"].map((change) => ({ attempt, change })),
    ),
  )(
    "retires recovery after $change during failed attempt $attempt",
    async ({ attempt, change }) => {
      await using gate = createSubagentTestGate();
      h.resumeRun.mockImplementation(() => {});
      h.completeSubagentRun.mockReset();
      if (attempt === 2) {
        h.completeSubagentRun.mockRejectedValueOnce(new Error("retry current owner"));
      }
      h.completeSubagentRun.mockImplementation(async () => {
        await gate.wait();
        throw new Error("row retired during completion");
      });
      const completion = gate.track(h.complete("lifecycle-event", { expectedEntry: undefined }));
      await gate.entered;
      if (change === "removal") {
        h.runs.delete(h.entry.runId);
      } else if (change === "replacement") {
        h.runs.set(h.entry.runId, { ...h.entry, generation: 2 });
      } else {
        h.entry.generation = 2;
      }
      gate.release();
      await completion;
      h.expectState({ completed: attempt, resumes: 0, sweeps: 0, handled: true, retained: true });
    },
  );

  it.each(
    (["immediate", "restart"] as const).flatMap((retry) =>
      (
        ["unchanged", "resumed", "yielded-again", "killed", "new-terminal", "replacement"] as const
      ).map((change) => ({ retry, change })),
    ),
  )(
    "rechecks a committed yielded settlement before retrying its effects ($retry, $change)",
    async ({ retry, change }) => {
      h.entry.pauseReason = "sessions_yield";
      await using gate = createSubagentTestGate();
      let published: SubagentRunRecord | undefined;
      h.completeSubagentRun
        .mockImplementationOnce(async (request) => {
          expect(request.settleYielded).toBe(true);
          // The controller reports its immutable postimage before running terminal effects.
          published = {
            ...h.entry,
            pauseReason: undefined,
            collectorCompletion: { status: "failed" },
          };
          retainSubagentRunRuntimeOwner(h.entry, published);
          h.runs.set(h.entry.runId, published);
          request.recoveryCurrent?.onPublished?.(published);
          if (retry === "restart") {
            markGatewayRestartDraining();
          }
          await gate.wait();
          throw new Error("postcommit effect failed");
        })
        .mockImplementation(async (request) => {
          if (retry === "restart" && h.completeSubagentRun.mock.calls.length === 2) {
            throw new Error("second postcommit effect failed");
          }
          expect(request.settleYielded).toBeUndefined();
          expect(await request.recoveryCurrent?.prepare()).toBe(true);
          expect(request.recoveryCurrent?.isHostCurrent()).toBe(true);
        });
      const completion = gate.track(h.complete("sweeper", { settleYielded: true }));
      await gate.entered;
      if (!published) {
        throw new Error("Expected the committed settlement");
      }
      if (retry === "restart") {
        gate.release();
        await completion;
        expect(h.retryTimers.size).toBe(1);
      }
      const current = { ...published };
      retainSubagentRunRuntimeOwner(published, current);
      h.runs.set(h.entry.runId, current);
      if (change === "resumed") {
        current.execution = { status: "running", startedAt: 2 };
      } else if (change === "yielded-again") {
        current.pauseReason = "sessions_yield";
      } else if (change === "killed") {
        current.killIntent = { requestedAt: 2, reason: "stop" };
      } else if (change === "new-terminal") {
        // Retain outcome and runtime owner: the execution boundary itself changed.
        current.execution = { ...published.execution, startedAt: 2, endedAt: 3 };
      } else if (change === "replacement") {
        h.runs.set(h.entry.runId, { ...published });
      }
      gate.release();
      await completion;
      if (retry === "restart") {
        resetGatewayWorkAdmission();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.retryTimers.size).toBe(0);
      }
      h.expectState({
        completed: (retry === "restart" ? 2 : 1) + (change === "unchanged" ? 1 : 0),
        resumes: retry === "restart" ? 1 : 0,
        sweeps: 0,
      });
    },
  );

  it.each(["running", "yielded"] as const)(
    "preserves %s recovery after both attempts fail",
    async (state) => {
      if (state === "running") {
        h.entry.execution = { status: "running", startedAt: 0 };
      }
      if (state === "yielded") {
        h.entry.pauseReason = "sessions_yield";
      }
      await h.complete("subagent-wait");
      h.expectState({ completed: 2, resumes: 0, handled: true, retained: true });
      if (state === "running") {
        expect(h.scheduleSweep).toHaveBeenCalledExactlyOnceWith({ delayMs: 1_000 });
      } else {
        expect(h.scheduleSweep).not.toHaveBeenCalled();
      }
    },
  );
});
