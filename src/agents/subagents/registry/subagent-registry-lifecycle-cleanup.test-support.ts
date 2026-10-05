import { expect, it, vi, type Mock } from "vitest";
import {
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createContext as createGatewayContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { scheduleResumeSubagentRun } from "./subagent-registry-lifecycle-attempt.js";
import {
  readLifecycleRun,
  type createRunEntry as createLifecycleRunEntry,
  type LifecycleControllerFixtureOptions,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

export function registerDetachedCleanupAuthorityTest({
  createRunEntry,
  createLifecycleController,
}: {
  createRunEntry: (params: {
    requesterSessionKey: string;
    endedAt: number;
    expectsCompletionMessage: boolean;
    retainAttachmentsOnKeep: boolean;
  }) => SubagentRunRecord;
  createLifecycleController: (
    params: { entry: SubagentRunRecord } & Pick<
      LifecycleControllerFixtureOptions,
      "runSubagentAnnounceFlow" | "beforeWrite"
    >,
  ) => Pick<SubagentLifecycleController, "startSubagentAnnounceCleanupFlow">;
}) {
  it("delivers detached cleanup after its requester tool and transcript owners retire", async () => {
    const sessionKey = "agent:main:disposed-cleanup-owner";
    const entry = createRunEntry({
      requesterSessionKey: sessionKey,
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
    });
    let disposed = false;
    let releaseCleanup!: () => void;
    const cleanupReady = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const requesterTranscriptWrite = vi.fn();
    const withRequesterTranscriptWrite = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      requesterTranscriptWrite();
      if (disposed) {
        throw new Error("attempt disposed before transcript write");
      }
      return await operation();
    };
    const freshTranscriptWrite = vi.fn(async () => {});
    const gatewayContext = createGatewayContext();
    const idempotencyKey = "detached-cleanup-delivery";
    const delivered = { runId: "cleanup-delivery", status: "ok" };
    gatewayContext.dedupe.set(`agent:${idempotencyKey}`, {
      ts: Date.now(),
      ok: true,
      payload: delivered,
    });
    const dispatchFinished = createDeferredCore<unknown>();
    const cleanupFinished = createDeferredCore();
    const runSubagentAnnounceFlow = vi.fn(async () => {
      await cleanupReady;
      try {
        const result = await dispatchGatewayMethodInProcess(
          "agent",
          { message: "Deliver the completed child result.", idempotencyKey },
          {
            expectFinal: true,
            forceSyntheticClient: true,
            resolveGatewayContext: () => gatewayContext,
          },
        );
        await runWithOwnedSessionTranscriptWrite({ sessionKey }, freshTranscriptWrite);
        dispatchFinished.resolve(result);
      } catch (error) {
        dispatchFinished.reject(error);
        throw error;
      }
      return "delivered" as const;
    });
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
      beforeWrite: ({ postimages }) => {
        if (postimages.get(entry.runId)?.cleanupCompletedAt !== undefined) {
          cleanupFinished.resolve();
        }
      },
    });

    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey,
        operationalRunInstance:
          createTestAdmittedRunContext("cleanup-requester").operationalRunInstance,
        receiptAuthority: () => !disposed,
      },
      () =>
        withOwnedSessionTranscriptWrites(
          { sessionKey, withTranscriptWrite: withRequesterTranscriptWrite },
          async () => {
            expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
          },
        ),
    );

    const dispatchResult = expect(dispatchFinished.promise).resolves.toEqual(delivered);
    disposed = true;
    releaseCleanup();

    await dispatchResult;
    await cleanupFinished.promise;
    expect(freshTranscriptWrite).toHaveBeenCalledOnce();
    expect(readLifecycleRun(entry).delivery?.status).toBe("delivered");
    expect(requesterTranscriptWrite).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
  });
}

