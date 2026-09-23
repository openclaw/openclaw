import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import {
  SubagentLifecycleController,
  type SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Keep completion, session cleanup, and transport outside this retry-owner proof.
vi.mock("./subagent-registry-lifecycle-completion.js", () => ({
  completeSubagentRunAttempt: vi.fn(),
}));
vi.mock("./subagent-registry-lifecycle-announce-cleanup.js", () => ({
  finalizeResumedAnnounceGiveUp: vi.fn(),
  resumeAncestorCleanup: vi.fn(),
  startSubagentAnnounceCleanupFlow: vi.fn(),
}));
vi.mock("./subagent-registry-requester-yield.js", () => ({
  settleRequesterTurnAfterSessionSpawns: vi.fn(),
}));
vi.mock("./subagent-registry-lifecycle-delivery.js", () => ({
  buildSafeLifecycleErrorMeta: (error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  }),
  clearSubagentPendingDelivery: vi.fn(),
  markRequesterSettleWakePending: vi.fn(),
  maskLifecycleIdentifier: () => "synthetic",
  refreshFrozenResultFromSession: vi.fn(),
  safeSetSubagentTaskDeliveryStatus: vi.fn(),
}));
vi.mock("../completion/subagent-completion-admission.store.js", () => ({
  blockSubagentCompletionDelivery: vi.fn(),
  settleRequesterCompletionBatch: vi.fn(),
}));
vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(),
}));
vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession: vi.fn(),
}));
vi.mock("../requester-cron-authority.js", () => ({
  revokeRequesterCronAuthorityBatch: vi.fn(),
}));
vi.mock("../../../runtime.js", () => ({ defaultRuntime: { log: vi.fn() } }));
vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

type WakeParams = Parameters<
  SubagentLifecycleOptions["maybeWakeRequesterAfterAllChildrenSettled"]
>[0];

describe("requester settle retry lifetime", () => {
  it.each(["current entry", "replacement entry"] as const)(
    "preserves retry ownership after the originating scope drains: %s",
    async (mode) => {
      resetGatewayWorkAdmission();
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      // Native timers retain ALS. Preserve that contract when advancing fake time.
      const scheduleTimeout = globalThis.setTimeout;
      const timerSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, delay, ...args) =>
          scheduleTimeout(AsyncLocalStorage.bind(callback), delay, ...args),
        );
      const origin = new AsyncWorkScope();
      const entry: SubagentRunRecord = {
        runId: "retry-run",
        childSessionKey: "agent:main:subagent:retry-child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "return the child result",
        cleanup: "keep",
        createdAt: 1_000,
        execution: { status: "terminal", endedAt: 4_000 },
        expectsCompletionMessage: false,
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          rearmGeneration: 1,
          progressOperationId: "retained-progress-receipt",
        },
      };
      const runs = new Map([[entry.runId, entry]]);
      const persistedWakes: Array<SubagentRunRecord["requesterSettleWake"]> = [];
      const wakeSignals: Array<AbortSignal | undefined> = [];
      const wake = vi.fn(async (params: WakeParams) => {
        wakeSignals.push(getAsyncWorkSignal());
        if (wakeSignals.length === 1) {
          params.transitionBatch([entry], {
            status: "pending",
            attemptCount: 1,
            nextAttemptAt: Date.now() + 1_000,
            rearmGeneration: 1,
          });
          return false;
        }
        params.completeBatch([entry], entry.requesterSettleWake?.rearmGeneration);
        return true;
      });
      const unexpected = async (): Promise<never> => {
        throw new Error("unexpected completion, cleanup, or transport effect");
      };
      const warn = vi.fn();
      const controller = new SubagentLifecycleController({
        runs,
        resumedRuns: new Set(),
        subagentAnnounceTimeoutMs: 1_000,
        getRuntimeConfig: () => ({}),
        persist: vi.fn(),
        persistOrThrow: () => persistedWakes.push(structuredClone(entry.requesterSettleWake)),
        clearPendingLifecycleError: vi.fn(),
        countPendingDescendantRuns: () => 0,
        getLatestRunForChildSession: () => null,
        suppressAnnounceForSteerRestart: () => false,
        resolveSubagentTask: () => ({ lookup: "available" }),
        shouldEmitEndedHookForRun: () => false,
        emitSubagentEndedHookForRun: unexpected,
        emitSubagentProgressEndedForRun: unexpected,
        notifyContextEngineSubagentEnded: unexpected,
        retireSupersededRun: unexpected,
        resumeSubagentRun: vi.fn(),
        callGateway: unexpected,
        captureSubagentCompletionReply: unexpected,
        cleanupBrowserSessionsForLifecycleEnd: unexpected,
        runSubagentAnnounceFlow: unexpected,
        maybeWakeRequesterAfterAllChildrenSettled: wake,
        warn,
      });

      try {
        origin.run(() => controller.resumeRequesterSettleWake(entry.runId, entry));
        await vi.waitFor(() => {
          expect(wake).toHaveBeenCalledTimes(1);
          expect(controller.getRequesterSettleWakeTimer(entry.runId)).toBeDefined();
          expect(getActiveGatewayRootWorkCount()).toBe(0);
        });
        expect(persistedWakes).toEqual([
          {
            status: "pending",
            attemptCount: 1,
            nextAttemptAt: 11_000,
            rearmGeneration: 1,
            progressOperationId: "retained-progress-receipt",
          },
        ]);
        await origin.drain();
        expect(origin.signal.aborted).toBe(true);

        const replacement = structuredClone(entry);
        if (mode === "replacement entry") {
          runs.set(entry.runId, replacement);
        }
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(() => {
          expect(controller.hasScheduledRequesterSettleWakeRun(entry)).toBe(false);
          expect(getActiveGatewayRootWorkCount()).toBe(0);
        });

        if (mode === "current entry") {
          expect(wake).toHaveBeenCalledTimes(2);
          expect(wakeSignals[1]).toBeDefined();
          expect(wakeSignals[1]).not.toBe(origin.signal);
          expect(entry.requesterSettleWake).toBeUndefined();
          expect(persistedWakes).toHaveLength(2);
        } else {
          expect(wake).toHaveBeenCalledTimes(1);
          expect(runs.get(entry.runId)).toBe(replacement);
          expect(replacement.requesterSettleWake).toEqual(persistedWakes[0]);
          expect(persistedWakes).toHaveLength(1);
        }
        expect(warn).not.toHaveBeenCalled();
      } finally {
        controller.clearScheduledResumeTimers();
        await origin.drain();
        timerSpy.mockRestore();
        vi.useRealTimers();
        resetGatewayWorkAdmission();
      }
    },
  );
});
