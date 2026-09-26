import { expect, it, vi, type Mock } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
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

export function mockBlockedCompletionDeliveryOwner(completionDeliveryMocks: {
  blockSubagentCompletionDelivery: Mock<typeof blockSubagentCompletionDelivery>;
  settleRequesterCompletionBatch: Mock<typeof settleRequesterCompletionBatch>;
  runsByEntry: WeakMap<SubagentRunRecord, Map<string, SubagentRunRecord>>;
}): void {
  completionDeliveryMocks.settleRequesterCompletionBatch.mockImplementation(
    async ({
      entries,
      outcome,
    }: Parameters<
      typeof import("../completion/subagent-completion-admission.store.js").settleRequesterCompletionBatch
    >[0]) => {
      for (const { subagent } of entries) {
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
            } else {
              await completionDeliveryMocks.blockSubagentCompletionDelivery({
                subagent,
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
    async ({
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

export function registerNativeCompletionAuthorityTest({
  createRunEntry,
  createLifecycleController,
  completeRun,
  helperMocks,
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
  helperMocks: { persistSubagentSessionTiming: Mock<() => Promise<void>> };
}) {
  it("emits one progress end event at the canonical terminal transition", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: false });
    const emitSubagentProgressEndedForRun = vi.fn(async () => {});
    const controller = createLifecycleController({ entry, emitSubagentProgressEndedForRun });
    const completion = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" as const },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    };

    await controller.completeSubagentRun(completion);
    await controller.completeSubagentRun(completion);

    expect(emitSubagentProgressEndedForRun).toHaveBeenCalledTimes(1);
    expect(emitSubagentProgressEndedForRun).toHaveBeenCalledWith(entry);
  });

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
        suppressTaskDelivery: true,
      },
      completion: { required: true, resultText: null, capturedAt: 4_000 },
    });
    const marker = entry.killReconciliation;
    const original = structuredClone(entry);
    const controller = createLifecycleController({ entry });
    await completeRun(controller, entry, {
      endedAt: 4_001,
      terminalReply: undefined,
      triggerCleanup: false,
    });
    expect(entry).toEqual(original);
    expect(entry.killReconciliation).toBe(marker);
    expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
  });
  it.each(["replacement", "cancellation"] as const)(
    "does not commit a captured result after native %s takes ownership",
    async (transition) => {
      const entry = createRunEntry({ expectsCompletionMessage: false });
      const runs = new Map([[entry.runId, entry]]);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const persistOrThrow = vi.fn();
      const controller = createLifecycleController({
        entry,
        runs,
        persistOrThrow,
        captureSubagentCompletionReply: async () => {
          entered.resolve();
          await release.promise;
          return "old result";
        },
      });
      const pending = completeRun(controller, entry, {
        terminalReply: undefined,
        triggerCleanup: false,
      });
      try {
        await entered.promise;
        const successor =
          transition === "replacement" ? createRunEntry({ runId: entry.runId }) : entry;
        successor.execution = {
          status: "terminal",
          endedAt: 5_000,
          outcome: { status: "error", error: "cancelled" },
        };
        runs.set(entry.runId, successor);
        const execution = successor.execution;
        release.resolve();
        await pending;
        expect(runs.get(entry.runId)).toBe(successor);
        expect(successor.execution).toBe(execution);
        expect(persistOrThrow).not.toHaveBeenCalled();
        expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
      }
    },
  );
}
