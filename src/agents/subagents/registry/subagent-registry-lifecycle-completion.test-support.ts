import { expect, it, vi, type Mock } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../../tasks/detached-task-runtime-contract.js";
import { DetachedTaskLegacyRuntimeError } from "../../../tasks/detached-task-runtime-errors.js";
import type { setDetachedTaskDeliveryStatusByRunId } from "../../../tasks/detached-task-runtime.js";
import { TaskRunTransitionUnsettledError } from "../../../tasks/task-registry-transition.operation.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import type {
  blockSubagentCompletionDelivery,
  settleRequesterCompletionBatch,
} from "../completion/subagent-completion-admission.store.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { clearSubagentPendingDelivery } from "./subagent-registry-lifecycle-delivery.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { markRequesterTurnYieldedInRuns } from "./subagent-registry-requester-yield.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

export function buildExpectedAnnounceIdempotencyKey(entry: SubagentRunRecord): string {
  return buildAnnounceIdempotencyKey(
    buildAnnounceIdFromChildRun({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
    }),
  );
}

export const resolveLifecycleTask: SubagentLifecycleOptions["resolveSubagentTask"] = (run) => ({
  lookup: "available",
  task: run.killReconciliation
    ? undefined
    : {
        taskId: `task-${run.runId}`,
        runId: run.taskRunId ?? run.runId,
        runtime: "subagent",
        requesterSessionKey: run.requesterSessionKey,
        ownerKey: run.requesterSessionKey,
        scopeKind: "session",
        task: run.task,
        status: "succeeded",
        deliveryStatus: "pending",
        notifyPolicy: "done_only",
        createdAt: run.createdAt,
      },
});

export function mockBlockedCompletionDeliveryOwner(
  completionDeliveryMocks: {
    blockSubagentCompletionDelivery: Mock<typeof blockSubagentCompletionDelivery>;
    settleRequesterCompletionBatch: Mock<typeof settleRequesterCompletionBatch>;
    runsByEntry: WeakMap<SubagentRunRecord, Map<string, SubagentRunRecord>>;
  },
  taskExecutorMocks: {
    setDetachedTaskDeliveryStatusByRunId: Mock<typeof setDetachedTaskDeliveryStatusByRunId>;
  },
): void {
  completionDeliveryMocks.settleRequesterCompletionBatch.mockImplementation(
    ({
      entries,
      outcome,
    }: Parameters<
      typeof import("../completion/subagent-completion-admission.store.js").settleRequesterCompletionBatch
    >[0]) => {
      for (const { subagent, taskId } of entries) {
        if (subagent.pauseReason !== "sessions_yield") {
          // The store publishes a newly decoded receipt even when already delivered.
          if (outcome.delivered && subagent.delivery) {
            subagent.delivery = { ...subagent.delivery };
          }
          if (
            subagent.expectsCompletionMessage &&
            ["pending", "in_progress"].includes(subagent.delivery?.status ?? "pending")
          ) {
            if (outcome.delivered) {
              const deliveredAt = outcome.deliveredAt ?? Date.now();
              subagent.delivery = {
                ...subagent.delivery,
                status: "delivered",
                disposition: "delivered",
                deliveredAt,
                announcedAt: deliveredAt,
              };
              clearSubagentPendingDelivery(subagent);
              taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId({
                runId: subagent.taskRunId ?? subagent.runId,
                deliveryStatus: "delivered",
              });
            } else {
              completionDeliveryMocks.blockSubagentCompletionDelivery({
                subagent,
                taskId: taskId ?? "",
                reason: outcome.error ?? outcome.reason ?? "requester settle wake failed",
                disposition: outcome.disposition,
              });
            }
          }
          if (subagent.requesterTurnRunId && subagent.expectsCompletionMessage) {
            subagent.retireAfterRequesterTurn =
              subagent.retireAfterRequesterTurn ||
              subagent.requesterSettleWake?.retireAfterSettle ||
              undefined;
          } else if (subagent.requesterSettleWake?.retireAfterSettle) {
            completionDeliveryMocks.runsByEntry.get(subagent)?.delete(subagent.runId);
          }
        }
        subagent.requesterSettleWake = undefined;
      }
    },
  );
  completionDeliveryMocks.blockSubagentCompletionDelivery.mockImplementation(
    ({
      subagent,
      reason,
      suspendedReason,
      disposition,
    }: {
      subagent: SubagentRunRecord;
      reason: string;
      suspendedReason?: "expiry" | "permanent_failure";
      disposition?: NonNullable<SubagentRunRecord["delivery"]>["disposition"];
    }) => {
      subagent.delivery ??= { status: "pending" };
      subagent.delivery.lastError = reason;
      subagent.delivery.deliveredAt = undefined;
      subagent.delivery.announcedAt = undefined;
      if (suspendedReason) {
        subagent.delivery.status = "suspended";
        subagent.delivery.suspendedReason = suspendedReason;
        subagent.delivery.suspendedAt = Date.now();
        subagent.cleanupHandled = false;
        subagent.requesterSettleWake ??= { status: "pending", attemptCount: 0 };
      } else {
        subagent.delivery.status = "failed";
        subagent.delivery.disposition = disposition ?? subagent.delivery.disposition;
        subagent.suppressCompletionDelivery = true;
      }
      return true;
    },
  );
}

