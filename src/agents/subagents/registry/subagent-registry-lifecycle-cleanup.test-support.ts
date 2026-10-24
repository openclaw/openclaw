import { expect, it, vi, type Mock } from "vitest";
import * as transcripts from "../../../config/sessions/transcript-write-context.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createContext as createGatewayContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as rootWork from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { getOpenClawStateWorkerOwner } from "../../../state/openclaw-state-worker-owner.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { createRequesterTranscriptWriter } from "../../test-helpers/requester-transcript-writer.test-support.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import * as sessionEntryRuntime from "../announce/subagent-announce-delivery.runtime.js";
import * as ended from "./subagent-lifecycle-events.js";
import * as cleanupPolicy from "./subagent-registry-cleanup.js";
import { resolveAnnounceRetryDelayMs } from "./subagent-registry-helpers.js";
import { scheduleResumeSubagentRun } from "./subagent-registry-lifecycle-cleanup.js";
import * as fixtures from "./subagent-registry-lifecycle-controller.test-support.js";
import { registerRequesterAdmissionRetryTests } from "./subagent-registry-lifecycle-delivery.test-support.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function capturePostimage(entry: SubagentRunRecord) {
  let latest: SubagentRunRecord | undefined;
  return {
    beforeWrite: ({ postimages }: fixtures.LifecycleFixtureWrite) => {
      const row = postimages.get(entry.runId);
      latest = row ? structuredClone(row) : latest;
    },
    read: () => latest,
  };
}