export function registerDirectSessionCleanupAuthorityTests({
  createRunEntry,
  createLifecycleController,
  completeRun,
  completeAndJoinCleanup,
  gatewayMocks,
  helperMocks,
  sessionEntryReadMocks,
  waitForLifecycleState,
}: {
  createRunEntry: typeof createLifecycleRunEntry;
  createLifecycleController: (
    options: { entry: SubagentRunRecord } & Partial<LifecycleControllerFixtureOptions>,
  ) => SubagentLifecycleController;
  completeRun: (
    controller: SubagentLifecycleController,
    entry: SubagentRunRecord,
    options: Pick<SubagentCompletionRequest, "triggerCleanup" | "sessionEffects">,
  ) => Promise<void>;
  completeAndJoinCleanup: (
    controller: SubagentLifecycleController,
    entry: SubagentRunRecord,
    options: Pick<SubagentCompletionRequest, "triggerCleanup" | "sessionEffects" | "terminalReply">,
  ) => Promise<void>;
  gatewayMocks: {
    callGateway: Mock<(options: CallGatewayOptions) => Promise<Record<string, unknown>>>;
  };
  helperMocks: { persistSubagentSessionTiming: Mock<() => Promise<void>> };
  sessionEntryReadMocks: { loadSessionEntryByKey: Mock };
  waitForLifecycleState: (assertion: () => void) => Promise<void>;
}) {
  it("commits cancellation of a yielded run before browser cleanup", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: false });
    expect(markSubagentRunPausedAfterYield({ entry, endedAt: 3_000 })).toBe(true);
    let persisted: SubagentRunRecord | undefined;
    let committedBeforeCleanup = false;
    const cleanupBrowser = vi.fn(async () => {
      committedBeforeCleanup = persisted?.endedReason === SUBAGENT_ENDED_REASON_KILLED;
    });
    const controller = createLifecycleController({
      entry,
      beforeWrite: ({ postimages }) => {
        const postimage = postimages.get(entry.runId);
        if (postimage) {
          persisted = structuredClone(postimage);
        }
      },
      cleanupBrowserSessionsForLifecycleEnd: cleanupBrowser,
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "operator cancelled" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
      triggerCleanup: true,
    });

    expect(persisted).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: {
        status: "terminal",
        endedAt: 4_000,
        outcome: { status: "error", error: "operator cancelled" },
      },
      killReconciliation: { killedAt: 4_000 },
    });
    expect(persisted?.pauseReason).toBeUndefined();
    expect(cleanupBrowser).toHaveBeenCalledOnce();
    expect(committedBeforeCleanup).toBe(true);
  });

  it("allows terminal effects after a rejected recovery supplied a retired child guard", async () => {
    const entry = createRunEntry();
    const emitProgress = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      emitSubagentProgressEndedForRun: emitProgress,
    });
    const prepareRecoveryCurrent = vi.fn(async () => false);
    const assertRetired = () => {
      throw new Error("Recovery no longer owns the child session");
    };
    await controller.completeSubagentRun({
      runId: entry.runId,
      expectedEntry: entry,
      outcome: { status: "error", error: "rejected recovery" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
      recoverInterrupted: true,
      recoveryCurrent: {
        prepare: prepareRecoveryCurrent,
        isHostCurrent: () => true,
      },
      sessionEffects: {
        isCurrent: async () => false,
        assertHostCurrent: assertRetired,
        assertCurrentEntry: assertRetired,
      },
    });
    expect(prepareRecoveryCurrent).toHaveBeenCalledOnce();
    expect(readLifecycleRun(entry).execution.status).toBe("running");
    expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
    expect(emitProgress).not.toHaveBeenCalled();

    await completeRun(controller, entry, { triggerCleanup: false });

    expect(readLifecycleRun(entry).execution.status).toBe("terminal");
    expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce();
    expect(emitProgress).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: entry.runId, childSessionKey: entry.childSessionKey }),
    );
  });

  it("keeps direct delete cleanup root-admitted until the gateway call settles", async () => {
    const entry = createRunEntry({ cleanup: "delete", expectsCompletionMessage: false });
    const runs = new Map([[entry.runId, entry]]);
    let releaseDelete: (() => void) | undefined;
    gatewayMocks.callGateway.mockImplementation((opts) => {
      if (opts.method !== "sessions.delete") {
        return Promise.resolve({});
      }
      return new Promise<Record<string, unknown>>((resolve) => {
        releaseDelete = () => resolve({});
      });
    });
    const controller = createLifecycleController({ entry, runs });

    await completeRun(controller, entry, { triggerCleanup: true });
    await waitForLifecycleState(() => expect(releaseDelete).toBeTypeOf("function"));
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    releaseDelete?.();
    await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("settles direct cleanup when the child changes during its deletion identity read", async () => {
    const entry = createRunEntry({
      cleanup: "delete",
      expectsCompletionMessage: false,
      suppressCompletionDelivery: true,
    });
    const runs = new Map([[entry.runId, entry]]);
    let current = true;
    sessionEntryReadMocks.loadSessionEntryByKey.mockImplementationOnce(async () => {
      current = false;
      return { sessionId: "child-session-id", lifecycleRevision: "child-lifecycle-revision" };
    });
    const assertCurrent = () => {
      if (!current) {
        throw new Error("Child session changed");
      }
    };
    let finalPostimage: SubagentRunRecord | undefined;
    const controller = createLifecycleController({
      entry,
      runs,
      beforeWrite: ({ postimages }) => {
        const postimage = postimages.get(entry.runId);
        if (postimage) {
          finalPostimage = postimage;
        }
      },
    });

    await completeAndJoinCleanup(controller, entry, {
      triggerCleanup: true,
      sessionEffects: {
        isCurrent: async () => current,
        assertHostCurrent: assertCurrent,
        assertCurrentEntry: assertCurrent,
      },
    });

    expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
    expect(finalPostimage?.execution.status).toBe("terminal");
    expect(finalPostimage?.execution.suppressSessionEffects).toBe(true);
    expect(runs.has(entry.runId)).toBe(false);
  });
}

export function registerDeliveredCleanupEndedHookTest({
  createRunEntry,
  createLifecycleController,
  completeAndJoinCleanup,
}: Pick<
  Parameters<typeof registerDirectSessionCleanupAuthorityTests>[0],
  "createRunEntry" | "createLifecycleController" | "completeAndJoinCleanup"
>) {
  it("emits ended hook while retrying cleanup after completion was already delivered", async () => {
    const entry = createRunEntry({
      delivery: { status: "delivered", announcedAt: 3_500, deliveredAt: 3_500 },
      endedAt: 4_000,
      expectsCompletionMessage: true,
    });
    const emitSubagentEndedHookForRun = vi.fn(async () => {});

    const controller = createLifecycleController({
      entry,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
    });

    await expect(
      completeAndJoinCleanup(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "final completion reply" },
      }),
    ).resolves.toBeUndefined();

    expect(emitSubagentEndedHookForRun).toHaveBeenCalledTimes(1);
    expect(emitSubagentEndedHookForRun).toHaveBeenCalledWith({
      entry: expect.objectContaining({
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        delivery: expect.objectContaining({ status: "delivered", deliveredAt: 3_500 }),
      }),
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
      isCurrent: expect.any(Function),
      prepareCurrent: expect.any(Function),
    });
  });
}