export function registerPrivateCompletionSettlementTests({
  createRunEntry,
  createLifecycleController,
  waitForLifecycleState,
  completionDeliveryMocks,
}: {
  createRunEntry: (
    overrides: Partial<SubagentRunRecord> & {
      endedAt?: number;
      outcome?: SubagentRunRecord["execution"]["outcome"];
    },
  ) => SubagentRunRecord;
  createLifecycleController: (
    options: {
      entry: SubagentRunRecord;
      runs?: Map<string, SubagentRunRecord>;
    } & Partial<SubagentLifecycleOptions>,
  ) => SubagentLifecycleController;
  waitForLifecycleState: (assertion: () => void) => Promise<unknown>;
  completionDeliveryMocks: {
    blockSubagentCompletionDelivery: Mock<typeof blockSubagentCompletionDelivery>;
  };
}): void {
  it.each([false, true])(
    "delivers private results held past the individual deadline until requester settlement (yielded: %s)",
    async (requesterYielded) => {
      const entry = createRunEntry({
        endedAt: Date.now() - 31 * 60_000,
        outcome: { status: "ok" },
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        requesterTurnRunId: "run-requester",
        completionTarget: "parent",
        expectsCompletionMessage: true,
        retainAttachmentsOnKeep: true,
        completion: { required: true, resultText: "private child result" },
        delivery: { status: "pending" },
      });
      const sibling = createRunEntry({
        runId: "slow-sibling",
        childSessionKey: "agent:main:subagent:slow-sibling",
        requesterSessionKey: entry.requesterSessionKey,
        requesterTurnRunId: "run-requester",
        expectsCompletionMessage: true,
      });
      const runSubagentAnnounceFlow = vi.fn<SubagentLifecycleOptions["runSubagentAnnounceFlow"]>(
        async (params) => {
          if (params.signal?.aborted) {
            await params.onDeliveryResult?.({ delivered: false, path: "none" });
            return "retryable";
          }
          return params.isCompletionOwnedByRequesterYield?.()
            ? "intentional_non_delivery"
            : "delivered";
        },
      );
      const runs = new Map([
        [entry.runId, entry],
        [sibling.runId, sibling],
      ]);
      const controller = createLifecycleController({
        entry,
        runs,
        runSubagentAnnounceFlow,
        resumeSubagentRun: (runId) => {
          controller.startSubagentAnnounceCleanupFlow(runId, runs.get(runId)!);
        },
        maybeWakeRequesterAfterAllChildrenSettled: async () => false,
      });
      try {
        expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(false);
        expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
        expect(entry.cleanupHandled).not.toBe(true);
        expect(entry.completion?.resultText).toBe("private child result");
        if (requesterYielded) {
          markRequesterTurnYieldedInRuns({
            requesterSessionKey: entry.requesterSessionKey,
            requesterTurnRunId: "run-requester",
            runs,
            persistOrThrow: () => undefined,
          });
        }
        expect(
          controller.settleRequesterTurnAfterSessionSpawns({
            requesterSessionKey: entry.requesterSessionKey,
            requesterTurnRunId: "run-requester",
            requesterYielded,
            acceptedSessionSpawns: [entry, sibling].map((child) => ({
              runId: child.runId,
              childSessionKey: child.childSessionKey,
              expectsCompletionMessage: true,
            })),
          }),
        ).toBe(true);
        await waitForLifecycleState(() => expect(entry.cleanupCompletedAt).toBeTypeOf("number"));
        expect(entry.requesterTurnRunId).toBeUndefined();
        expect(entry.delivery?.status).toBe(requesterYielded ? "pending" : "delivered");
        expect(entry.requesterSettleWake?.requesterYieldBatch).toBe(
          requesterYielded ? true : undefined,
        );
        expect(sibling.execution.endedAt).toBeUndefined();
        expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
        expect(completionDeliveryMocks.blockSubagentCompletionDelivery).not.toHaveBeenCalled();
        expect(entry.delivery?.lastError).toBeUndefined();
        expect(entry.delivery?.lastDropReason).toBeUndefined();
      } finally {
        controller.clearScheduledResumeTimers();
      }
    },
  );
}