export function registerDetachedCleanupAuthorityTest({
  createRunEntry,
  createLifecycleController,
}: Pick<fixtures.LifecycleTestDrivers, "createRunEntry" | "createLifecycleController">) {
  it("delivers detached cleanup after its requester tool and transcript owners retire", async () => {
    const sessionKey = "agent:main:disposed-cleanup-owner";
    const entry = createRunEntry({
      requesterSessionKey: sessionKey,
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
    });
    let disposed = false;
    const cleanupReady = createDeferredCore();
    const { requesterTranscriptWrite, withRequesterTranscriptWrite } =
      createRequesterTranscriptWriter(() => disposed);
    const freshTranscriptWrite = vi.fn(async () => {});
    const gatewayContext = createGatewayContext();
    const idempotencyKey = "detached-cleanup-delivery";
    const delivered = { runId: "cleanup-delivery", status: "ok" };
    gatewayContext.dedupe.set(`agent:${idempotencyKey}`, {
      ts: Date.now(),
      ok: true,
      payload: delivered,
    });
    const joinCleanup = observeRootWork();
    const dispatch = vi.fn(() =>
      dispatchGatewayMethodInProcess(
        "agent",
        { message: "Deliver the completed child result.", idempotencyKey },
        {
          expectFinal: true,
          forceSyntheticClient: true,
          resolveGatewayContext: () => gatewayContext,
        },
      ),
    );
    const runSubagentAnnounceFlow = vi.fn(async () => {
      await cleanupReady.promise;
      await dispatch();
      await transcripts.runWithOwnedSessionTranscriptWrite({ sessionKey }, freshTranscriptWrite);
      return "delivered" as const;
    });
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
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
        transcripts.withOwnedSessionTranscriptWrites(
          { sessionKey, withTranscriptWrite: withRequesterTranscriptWrite },
          async () => {
            expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
          },
        ),
    );

    disposed = true;
    cleanupReady.resolve();
    await joinCleanup();
    await expect(dispatch.mock.results[0]?.value).resolves.toEqual(delivered);
    expect(freshTranscriptWrite).toHaveBeenCalledOnce();
    expect(fixtures.readLifecycleRun(entry).delivery?.status).toBe("delivered");
    expect(fixtures.readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number");
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
}: Pick<fixtures.LifecycleTestDrivers, "createRunEntry" | "createLifecycleController"> & {
  completeRun: fixtures.CompleteLifecycleRun;
  completeAndJoinCleanup: fixtures.CompleteLifecycleRun;
  gatewayMocks: {
    callGateway: Mock<(options: CallGatewayOptions) => Promise<Record<string, unknown>>>;
  };
  helperMocks: { persistSubagentSessionTiming: Mock<() => Promise<void>> };
}) {
  it("preserves a delivered receipt while cleaning up a suppressed completion", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      suppressCompletionDelivery: true,
      delivery: {
        status: "delivered",
        disposition: "delivered",
        deliveredAt: 4_010,
        announcedAt: 4_020,
      },
    });
    const controller = createLifecycleController({ entry });
    const join = observeRootWork();
    expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
    await join();
    expect(fixtures.readLifecycleRun(entry)).toMatchObject({
      delivery: entry.delivery,
      cleanupCompletedAt: expect.any(Number),
    });
  });

  it("commits cancellation of a yielded run before browser cleanup", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: false });
    expect(markSubagentRunPausedAfterYield({ entry, endedAt: 3_000 })).toBe(true);
    const persisted = capturePostimage(entry);
    let committedBeforeCleanup = false;
    const cleanupBrowser = vi.fn(async () => {
      committedBeforeCleanup = persisted.read()?.endedReason === ended.SUBAGENT_ENDED_REASON_KILLED;
    });
    const controller = createLifecycleController({
      entry,
      beforeWrite: persisted.beforeWrite,
      cleanupBrowserSessionsForLifecycleEnd: cleanupBrowser,
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "operator cancelled" },
      reason: ended.SUBAGENT_ENDED_REASON_KILLED,
      triggerCleanup: true,
    });

    expect(persisted.read()).toMatchObject({
      endedReason: ended.SUBAGENT_ENDED_REASON_KILLED,
      execution: {
        status: "terminal",
        endedAt: 4_000,
        outcome: { status: "error", error: "operator cancelled" },
      },
      killReconciliation: { killedAt: 4_000 },
    });
    expect(persisted.read()?.pauseReason).toBeUndefined();
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
      reason: ended.SUBAGENT_ENDED_REASON_ERROR,
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
    expect(fixtures.readLifecycleRun(entry).execution.status).toBe("running");
    expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
    expect(emitProgress).not.toHaveBeenCalled();

    await completeRun(controller, entry, { triggerCleanup: false });

    expect(fixtures.readLifecycleRun(entry).execution.status).toBe("terminal");
    expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce();
    expect(emitProgress).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: entry.runId, childSessionKey: entry.childSessionKey }),
    );
  });

  it.each(["changed during read", "missing lifecycle revision"] as const)(
    "retires direct cleanup without deleting an unowned child: %s",
    async (kind) => {
      const unversioned = kind === "missing lifecycle revision";
      const entry = createRunEntry({
        cleanup: "delete",
        expectsCompletionMessage: false,
        ...(unversioned
          ? {
              endedAt: 4_000,
              childSessionIdentity: { sessionId: "child-session-id" },
            }
          : { suppressCompletionDelivery: true }),
      });
      const runs = new Map([[entry.runId, entry]]);
      let current = true;
      using sessionRead = vi.spyOn(sessionEntryRuntime, "loadSessionEntryByKey");
      sessionRead.mockImplementationOnce(async () => {
        current = false;
        return {
          sessionId: "child-session-id",
          updatedAt: 4_000,
          ...(unversioned ? {} : { lifecycleRevision: "child-lifecycle-revision" }),
        };
      });
      const assertCurrent = () => {
        if (!current) {
          throw new Error("Child session changed");
        }
      };
      const postimage = capturePostimage(entry);
      const controller = createLifecycleController({
        entry,
        runs,
        beforeWrite: postimage.beforeWrite,
      });
      if (unversioned) {
        const join = observeRootWork();
        expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
        await join();
        expect(sessionRead).not.toHaveBeenCalled();
        expect(controller.scheduledResumeTimers.size).toBe(0);
      } else {
        await completeAndJoinCleanup(controller, entry, {
          triggerCleanup: true,
          sessionEffects: {
            isCurrent: async () => current,
            assertHostCurrent: assertCurrent,
            assertCurrentEntry: assertCurrent,
          },
        });
        expect(postimage.read()?.execution.status).toBe("terminal");
      }
      expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
      expect(postimage.read()?.execution.suppressSessionEffects).toBe(true);
      expect(runs.has(entry.runId)).toBe(false);
    },
  );
}

