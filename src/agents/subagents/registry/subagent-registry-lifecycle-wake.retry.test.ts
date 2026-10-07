import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import { mockBlockedCompletionDeliveryOwner } from "./subagent-registry-lifecycle-completion.test-support.js";
import { createLifecycleControllerFixture } from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

const completionDeliveryMocks = vi.hoisted(() => ({
  blockSubagentCompletionDelivery: vi.fn(),
  mutateRequesterCompletionBatch: vi.fn(),
  ownersByEntry: new Map<object, Pick<SubagentLifecycleOptions, "runs">>(),
}));

// Keep completion, session cleanup, and transport outside this retry-owner proof.
vi.mock("./subagent-registry-lifecycle-completion.js", () => ({
  completeSubagentRunAttempt: vi.fn(),
}));
vi.mock("./subagent-registry-lifecycle-announce-cleanup.js", () => ({
  resumeAncestorCleanup: vi.fn(),
  startSubagentAnnounceCleanupFlow: vi.fn(),
}));
vi.mock("./subagent-registry-lifecycle-finalize-cleanup.js", () => ({
  finalizeResumedAnnounceGiveUp: vi.fn(),
}));
vi.mock("./subagent-registry-requester-yield.js", () => ({
  settleRequesterTurnAfterSessionSpawns: vi.fn(),
}));
vi.mock("./subagent-registry-lifecycle-delivery.js", () => ({
  refreshFrozenResultFromSession: vi.fn(),
}));
vi.mock("./subagent-registry-lifecycle-log.js", () => ({
  buildSafeLifecycleErrorMeta: (error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  }),
  maskLifecycleIdentifier: () => "synthetic",
}));
vi.mock("../completion/subagent-completion-admission.store.js", () => ({
  blockSubagentCompletionDelivery: completionDeliveryMocks.blockSubagentCompletionDelivery,
  mutateRequesterCompletionBatch: completionDeliveryMocks.mutateRequesterCompletionBatch,
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

type WakeParams = Parameters<
  SubagentLifecycleOptions["maybeWakeRequesterAfterAllChildrenSettled"]
>[0];

describe("requester settle retry lifetime", () => {
  it.each([
    { mode: "current entry", rejectCompletion: false },
    { mode: "replacement entry", rejectCompletion: false },
    { mode: "current entry", rejectCompletion: true },
  ] as const)(
    "preserves retry ownership after the originating scope drains: $mode, rejected=$rejectCompletion",
    async ({ mode, rejectCompletion }) => {
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
          await params.transitionBatch(
            [params.settledEntry],
            {
              status: "pending",
              attemptCount: 1,
              nextAttemptAt: Date.now() + 1_000,
              rearmGeneration: 1,
            },
            () => {},
          );
          return false;
        }
        await params.completeBatch(
          [params.settledEntry],
          params.settledEntry.requesterSettleWake?.rearmGeneration,
        );
        return true;
      });
      const unexpected = async (): Promise<never> => {
        throw new Error("unexpected completion, cleanup, or transport effect");
      };
      const warn = vi.fn();
      let rejectNextCompletion = rejectCompletion;
      mockBlockedCompletionDeliveryOwner(completionDeliveryMocks);
      const controller = createLifecycleControllerFixture(
        {
          entry,
          runs,
          resumedRuns: new Set(),
          subagentAnnounceTimeoutMs: 1_000,
          getRuntimeConfig: () => ({}),
          beforeWrite: ({ postimages }) => {
            const nextWake = postimages.get(entry.runId)?.requesterSettleWake;
            if (rejectNextCompletion && !nextWake) {
              rejectNextCompletion = false;
              throw new Error("no-wake persistence unavailable");
            }
            persistedWakes.push(structuredClone(nextWake));
          },
          clearPendingLifecycleError: vi.fn(),
          countPendingDescendantRuns: async () => 0,
          getLatestRunForChildSession: () => null,
          suppressAnnounceForSteerRestart: () => false,
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
        },
        {
          callGateway: unexpected,
          cleanupBrowserSessionsForLifecycleEnd: unexpected,
          ownersByEntry: completionDeliveryMocks.ownersByEntry,
        },
      );

      try {
        origin.run(() => controller.resumeRequesterSettleWake(entry.runId, entry));
        await vi.waitFor(() => {
          expect(wake).toHaveBeenCalledTimes(1);
          expect(controller.scheduledRequesterSettleWakeTimers.get(entry.runId)).toBeDefined();
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
        const deliveryBeforeCompletion = structuredClone(runs.get(entry.runId)?.delivery);

        const replacement = {
          ...structuredClone(runs.get(entry.runId)!),
          generation: (entry.generation ?? 0) + 1,
        };
        if (mode === "replacement entry") {
          runs.set(entry.runId, replacement);
        }
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(() => {
          expect(
            controller.scheduledRequesterSettleWakeRuns.has(getSubagentRunRuntimeKey(entry)),
          ).toBe(false);
          expect(getActiveGatewayRootWorkCount()).toBe(0);
        });

        if (mode === "current entry") {
          expect(wake).toHaveBeenCalledTimes(2);
          expect(wakeSignals[1]).toBeDefined();
          expect(wakeSignals[1]).not.toBe(origin.signal);
          if (rejectCompletion) {
            expect(runs.get(entry.runId)?.requesterSettleWake).toEqual(persistedWakes[0]);
            expect(runs.get(entry.runId)?.delivery).toEqual(deliveryBeforeCompletion);
            expect(persistedWakes).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(30_000);
            expect(wake).toHaveBeenCalledTimes(2);
          }
          expect(runs.get(entry.runId)?.requesterSettleWake).toBeUndefined();
          expect(persistedWakes).toHaveLength(2);
        } else {
          expect(wake).toHaveBeenCalledTimes(1);
          expect(runs.get(entry.runId)).toBe(replacement);
          expect(replacement.requesterSettleWake).toEqual(persistedWakes[0]);
          expect(persistedWakes).toHaveLength(1);
        }
        expect(warn).toHaveBeenCalledTimes(rejectCompletion ? 1 : 0);
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
