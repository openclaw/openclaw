import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { maybeWakeRequesterAfterAllChildrenSettled as runRequesterSettleWake } from "../announce/subagent-announce.requester-settle-wake.js";
import type {
  blockSubagentCompletionDelivery,
  mutateRequesterSettleWakeBatch,
  settleRequesterCompletionBatch,
} from "../completion/subagent-completion-admission.store.js";
import type { SubagentCompletionMutationResult } from "../completion/subagent-completion-mutation.types.js";
import {
  clearSubagentPendingDelivery,
  ensureCompletionState,
  ensureDeliveryState,
  completeRequesterSettleWakeState,
  transitionRequesterSettleWakeState,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  SubagentRegistryWriteError,
  captureSubagentRunMutationSnapshot,
  publishSubagentRunPostimages,
} from "./subagent-registry-persistence.js";
import {
  countPendingDescendantRuns,
  getLatestLiveSubagentRunByChildSessionKey,
} from "./subagent-registry-read.js";
import { markRequesterTurnYieldedInRuns } from "./subagent-registry-requester-yield.js";
import { bindSubagentRunRecord } from "./subagent-registry.store.codec.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

function bindPolicyReceipt(entry: SubagentRunRecord) {
  // Direct controller fixtures permit sparse state; only the simulated receipt
  // uses the persisted shape. Keep the live policy inputs unchanged.
  const snapshot = structuredClone(entry);
  ensureCompletionState(snapshot);
  ensureDeliveryState(snapshot);
  return bindSubagentRunRecord(snapshot);
}

function createRequesterSettleWakeMutationFixture(
  ownersByEntry: WeakMap<
    SubagentRunRecord,
    Pick<SubagentLifecycleOptions, "runs" | "persistAsyncOrThrow">
  >,
): typeof mutateRequesterSettleWakeBatch {
  return async (params) => {
    params.assertCurrent();
    if (params.committed) {
      throw new Error("Native receipt reconciliation requires the registered worker fixture");
    }
    const first = params.entries[0];
    const owner = first && ownersByEntry.get(first);
    if (!owner || params.entries.some((entry) => ownersByEntry.get(entry)?.runs !== owner.runs)) {
      throw new Error("Requester policy fixture lost its controller owner");
    }
    const previous = new Map(
      params.entries.map((entry) => [entry, captureSubagentRunMutationSnapshot(entry)]),
    );
    const original = params.entries.map((subagent) => ({ subagent: structuredClone(subagent) }));
    const retire = new Set<SubagentRunRecord>();
    for (const entry of params.entries) {
      if (params.operation.kind === "transition") {
        transitionRequesterSettleWakeState(entry, params.operation.state);
      } else if (completeRequesterSettleWakeState(entry)) {
        retire.add(entry);
      }
    }
    const result: SubagentCompletionMutationResult = {
      applied: true,
      records: params.entries
        .filter((entry) => !retire.has(entry))
        .map((entry) => ({
          row: bindPolicyReceipt(entry),
          cleanupHandled: entry.cleanupHandled,
        })),
      retiredRunIds: [...retire].map((entry) => entry.runId),
      queueIds: [],
    };
    const publication = await publishSubagentRunPostimages({
      runs: owner.runs,
      previous,
      retire,
      context: params.context,
      assertCurrent() {
        params.context.admission.assertCurrent();
        if (params.entries.some((entry) => owner.runs.get(entry.runId) !== entry)) {
          throw new Error("Requester policy fixture row was replaced");
        }
      },
      assertPublicationCurrent: params.assertCurrent,
      onPublished: params.onPublished,
      persist: (context, callbacks, ...ids) =>
        owner.persistAsyncOrThrow(
          context,
          {
            ...callbacks,
            onCommitted() {
              params.onCommitted({ entries: original, result });
              callbacks.onCommitted?.();
            },
          },
          ...ids,
        ),
    });
    return { applied: true, publication: publication.publication };
  };
}