export function registerDeliveryRetryOwnerTests({
  createRunEntry,
  createLifecycleController,
  helperMocks,
  waitForLifecycleState,
}: {
  createRunEntry: typeof createLifecycleRunEntry;
  createLifecycleController: (
    options: LifecycleControllerFixtureOptions,
  ) => SubagentLifecycleController;
  helperMocks: { safeRemoveAttachmentsDir: Mock<() => Promise<void>> };
  waitForLifecycleState: (assertion: () => void) => Promise<void>;
}) {
  it("retries a detached cleanup failure and completes on the next attempt", async () => {
    vi.useFakeTimers();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: false,
    });
    helperMocks.safeRemoveAttachmentsDir.mockRejectedValueOnce(new Error("cleanup failed"));
    const resumeSubagentRun = vi.fn(() => {
      controller.startSubagentAnnounceCleanupFlow(entry);
    });
    const controller = createLifecycleController({ entry, resumeSubagentRun });

    try {
      expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
      await waitForLifecycleState(() => expect(readLifecycleRun(entry).cleanupHandled).toBe(false));
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(resumeSubagentRun).toHaveBeenCalledExactlyOnceWith(entry.runId);
      await waitForLifecycleState(() =>
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
      );
    } finally {
      helperMocks.safeRemoveAttachmentsDir.mockReset().mockResolvedValue(undefined);
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  it("keeps the current retry when a stale cleanup continuation schedules late", async () => {
    vi.useFakeTimers();
    const entry = createRunEntry({ endedAt: Date.now(), expectsCompletionMessage: true });
    const resumeSubagentRun = vi.fn();
    const controller = createLifecycleController({ entry, resumeSubagentRun });
    const staleGeneration = controller.bumpCleanupGeneration(entry);
    const currentGeneration = controller.bumpCleanupGeneration(entry);
    try {
      scheduleResumeSubagentRun(controller, entry, 1_000, currentGeneration);
      scheduleResumeSubagentRun(controller, entry, 2_000, staleGeneration);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(resumeSubagentRun).toHaveBeenCalledExactlyOnceWith(entry.runId);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(resumeSubagentRun).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  it.each(["current", "completed cleanup", "replaced", "cancelled", "restart"] as const)(
    "resumes one scheduled delivery only for its current owner (%s)",
    async (state) => {
      vi.useFakeTimers();
      const entry = createRunEntry({
        endedAt: Date.now(),
        expectsCompletionMessage: true,
        ...(state === "completed cleanup"
          ? {
              cleanupCompletedAt: Date.now(),
              cleanupHandled: false,
              requesterSettleWake: { status: "pending" as const, attemptCount: 0 },
            }
          : {}),
      });
      const runs = new Map([[entry.runId, entry]]);
      const resumeSubagentRun = vi.fn();
      const controller = createLifecycleController({ entry, runs, resumeSubagentRun });
      try {
        controller.scheduleResume(entry, 1_000);
        controller.scheduleResume(entry, 1_000);
        expect(vi.getTimerCount()).toBe(1);
        if (state === "replaced") {
          runs.set(entry.runId, createRunEntry({ ...entry, generation: 2 }));
        } else if (state === "cancelled") {
          controller.clearScheduledResumeTimers();
        } else if (state === "restart") {
          markGatewayRestartDraining();
          await vi.advanceTimersByTimeAsync(1_000);
          expect(resumeSubagentRun).not.toHaveBeenCalled();
          expect(vi.getTimerCount()).toBe(1);
          resetGatewayWorkAdmission();
        }
        await vi.advanceTimersByTimeAsync(1_000);
        expect(resumeSubagentRun).toHaveBeenCalledTimes(
          state === "current" || state === "completed cleanup" || state === "restart" ? 1 : 0,
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        controller.clearScheduledResumeTimers();
        resetGatewayWorkAdmission();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "delivered",
    "expired",
    "expired during preparation",
    "expired during failure recovery",
  ] as const)(
    "keeps a required final scheduled after detached cleanup failures (%s)",
    async (outcome) => {
      vi.useFakeTimers();
      const entry = createRunEntry({
        endedAt: Date.now(),
        expectsCompletionMessage: true,
        outcome: { status: "ok" },
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        delivery: { status: "pending", deadlineAt: Date.now() + 30 * 60_000 },
      });
      const countPendingDescendantRuns = vi.fn<
        SubagentLifecycleOptions["countPendingDescendantRuns"]
      >(async () => {
        throw new Error("descendant preparation failed");
      });
      const runSubagentAnnounceFlow = vi.fn<SubagentLifecycleOptions["runSubagentAnnounceFlow"]>(
        async () => "retryable",
      );
      const controller = createLifecycleController({
        entry,
        countPendingDescendantRuns,
        runSubagentAnnounceFlow,
        beforeWrite: ({ postimages }) => {
          if (
            outcome === "expired during failure recovery" &&
            countPendingDescendantRuns.mock.calls.length === 5 &&
            postimages.get(entry.runId)?.cleanupHandled === false
          ) {
            vi.setSystemTime(entry.delivery!.deadlineAt!);
          }
        },
        resumeSubagentRun: () =>
          controller.startSubagentAnnounceCleanupFlow(readLifecycleRun(entry)),
      });
      try {
        controller.startSubagentAnnounceCleanupFlow(entry);
        await waitForLifecycleState(() =>
          expect(readLifecycleRun(entry).cleanupHandled).toBe(false),
        );
        for (let retry = 0; retry < 3; retry += 1) {
          await vi.runOnlyPendingTimersAsync();
        }
        expect(countPendingDescendantRuns).toHaveBeenCalledTimes(4);
        expect(readLifecycleRun(entry).requesterSettleWake).toBeUndefined();
        expect(readLifecycleRun(entry).delivery?.status).toBe("pending");
        expect(vi.getTimerCount()).toBe(1);

        if (outcome === "delivered") {
          countPendingDescendantRuns.mockResolvedValue(0);
          runSubagentAnnounceFlow.mockResolvedValue("delivered");
        } else if (outcome === "expired") {
          vi.setSystemTime(entry.delivery!.deadlineAt!);
        } else if (outcome === "expired during preparation") {
          countPendingDescendantRuns.mockImplementationOnce(async () => {
            vi.setSystemTime(entry.delivery!.deadlineAt!);
            throw new Error("descendant preparation crossed delivery deadline");
          });
        }
        await vi.runOnlyPendingTimersAsync();
        if (outcome.startsWith("expired during")) {
          await vi.runOnlyPendingTimersAsync();
        }
        await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        expect(readLifecycleRun(entry).delivery?.status).toBe(
          outcome === "delivered" ? "delivered" : "suspended",
        );
        expect(readLifecycleRun(entry).delivery?.deadlineAt).toBe(entry.delivery?.deadlineAt);
        if (outcome !== "delivered") {
          expect(readLifecycleRun(entry).delivery?.suspendedReason).toBe("expiry");
          expect(countPendingDescendantRuns).toHaveBeenCalledTimes(outcome === "expired" ? 4 : 5);
        }
        expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(
          outcome.startsWith("expired during") ? 6 : 5,
        );
        if (outcome !== "delivered") {
          expect(runSubagentAnnounceFlow.mock.lastCall?.[0].signal?.aborted).toBe(true);
        }
      } finally {
        controller.clearScheduledResumeTimers();
        vi.useRealTimers();
      }
    },
  );

  it("stops retrying detached cleanup failures and leaves the run durably unlocked", async () => {
    vi.useFakeTimers();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: false,
    });
    const persist = vi.fn();
    helperMocks.safeRemoveAttachmentsDir.mockRejectedValue(new Error("cleanup failed"));
    const resumeSubagentRun = vi.fn(() => {
      controller.startSubagentAnnounceCleanupFlow(entry);
    });
    const controller = createLifecycleController({
      entry,
      beforeWrite: persist,
      resumeSubagentRun,
    });

    try {
      expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
      await waitForLifecycleState(() => expect(readLifecycleRun(entry).cleanupHandled).toBe(false));
      expect(vi.getTimerCount()).toBe(1);

      for (let attempts = 0; attempts < 10 && vi.getTimerCount() > 0; attempts += 1) {
        await vi.runOnlyPendingTimersAsync();
      }

      expect(helperMocks.safeRemoveAttachmentsDir.mock.calls.length).toBeGreaterThan(1);
      expect(helperMocks.safeRemoveAttachmentsDir.mock.calls.length).toBeLessThan(10);
      expect(readLifecycleRun(entry).cleanupHandled).toBe(false);
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
      expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ runIds: [entry.runId] }));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      helperMocks.safeRemoveAttachmentsDir.mockReset().mockResolvedValue(undefined);
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });
}