export function registerTaskFinalizationAuthorityTests({
  createRunEntry,
  createLifecycleController,
  completeRun,
  taskExecutorMocks,
  helperMocks,
  lifecycleEventMocks,
  expectFields,
  firstCall,
}: {
  createRunEntry: (overrides?: Partial<SubagentRunRecord>) => SubagentRunRecord;
  createLifecycleController: (
    options: { entry: SubagentRunRecord } & Partial<SubagentLifecycleOptions>,
  ) => SubagentLifecycleController;
  completeRun: (
    controller: SubagentLifecycleController,
    entry: SubagentRunRecord,
    options?: Pick<SubagentCompletionRequest, "triggerCleanup" | "terminalReply" | "endedAt">,
  ) => Promise<void>;
  taskExecutorMocks: {
    completeTaskRunByRunId: Mock;
    failTaskRunByRunId: Mock;
    setDetachedTaskDeliveryStatusByRunId: Mock;
  };
  helperMocks: { persistSubagentSessionTiming: Mock<() => Promise<void>> };
  lifecycleEventMocks: { emitSessionLifecycleEvent: Mock };
  expectFields: (value: unknown, expected: Record<string, unknown>) => void;
  firstCall: (mock: Mock) => ReadonlyArray<unknown>;
}) {
  it("keeps provisional cancellation when a repeated success has no producer reply evidence", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
      execution: {
        status: "terminal",
        endedAt: 4_000,
        outcome: { status: "error", error: "killed" },
      },
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      suppressAnnounceReason: "killed",
      killReconciliation: {
        killedAt: 4_000,
        taskCancellationAccepted: true,
        suppressTaskDelivery: true,
      },
      completion: { required: true, resultText: null, capturedAt: 4_000 },
    });
    const marker = entry.killReconciliation;
    const original = structuredClone(entry);
    const task: TaskRecord = {
      taskId: "task-cancelled-completion",
      runtime: "subagent",
      requesterSessionKey: entry.requesterSessionKey,
      ownerKey: entry.requesterSessionKey,
      scopeKind: "session",
      runId: entry.taskRunId ?? entry.runId,
      childSessionKey: entry.childSessionKey,
      task: "Cancelled child",
      status: "cancelled",
      error: SUBAGENT_KILL_TASK_ERROR,
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 1,
      endedAt: 4_000,
    };
    taskExecutorMocks.failTaskRunByRunId.mockReturnValue([task]);
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask: () => ({ lookup: "available", task }),
    });
    await completeRun(controller, entry, {
      endedAt: 4_001,
      terminalReply: undefined,
      triggerCleanup: false,
    });
    expect(entry).toEqual(original);
    expect(entry.killReconciliation).toBe(marker);
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
    expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
  });

  it.each([
    new TaskRunTransitionUnsettledError("Task publication remains unsettled"),
    new Error("Task writer failed before sibling settlement"),
  ])("retains completion retries after canonical completion: %s", async (failure) => {
    const entry = createRunEntry();
    const task: TaskRecord = {
      taskId: "task-unsettled-completion",
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: entry.taskRunId ?? entry.runId,
      childSessionKey: entry.childSessionKey,
      task: "Already committed canonical completion",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 1,
      endedAt: 4_000,
    };
    taskExecutorMocks.completeTaskRunByRunId
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue([task]);
    const controller = createLifecycleController({
      entry,
      resolveSubagentTask: () => ({ lookup: "available", task }),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(completeRun(controller, entry)).rejects.toBe(failure);
      expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
    }
    await expect(completeRun(controller, entry)).resolves.toBeUndefined();
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledTimes(3);
    expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce();
  });

  it.each([
    new TaskRunTransitionUnsettledError("Delivery publication remains unsettled"),
    new Error("Delivery writer failed before sibling settlement"),
  ])("retries task delivery settlement without resending the completion: %s", async (failure) => {
    vi.useFakeTimers();
    const entry = createRunEntry({
      cleanup: "keep",
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } },
      completion: { required: true, resultText: "delivered result" },
    });
    const firstAttemptSettled = createDeferredCore();
    const cleanupCompleted = createDeferredCore();
    const persist = vi.fn(() => {
      if (entry.cleanupCompletedAt !== undefined) {
        firstAttemptSettled.resolve();
        cleanupCompleted.resolve();
      } else if (entry.delivery?.status === "delivered" && entry.cleanupHandled === false) {
        firstAttemptSettled.resolve();
      }
    });
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockRejectedValue(failure);
    const runSubagentAnnounceFlow = vi.fn<SubagentLifecycleOptions["runSubagentAnnounceFlow"]>(
      async (params) => {
        await params.onDeliveryResult?.({
          delivered: true,
          path: "direct",
          deliveredAt: Date.now(),
        });
        return "delivered";
      },
    );
    const controller = createLifecycleController({
      entry,
      persist,
      persistOrThrow: persist,
      runSubagentAnnounceFlow,
      resumeSubagentRun: (runId) => {
        controller.startSubagentAnnounceCleanupFlow(runId, entry);
      },
    });
    try {
      expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(true);
      await firstAttemptSettled.promise;
      expect(entry.delivery?.status).toBe("delivered");
      expect(entry.cleanupCompletedAt).toBeUndefined();
      expect(entry.cleanupHandled).toBe(false);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockResolvedValue([]);
      await vi.runOnlyPendingTimersAsync();
      await cleanupCompleted.promise;
      expect(entry.cleanupCompletedAt).toBeTypeOf("number");
      expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      expect(taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId).toHaveBeenLastCalledWith(
        expect.objectContaining({ runId: entry.runId, deliveryStatus: "delivered" }),
        expect.any(Function),
      );
    } finally {
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    { identity: "ASCII", runId: "run-1234567890", expected: "run-…7890" },
    { identity: "short ASCII", runId: "short", expected: "***" },
    { identity: "astral prefix", runId: "abc😀" + "x".repeat(10), expected: "abc…xxxx" },
    { identity: "astral suffix", runId: "x".repeat(10) + "😀abc", expected: "xxxx…abc" },
    {
      identity: "astral prefix and suffix",
      runId: "abc😀" + "x".repeat(10) + "😀xyz",
      expected: "abc…xyz",
    },
  ])(
    "keeps $identity run IDs well-formed in actual completion warnings",
    async ({ runId, expected }) => {
      const warn = vi.fn();
      const entry = createRunEntry({ runId });
      taskExecutorMocks.completeTaskRunByRunId.mockImplementation(() => {
        throw new DetachedTaskLegacyRuntimeError("task store boom");
      });

      const controller = createLifecycleController({ entry, warn });
      await expect(completeRun(controller, entry)).resolves.toBeUndefined();

      const [, warningFields] = firstCall(warn);
      const maskedRunId = (warningFields as { runId?: string }).runId;
      expect(maskedRunId).toBe(expected);
      expect(new TextDecoder().decode(new TextEncoder().encode(maskedRunId))).toBe(maskedRunId);
    },
  );

  it("does not reject completion when optional task tracking is absent and finalization throws", async () => {
    const persist = vi.fn();
    const persistOrThrow = vi.fn();
    const warn = vi.fn();
    const entry = createRunEntry();
    const runs = new Map([[entry.runId, entry]]);
    taskExecutorMocks.completeTaskRunByRunId.mockImplementation(() => {
      throw new DetachedTaskLegacyRuntimeError("task store boom", {
        cause: new Error("task store boom"),
      });
    });

    const controller = createLifecycleController({ entry, runs, persist, persistOrThrow, warn });

    await expect(completeRun(controller, entry)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(persistOrThrow).toHaveBeenCalledTimes(1);
    expect(persistOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      taskExecutorMocks.completeTaskRunByRunId.mock.invocationCallOrder[0]!,
    );
    const [warning, warningFields] = firstCall(warn);
    expect(warning).toBe("failed to finalize subagent background task state");
    expectFields(warningFields, {
      error: { name: "Error", message: "task store boom" },
      runId: "***",
      childSessionKey: "agent:main:…",
      outcomeStatus: "ok",
    });
    expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledTimes(1);
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:child",
      reason: "subagent-status",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });
  });

  it("joins task finalization and rejects a replaced completion owner before commit", async () => {
    const entry = createRunEntry();
    const runs = new Map([[entry.runId, entry]]);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const commit = vi.fn();
    taskExecutorMocks.completeTaskRunByRunId.mockImplementation(
      async (_params: unknown, assertCurrent?: () => void) => {
        entered.resolve();
        await release.promise;
        assertCurrent?.();
        commit();
        return [];
      },
    );
    const controller = createLifecycleController({ entry, runs });
    const completing = completeRun(controller, entry, { triggerCleanup: true });
    try {
      await entered.promise;
      expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
      runs.set(entry.runId, createRunEntry({ runId: entry.runId }));
      release.resolve();
      await expect(completing).rejects.toThrow("subagent task completion owner changed");
      expect(commit).not.toHaveBeenCalled();
      expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await completing.catch(() => undefined);
    }
  });

  it.each(["replacement", "delivery revocation"] as const)(
    "rejects %s while completion task lookup awaits publication",
    async (change) => {
      const entry = createRunEntry();
      const runs = new Map([[entry.runId, entry]]);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const controller = createLifecycleController({
        entry,
        runs,
        resolveSubagentTaskAsync: async (candidate) => {
          entered.resolve();
          await release.promise;
          return resolveLifecycleTask(candidate);
        },
      });
      const completing = completeRun(controller, entry, { triggerCleanup: true });
      const settled = Promise.allSettled([completing]);
      try {
        await entered.promise;
        const replacement =
          change === "replacement" ? createRunEntry({ runId: entry.runId }) : entry;
        if (change === "delivery revocation") {
          entry.suppressCompletionDelivery = true;
          entry.suppressAnnounceReason = "killed";
        }
        const expected = structuredClone(replacement);
        runs.set(entry.runId, replacement);
        release.resolve();
        await expect(completing).rejects.toThrow("subagent task completion owner changed");
        expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
        expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
        expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
        expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
        expect(runs.get(entry.runId)).toEqual(expected);
      } finally {
        release.resolve();
        await settled;
      }
    },
  );

  it("leaves a newly replaced provisional cancellation untouched while lookup awaits publication", async () => {
    const entry = createRunEntry({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: {
        status: "terminal",
        endedAt: 4_000,
        outcome: { status: "error", error: "killed" },
      },
      killReconciliation: { killedAt: 4_000 },
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const persist = vi.fn();
    const controller = createLifecycleController({
      entry,
      persistOrThrow: persist,
      resolveSubagentTaskAsync: async () => {
        entered.resolve();
        await release.promise;
        return { lookup: "available" };
      },
    });
    const completing = completeRun(controller, entry, { endedAt: 4_001, triggerCleanup: true });
    const settled = Promise.allSettled([completing]);
    try {
      await entered.promise;
      entry.killReconciliation = {
        killedAt: 4_002,
        taskCancellationAccepted: true,
        suppressTaskDelivery: true,
      };
      const accepted = structuredClone(entry);
      release.resolve();
      await completing;
      expect(entry).toEqual(accepted);
      expect(persist).not.toHaveBeenCalled();
      expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
      expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
      expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await settled;
    }
  });
}