export async function mockRegistryRequesterWakeMutation() {
  const store = await import("../completion/subagent-completion-admission.store.js");
  const { persistSubagentRunsToDiskAsyncOrThrow } = await import("./subagent-registry-state.js");
  const original = store.mutateRequesterSettleWakeBatch;
  const ownersByEntry = new WeakMap<
    SubagentRunRecord,
    Pick<SubagentLifecycleOptions, "runs" | "persistAsyncOrThrow">
  >();
  const owner: Pick<SubagentLifecycleOptions, "runs" | "persistAsyncOrThrow"> = {
    runs: subagentRuns,
    persistAsyncOrThrow: (context, callbacks, ...ids) =>
      persistSubagentRunsToDiskAsyncOrThrow(subagentRuns, ids, { context, ...callbacks }),
  };
  const mutate = createRequesterSettleWakeMutationFixture(ownersByEntry);
  const spy = vi
    .spyOn(store, "mutateRequesterSettleWakeBatch")
    .mockImplementation((params) =>
      params.entries.some((entry) => ownersByEntry.has(entry)) ? mutate(params) : original(params),
    );
  onTestFinished(() => spy.mockRestore());
  return (entries: readonly SubagentRunRecord[]) => {
    for (const entry of entries) {
      if (subagentRuns.get(entry.runId) !== entry) {
        throw new Error("Requester policy fixture row was replaced before binding");
      }
      ownersByEntry.set(entry, owner);
    }
  };
}

export function mockBlockedCompletionDeliveryOwner(completionDeliveryMocks: {
  blockSubagentCompletionDelivery: Mock<typeof blockSubagentCompletionDelivery>;
  settleRequesterCompletionBatch: Mock<typeof settleRequesterCompletionBatch>;
  mutateRequesterSettleWakeBatch: Mock<typeof mutateRequesterSettleWakeBatch>;
  ownersByEntry: WeakMap<
    SubagentRunRecord,
    Pick<SubagentLifecycleOptions, "runs" | "persistAsyncOrThrow">
  >;
}): void {
  // This fixture mocks storage for controller-policy tests. Registered worker tests
  // separately own receipt reconciliation and actual native commit evidence.
  completionDeliveryMocks.mutateRequesterSettleWakeBatch.mockImplementation(
    createRequesterSettleWakeMutationFixture(completionDeliveryMocks.ownersByEntry),
  );
  completionDeliveryMocks.settleRequesterCompletionBatch.mockImplementation(
    async ({
      entries,
      outcome,
      onPublished,
      onCommitted,
    }: Parameters<
      typeof import("../completion/subagent-completion-admission.store.js").settleRequesterCompletionBatch
    >[0]) => {
      const original = entries.map(({ subagent }) => ({ subagent: structuredClone(subagent) }));
      const retiredRunIds: string[] = [];
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
        }
        if (completeRequesterSettleWakeState(subagent)) {
          completionDeliveryMocks.ownersByEntry.get(subagent)?.runs.delete(subagent.runId);
          retiredRunIds.push(subagent.runId);
        }
      }
      onCommitted?.({
        entries: original,
        result: {
          applied: true,
          records: entries
            .filter(({ subagent }) => !retiredRunIds.includes(subagent.runId))
            .map(({ subagent }) => ({
              row: bindPolicyReceipt(subagent),
              cleanupHandled: subagent.cleanupHandled,
            })),
          retiredRunIds,
          queueIds: [],
        },
      });
      onPublished?.();
      return { applied: true, publication: "published" };
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
    options?: Pick<
      SubagentCompletionRequest,
      "triggerCleanup" | "terminalReply" | "endedAt" | "recoveryCurrent"
    >,
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
  it.each(["replacement", "cancellation", "recovery authority"] as const)(
    "does not commit a captured result after %s retires its owner",
    async (transition) => {
      const entry = createRunEntry({ expectsCompletionMessage: false });
      const runs = new Map([[entry.runId, entry]]);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const persistOrThrow = vi.fn();
      let recoveryHostCurrent = true;
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
        recoveryCurrent: {
          prepare: async () => true,
          isHostCurrent: () => recoveryHostCurrent,
        },
      });
      const settled = Promise.allSettled([pending]);
      try {
        await entered.promise;
        const successor =
          transition === "replacement" ? createRunEntry({ runId: entry.runId }) : entry;
        if (transition === "recovery authority") {
          recoveryHostCurrent = false;
        } else {
          successor.execution = {
            status: "terminal",
            endedAt: 5_000,
            outcome: { status: "error", error: "cancelled" },
          };
        }
        runs.set(entry.runId, successor);
        const execution = successor.execution;
        release.resolve();
        const [result] = await settled;
        if (transition === "recovery authority") {
          expect(result).toMatchObject({
            status: "rejected",
            reason: expect.objectContaining({
              message: "Subagent terminal publication lost its original owner",
            }),
          });
        } else {
          expect(result?.status).toBe("fulfilled");
        }
        expect(runs.get(entry.runId)).toBe(successor);
        expect(successor.execution).toBe(execution);
        expect(persistOrThrow).not.toHaveBeenCalled();
        expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await settled;
      }
    },
  );
}

