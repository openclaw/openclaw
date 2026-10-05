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
  completeRequesterSettleWakeState,
  transitionRequesterSettleWakeState,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import {
  readLifecycleRun,
  mutateLifecycleRun,
  type LifecycleControllerFixtureOptions,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { SubagentRegistryWriteError, mutateSubagentRuns } from "./subagent-registry-persistence.js";
import {
  countPendingDescendantRuns,
  getLatestLiveSubagentRunByChildSessionKey,
} from "./subagent-registry-read.js";
import { bindSubagentRunRecord } from "./subagent-registry.store.codec.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";

type CompletionPolicyOwners = Map<object, Pick<SubagentLifecycleOptions, "runs">>;

function policyOwner(owners: CompletionPolicyOwners, entries: readonly SubagentRunRecord[]) {
  const first = entries[0];
  const owner = first && owners.get(getSubagentRunRuntimeKey(first));
  if (
    !owner ||
    entries.some((entry) => owners.get(getSubagentRunRuntimeKey(entry))?.runs !== owner.runs)
  ) {
    throw new Error("Requester policy fixture lost its controller owner");
  }
  return owner;
}

function policyReceipt(
  postimages: ReadonlyMap<string, SubagentRunRecord | null>,
): SubagentCompletionMutationResult {
  return {
    applied: true,
    records: [...postimages.values()].flatMap((entry) =>
      entry ? [{ row: bindSubagentRunRecord(entry), cleanupHandled: entry.cleanupHandled }] : [],
    ),
    retiredRunIds: [...postimages].flatMap(([id, entry]) => (entry ? [] : [id])),
    queueIds: [],
  };
}

function blockedPolicyDraft(
  entry: SubagentRunRecord,
  params: Parameters<typeof blockSubagentCompletionDelivery>[0],
) {
  entry.delivery ??= { status: "pending" };
  entry.delivery.lastError = params.reason;
  entry.delivery.deliveredAt = undefined;
  entry.delivery.announcedAt = undefined;
  if (params.suspendedReason) {
    entry.delivery.status = "suspended";
    entry.delivery.suspendedReason = params.suspendedReason;
    entry.delivery.suspendedAt = Date.now();
    entry.cleanupHandled = false;
    entry.requesterSettleWake ??= { status: "pending", attemptCount: 0 };
  } else {
    entry.delivery.status = "failed";
    entry.delivery.disposition = params.disposition ?? entry.delivery.disposition;
    entry.suppressCompletionDelivery = true;
  }
}

function createRequesterSettleWakeMutationFixture(
  owners: CompletionPolicyOwners,
): typeof mutateRequesterSettleWakeBatch {
  return async (params) => {
    if (params.committed) {
      throw new Error("Native receipt reconciliation requires the registered worker fixture");
    }
    const owner = policyOwner(owners, params.entries);
    await mutateSubagentRuns(
      params.entries.map((entry) => entry.runId),
      (rows) => {
        const original: Array<{ subagent: SubagentRunRecord }> = [];
        const postimages = new Map<string, SubagentRunRecord | null>();
        for (const observed of params.entries) {
          const current = rows.get(observed.runId);
          if (!current || !isSameSubagentRunOwner(current, observed)) {
            throw new Error("Requester policy fixture row was replaced");
          }
          original.push({ subagent: current });
          const next = structuredClone(current);
          if (params.operation.kind === "transition") {
            transitionRequesterSettleWakeState(next, params.operation.state);
            postimages.set(next.runId, next);
          } else {
            postimages.set(next.runId, completeRequesterSettleWakeState(next) ? null : next);
          }
        }
        return { value: { entries: original, result: policyReceipt(postimages) }, postimages };
      },
      {
        runs: owner.runs,
        context: params.context,
        assertCurrent: params.assertCurrent,
        onPublished(_postimages, receipt) {
          params.onCommitted(receipt);
          params.onPublished();
        },
      },
    );
    return { applied: true, publication: "published" };
  };
}

export async function mockRegistryRequesterWakeMutation() {
  const store = await import("../completion/subagent-completion-admission.store.js");
  const original = store.mutateRequesterSettleWakeBatch;
  const owners: CompletionPolicyOwners = new Map();
  const mutate = createRequesterSettleWakeMutationFixture(owners);
  const spy = vi
    .spyOn(store, "mutateRequesterSettleWakeBatch")
    .mockImplementation((params) =>
      params.entries.some((entry) => owners.has(getSubagentRunRuntimeKey(entry)))
        ? mutate(params)
        : original(params),
    );
  onTestFinished(() => spy.mockRestore());
  return (entries: readonly SubagentRunRecord[]) => {
    for (const entry of entries) {
      if (!isSameSubagentRunOwner(subagentRuns.get(entry.runId), entry)) {
        throw new Error("Requester policy fixture row was replaced before binding");
      }
      owners.set(getSubagentRunRuntimeKey(entry), { runs: subagentRuns });
    }
  };
}

export function mockBlockedCompletionDeliveryOwner(completionDeliveryMocks: {
  blockSubagentCompletionDelivery: Mock<typeof blockSubagentCompletionDelivery>;
  settleRequesterCompletionBatch: Mock<typeof settleRequesterCompletionBatch>;
  mutateRequesterSettleWakeBatch: Mock<typeof mutateRequesterSettleWakeBatch>;
  ownersByEntry: CompletionPolicyOwners;
}): void {
  // Policy fixtures use the real row owner; native worker suites own queue receipts.
  completionDeliveryMocks.mutateRequesterSettleWakeBatch.mockImplementation(
    createRequesterSettleWakeMutationFixture(completionDeliveryMocks.ownersByEntry),
  );
  completionDeliveryMocks.settleRequesterCompletionBatch.mockImplementation(async (params) => {
    const entries = params.entries.map(({ subagent }) => subagent);
    const owner = policyOwner(completionDeliveryMocks.ownersByEntry, entries);
    await mutateSubagentRuns(
      entries.map((entry) => entry.runId),
      (rows) => {
        const original: Array<{ subagent: SubagentRunRecord }> = [];
        const postimages = new Map<string, SubagentRunRecord | null>();
        for (const observed of entries) {
          const current = rows.get(observed.runId);
          if (!current || !isSameSubagentRunOwner(current, observed)) {
            throw new Error("Requester policy fixture row was replaced");
          }
          original.push({ subagent: current });
          const next = structuredClone(current);
          if (
            next.pauseReason !== "sessions_yield" &&
            next.expectsCompletionMessage &&
            ["pending", "in_progress"].includes(next.delivery?.status ?? "pending")
          ) {
            if (params.outcome.delivered) {
              const deliveredAt = params.outcome.deliveredAt ?? Date.now();
              next.delivery = {
                ...next.delivery,
                status: "delivered",
                disposition: "delivered",
                deliveredAt,
                announcedAt: deliveredAt,
              };
              clearSubagentPendingDelivery(next);
            } else {
              blockedPolicyDraft(next, {
                subagent: current,
                reason:
                  params.outcome.error ?? params.outcome.reason ?? "requester settle wake failed",
                disposition: params.outcome.disposition,
              });
            }
          }
          postimages.set(next.runId, completeRequesterSettleWakeState(next) ? null : next);
        }
        return { value: { entries: original, result: policyReceipt(postimages) }, postimages };
      },
      {
        runs: owner.runs,
        context: params.context,
        assertCurrent() {
          if (!params.isCurrent()) {
            throw new Error("Requester policy fixture owner changed");
          }
        },
        onPublished(_postimages, receipt) {
          params.onCommitted?.(receipt);
          params.onPublished?.();
        },
      },
    );
    return { applied: true, publication: "published" };
  });
  completionDeliveryMocks.blockSubagentCompletionDelivery.mockImplementation(async (params) => {
    const owner = policyOwner(completionDeliveryMocks.ownersByEntry, [params.subagent]);
    return mutateSubagentRuns(
      [params.subagent.runId],
      (rows) => {
        const current = rows.get(params.subagent.runId);
        if (!current || !isSameSubagentRunOwner(current, params.subagent)) {
          return { value: false };
        }
        const next = structuredClone(current);
        blockedPolicyDraft(next, params);
        return { value: true, postimages: new Map([[next.runId, next]]) };
      },
      { runs: owner.runs, context: params.context, assertCurrent: params.assertCurrent },
    );
  });
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
    options: LifecycleControllerFixtureOptions,
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
          controller.startSubagentAnnounceCleanupFlow(runs.get(runId)!);
        },
        maybeWakeRequesterAfterAllChildrenSettled: async () => false,
      });
      try {
        expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(false);
        expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
        expect(readLifecycleRun(entry).cleanupHandled).not.toBe(true);
        expect(readLifecycleRun(entry).completion?.resultText).toBe("private child result");
        if (requesterYielded) {
          await controller.markRequesterTurnYielded({
            requesterSessionKey: entry.requesterSessionKey,
            requesterTurnRunId: "run-requester",
          });
        }
        expect(
          await controller.settleRequesterTurnAfterSessionSpawns({
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
        await waitForLifecycleState(() =>
          expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
        );
        expect(readLifecycleRun(entry).requesterTurnRunId).toBeUndefined();
        expect(readLifecycleRun(entry).delivery?.status).toBe(
          requesterYielded ? "pending" : "delivered",
        );
        expect(readLifecycleRun(entry).requesterSettleWake?.requesterYieldBatch).toBe(
          requesterYielded ? true : undefined,
        );
        expect(readLifecycleRun(sibling).execution.endedAt).toBeUndefined();
        expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
        expect(completionDeliveryMocks.blockSubagentCompletionDelivery).not.toHaveBeenCalled();
        expect(readLifecycleRun(entry).delivery?.lastError).toBeUndefined();
        expect(readLifecycleRun(entry).delivery?.lastDropReason).toBeUndefined();
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
    options: LifecycleControllerFixtureOptions,
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
    expect(emitSubagentProgressEndedForRun).toHaveBeenCalledWith(readLifecycleRun(entry));
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
    expect(readLifecycleRun(entry)).toEqual(original);
    expect(readLifecycleRun(entry).killReconciliation).toBe(marker);
    expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
  });
  it.each(["replacement", "cancellation", "recovery authority"] as const)(
    "does not commit a captured result after %s retires its owner",
    async (transition) => {
      const entry = createRunEntry({ expectsCompletionMessage: false });
      const runs = new Map([[entry.runId, entry]]);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const beforeWrite = vi.fn();
      let recoveryHostCurrent = true;
      const controller = createLifecycleController({
        entry,
        runs,
        beforeWrite,
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
        if (transition === "recovery authority") {
          recoveryHostCurrent = false;
        } else {
          await mutateLifecycleRun(entry, (draft) => {
            if (transition === "replacement") {
              draft.generation = (draft.generation ?? 0) + 1;
            }
            draft.execution = {
              status: "terminal",
              endedAt: 3_000,
              outcome: { status: "error", error: "cancelled" },
            };
            draft.endedReason = SUBAGENT_ENDED_REASON_KILLED;
            draft.killReconciliation = { killedAt: 3_000, taskCancellationAccepted: true };
          });
        }
        const successor = runs.get(entry.runId);
        beforeWrite.mockClear();
        release.resolve();
        const [result] = await settled;
        if (transition === "cancellation") {
          expect(result?.status).toBe("fulfilled");
        } else {
          expect(result).toMatchObject({
            status: "rejected",
            reason: expect.objectContaining({
              message: "Subagent terminal execution changed",
            }),
          });
        }
        expect(runs.get(entry.runId)).toBe(successor);
        expect(beforeWrite).not.toHaveBeenCalled();
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
    "resumes an ancestor after retained requester settlement (persistence fails: %s)",
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
        beforeWrite: ({ postimages }) => {
          const postimage = postimages.get(intermediate.runId);
          if (
            failRetirement &&
            postimage &&
            typeof postimage.cleanupCompletedAt === "number" &&
            postimage.requesterSettleWake === undefined
          ) {
            throw new SubagentRegistryWriteError(
              "not-committed",
              new Error("retirement transaction failed"),
            );
          }
        },
        resumeSubagentRun: (runId) => {
          const current = subagentRuns.get(runId);
          if (current) {
            controller.startSubagentAnnounceCleanupFlow(current);
          }
        },
      });
      try {
        controller.startSubagentAnnounceCleanupFlow(ancestor);
        expect(readLifecycleRun(ancestor).cleanupCompletedAt).toBeUndefined();
        await controller.completeCleanupBookkeeping({
          runId: intermediate.runId,
          entry: intermediate,
          cleanup: "delete",
          completedAt: Date.now(),
          preserveTranscript: true,
        });
        if (persistenceFails) {
          await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
          expect(subagentRuns.has(intermediate.runId)).toBe(true);
          expect(readLifecycleRun(ancestor).cleanupCompletedAt).toBeUndefined();
          failRetirement = false;
          const wake = controller.scheduledRequesterSettleWakeTimers.get(intermediate.runId)!;
          controller.resumeRequesterSettleWake(intermediate.runId, intermediate);
          await vi.advanceTimersByTimeAsync(wake.deadline - Date.now() - 1);
          expect(subagentRuns.has(intermediate.runId)).toBe(true);
          expect(readLifecycleRun(ancestor).cleanupCompletedAt).toBeUndefined();
          await vi.advanceTimersByTimeAsync(1);
        }
        await waitForLifecycleState(() =>
          expect(readLifecycleRun(intermediate).requesterSettleWake).toBeUndefined(),
        );
        expect(subagentRuns.has(intermediate.runId)).toBe(true);
        await completeRun(controller, descendant, {
          endedAt: Date.now(),
          triggerCleanup: true,
        });
        await waitForLifecycleState(() =>
          expect(readLifecycleRun(ancestor).cleanupCompletedAt).toBeTypeOf("number"),
        );
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