export function registerDeliveryRetryOwnerTests({
  createRunEntry,
  createLifecycleController,
  helperMocks,
  waitForLifecycleState,
}: fixtures.LifecycleTestDrivers & {
  helperMocks: { safeRemoveAttachmentsDir: Mock<() => Promise<void>> };
}) {
  async function useRetryTimers() {
    // Retire real-read maintenance before faking the delivery retry clock.
    await getOpenClawStateWorkerOwner().close();
    vi.useFakeTimers();
  }

  function fixture(
    overrides: Parameters<typeof createRunEntry>[0] = {},
    options: Omit<fixtures.LifecycleControllerFixtureOptions, "entry"> = {},
  ) {
    const entry = createRunEntry({
      endedAt: Date.now(),
      expectsCompletionMessage: true,
      ...overrides,
    });
    const resume = vi.fn(() => controller.startSubagentAnnounceCleanupFlow(read()));
    const controller = createLifecycleController({ entry, resumeSubagentRun: resume, ...options });
    const read = () => fixtures.readLifecycleRun(entry);
    return {
      entry,
      controller,
      resume,
      read,
      [Symbol.dispose]() {
        helperMocks.safeRemoveAttachmentsDir.mockReset().mockResolvedValue(undefined);
        controller.clearRuntimeState();
        rootWork.resetGatewayWorkAdmission();
        vi.useRealTimers();
      },
    };
  }

  it.each(["recovers", "exhausts"] as const)(
    "retries detached attachment cleanup until it %s",
    async (outcome) => {
      await useRetryTimers();
      const persist = vi.fn();
      helperMocks.safeRemoveAttachmentsDir[
        outcome === "recovers" ? "mockRejectedValueOnce" : "mockRejectedValue"
      ](new Error("cleanup failed"));
      using run = fixture(
        { endedAt: 4_000, expectsCompletionMessage: false, retainAttachmentsOnKeep: false },
        { beforeWrite: persist },
      );
      const { entry, controller, resume, read } = run;
      expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
      await waitForLifecycleState(() => expect(read().cleanupHandled).toBe(false));
      expect(vi.getTimerCount()).toBe(1);
      if (outcome === "recovers") {
        expect(read().cleanupCompletedAt).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(resume).toHaveBeenCalledExactlyOnceWith(entry.runId);
        await waitForLifecycleState(() => expect(read().cleanupCompletedAt).toBeTypeOf("number"));
      } else {
        for (let attempts = 0; attempts < 10 && vi.getTimerCount() > 0; attempts += 1) {
          await vi.runOnlyPendingTimersAsync();
        }
        expect(helperMocks.safeRemoveAttachmentsDir.mock.calls.length).toBeGreaterThan(1);
        expect(helperMocks.safeRemoveAttachmentsDir.mock.calls.length).toBeLessThan(10);
        expect(read().cleanupHandled).toBe(false);
        expect(read().cleanupCompletedAt).toBeUndefined();
        expect(persist).toHaveBeenLastCalledWith(
          expect.objectContaining({ runIds: [entry.runId] }),
        );
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );

  it("retains a child result and retries parent restart admission without a sweep", async () => {
    await useRetryTimers();
    vi.setSystemTime(10_000);
    const actualPolicy = await vi.importActual<typeof cleanupPolicy>(
      "./subagent-registry-cleanup.js",
    );
    const decision = vi
      .spyOn(cleanupPolicy, "resolveDeferredCleanupDecision")
      .mockImplementation(actualPolicy.resolveDeferredCleanupDecision);
    const terminalReply = { disposition: "visible", text: "A=alpha" } as const;
    const runSubagentAnnounceFlow = vi
      .fn<SubagentLifecycleOptions["runSubagentAnnounceFlow"]>()
      .mockImplementationOnce(async (params) => {
        await params.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          disposition: "retryable",
          error:
            'Session "agent:main:main" changed while starting work. Retry. | SESSION_WORK_START_CHANGED',
        });
        return "retryable";
      })
      .mockResolvedValue("delivered");
    using run = fixture(
      { execution: { status: "running" }, retainAttachmentsOnKeep: true },
      {
        captureSubagentCompletionReply: vi.fn(async () => terminalReply.text),
        runSubagentAnnounceFlow,
      },
    );
    const { entry, controller, resume, read } = run;
    const join = observeRootWork();
    try {
      await controller.completeSubagentRun({
        runId: entry.runId,
        endedAt: Date.now(),
        outcome: { status: "ok" },
        reason: ended.SUBAGENT_ENDED_REASON_COMPLETE,
        terminalReply,
        triggerCleanup: true,
      });
      await join(true);
      expect(read().completion?.terminalReply).toEqual(terminalReply);
      expect(read().delivery).toMatchObject({
        status: "pending",
        payload: { childRunId: entry.runId, terminalReply },
        nextAttemptAt: 11_000,
      });
      expect(read().cleanupCompletedAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(999);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await join(true);
      expect(resume).toHaveBeenCalledExactlyOnceWith(entry.runId);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
      for (const [params] of runSubagentAnnounceFlow.mock.calls) {
        expect(params.terminalReply).toEqual(terminalReply);
        expect(params.roundOneReply).toBe("A=alpha");
      }
      expect(read().delivery?.status).toBe("delivered");
      expect(read().completion?.resultText).toBeUndefined();
      expect(loadSubagentRegistryFromSqlite().get(entry.runId)?.completion?.resultText).toBe(
        "A=alpha",
      );
      expect(read().cleanupCompletedAt).toBeTypeOf("number");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
    } finally {
      await join();
      decision.mockRestore();
    }
  });

  registerRequesterAdmissionRetryTests({
    createRunEntry,
    createLifecycleController,
    useRetryTimers,
  });

  it.each(["current", "completed cleanup", "replaced", "cancelled", "stale generation"] as const)(
    "resumes one scheduled delivery only for its current owner (%s)",
    async (state) => {
      const resume = vi.fn();
      using run = fixture(
        state === "completed cleanup"
          ? {
              cleanupCompletedAt: Date.now(),
              cleanupHandled: false,
              requesterSettleWake: { status: "pending", attemptCount: 0 },
            }
          : {},
        { resumeSubagentRun: resume },
      );
      const { entry, controller } = run;
      const runs = controller.options.runs;
      await useRetryTimers();
      if (state === "stale generation") {
        const stale = controller.bumpCleanupGeneration(entry);
        const current = controller.bumpCleanupGeneration(entry);
        scheduleResumeSubagentRun(controller, entry, 1_000, current);
        scheduleResumeSubagentRun(controller, entry, 2_000, stale);
      } else {
        controller.scheduleResume(entry, 1_000);
        controller.scheduleResume(entry, 1_000);
        expect(vi.getTimerCount()).toBe(1);
      }
      if (state === "replaced") {
        runs.set(entry.runId, createRunEntry({ ...entry, generation: 2 }));
      } else if (state === "cancelled") {
        controller.clearRuntimeState();
      }
      await vi.advanceTimersByTimeAsync(1_000);
      if (state === "stale generation") {
        expect(resume).toHaveBeenCalledExactlyOnceWith(entry.runId);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(resume).toHaveBeenCalledTimes(state === "replaced" || state === "cancelled" ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["delivered", "expired", "expired during preparation"] as const)(
    "keeps a required final scheduled after detached cleanup failures (%s)",
    async (outcome) => {
      await useRetryTimers();
      // Prevent worker maintenance from advancing this proof to an unrelated deadline.
      const maintenance = setTimeout(() => {}, 30_000);
      const countPendingDescendantRuns = vi.fn<
        SubagentLifecycleOptions["countPendingDescendantRuns"]
      >(async () => {
        throw new Error("descendant preparation failed");
      });
      const runSubagentAnnounceFlow = vi.fn<SubagentLifecycleOptions["runSubagentAnnounceFlow"]>(
        async () => "retryable",
      );
      using run = fixture(
        {
          outcome: { status: "ok" },
          endedReason: ended.SUBAGENT_ENDED_REASON_COMPLETE,
          delivery: { status: "pending", deadlineAt: Date.now() + 30 * 60_000 },
        },
        { countPendingDescendantRuns, runSubagentAnnounceFlow },
      );
      const { entry, controller, read } = run;
      const join = observeRootWork();
      const advanceRetry = async () => {
        await vi.advanceTimersByTimeAsync(
          resolveAnnounceRetryDelayMs(countPendingDescendantRuns.mock.calls.length),
        );
        await join(true);
      };
      try {
        controller.startSubagentAnnounceCleanupFlow(entry);
        await join(true);
        expect(read().cleanupHandled).toBe(false);
        for (let retry = 0; retry < 3; retry += 1) {
          await advanceRetry();
        }
        expect(countPendingDescendantRuns).toHaveBeenCalledTimes(4);
        expect(read().requesterSettleWake).toBeUndefined();
        expect(read().delivery?.status).toBe("pending");
        expect(controller.scheduledResumeTimers.size).toBe(1);
        if (outcome === "delivered") {
          countPendingDescendantRuns.mockResolvedValue(0);
          runSubagentAnnounceFlow.mockResolvedValue("delivered");
        } else if (outcome === "expired") {
          vi.setSystemTime(entry.delivery!.deadlineAt!);
        } else {
          countPendingDescendantRuns.mockImplementationOnce(async () => {
            vi.setSystemTime(entry.delivery!.deadlineAt!);
            throw new Error("descendant preparation crossed delivery deadline");
          });
        }
        await advanceRetry();
        if (outcome === "expired during preparation") {
          await advanceRetry();
        }
        expect(rootWork.getActiveGatewayRootWorkCount()).toBe(0);
        expect(read().delivery).toMatchObject({
          status: outcome === "delivered" ? "delivered" : "suspended",
          deadlineAt: entry.delivery?.deadlineAt,
        });
        if (outcome !== "delivered") {
          expect(read().delivery?.suspendedReason).toBe("expiry");
          expect(countPendingDescendantRuns).toHaveBeenCalledTimes(outcome === "expired" ? 4 : 5);
          expect(runSubagentAnnounceFlow.mock.lastCall?.[0].signal?.aborted).toBe(true);
        }
        expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(
          outcome === "expired during preparation" ? 6 : 5,
        );
      } finally {
        await join();
        clearTimeout(maintenance);
      }
    },
  );
}