export function registerRequesterSettleRetirementTests({
  createRunEntry,
  createLifecycleController,
  waitForLifecycleState,
  completeRun,
}: Pick<
  Parameters<typeof registerPrivateCompletionSettlementTests>[0],
  "createRunEntry" | "createLifecycleController" | "waitForLifecycleState"
> & {
  completeRun: (
    controller: SubagentLifecycleController,
    entry: SubagentRunRecord,
    options?: Pick<SubagentCompletionRequest, "endedAt" | "triggerCleanup">,
  ) => Promise<void>;
}): void {
  it.each([false, true])(
    "resumes an ancestor after requester-settle retirement (persistence fails: %s)",
    async (persistenceFails) => {
      vi.useFakeTimers();
      const ancestor = createRunEntry({
        runId: "retirement-ancestor",
        childSessionKey: "agent:main:subagent:retirement-ancestor",
        endedAt: Date.now(),
        expectsCompletionMessage: true,
        suppressCompletionDelivery: true,
        wakeOnDescendantSettle: true,
        retainAttachmentsOnKeep: true,
      });
      const intermediate = createRunEntry({
        runId: "retirement-intermediate",
        childSessionKey: "agent:main:subagent:retirement-intermediate",
        requesterSessionKey: ancestor.childSessionKey,
        requesterAgentId: "main",
        endedAt: Date.now(),
        cleanup: "delete",
        requesterSettleWake: {
          status: "pending",
          attemptCount: 1,
          batchRunIds: ["retirement-intermediate"],
        },
      });
      const descendant = createRunEntry({
        runId: "retirement-descendant",
        childSessionKey: "agent:main:subagent:retirement-descendant",
        requesterSessionKey: intermediate.childSessionKey,
        requesterAgentId: "main",
        expectsCompletionMessage: false,
        retainAttachmentsOnKeep: true,
      });
      for (const entry of [ancestor, intermediate, descendant]) {
        subagentRuns.set(entry.runId, entry);
      }
      let failRetirement = persistenceFails;
      const controller = createLifecycleController({
        entry: ancestor,
        runs: subagentRuns,
        getLatestRunForChildSession: getLatestLiveSubagentRunByChildSessionKey,
        countPendingDescendantRuns,
        maybeWakeRequesterAfterAllChildrenSettled: runRequesterSettleWake,
        persistAsyncOrThrow: async (_context, publication) => {
          publication.assertCurrent();
          if (failRetirement && publication.retireRunIds?.includes(intermediate.runId)) {
            throw new SubagentRegistryWriteError(
              "not-committed",
              new Error("retirement transaction failed"),
            );
          }
          await Promise.resolve();
          publication.onCommitted?.();
        },
        resumeSubagentRun: (runId) => {
          const current = subagentRuns.get(runId);
          if (current) {
            controller.startSubagentAnnounceCleanupFlow(runId, current);
          }
        },
      });
      try {
        controller.startSubagentAnnounceCleanupFlow(ancestor.runId, ancestor);
        expect(ancestor.cleanupCompletedAt).toBeUndefined();
        controller.completeCleanupBookkeeping({
          runId: intermediate.runId,
          entry: intermediate,
          cleanup: "delete",
          completedAt: Date.now(),
          preserveTranscript: true,
        });
        if (persistenceFails) {
          await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
          expect(subagentRuns.has(intermediate.runId)).toBe(true);
          expect(ancestor.cleanupCompletedAt).toBeUndefined();
          failRetirement = false;
          const wake = controller.scheduledRequesterSettleWakeTimers.get(intermediate.runId)!;
          controller.resumeRequesterSettleWake(intermediate.runId, intermediate);
          await vi.advanceTimersByTimeAsync(wake.deadline - Date.now() - 1);
          expect(subagentRuns.has(intermediate.runId)).toBe(true);
          expect(ancestor.cleanupCompletedAt).toBeUndefined();
          await vi.advanceTimersByTimeAsync(1);
        }
        await waitForLifecycleState(() => expect(subagentRuns.has(intermediate.runId)).toBe(false));
        await completeRun(controller, descendant, {
          endedAt: Date.now(),
          triggerCleanup: true,
        });
        await waitForLifecycleState(() => expect(ancestor.cleanupCompletedAt).toBeTypeOf("number"));
      } finally {
        controller.clearScheduledResumeTimers();
        for (const entry of [ancestor, intermediate, descendant]) {
          subagentRuns.delete(entry.runId);
        }
        vi.useRealTimers();
      }
    },
  );
}
