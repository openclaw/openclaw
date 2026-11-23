import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { maybeWakeRequesterAfterAllChildrenSettled as runRequesterSettleWake } from "../announce/subagent-announce.requester-settle-wake.js";
import type {
  settleSubagentCompletionInHistory,
  mutateRequesterCompletionBatch,
} from "../completion/subagent-completion-admission.store.js";
import type { SubagentCompletionMutationResult } from "../completion/subagent-completion-mutation.types.js";
import {
  clearSubagentPendingDelivery,
  completeRequesterSettleWakeState,
  transitionRequesterSettleWakeState,
  recordRequesterDelivery,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import {
  createSubagentTestGate,
  readLifecycleRun,
  mutateLifecycleRun,
  expectUndefinedFields,
  type CompleteLifecycleRun,
  type LifecycleTestDrivers,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { SubagentRegistryWriteError, mutateSubagentRuns } from "./subagent-registry-persistence.js";
import {
  countPendingDescendantRuns,
  getLatestLiveSubagentRunByChildSessionKey,
} from "./subagent-registry-read.js";
import { bindSubagentRunRecord, rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { holdLiveRequesterTurns } from "./subagent-requester-turn-liveness.test-support.js";
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
      entry
        ? [
            {
              subagent: rowToSubagentRunRecord(bindSubagentRunRecord(entry))!,
              cleanupHandled: entry.cleanupHandled,
            },
          ]
        : [],
    ),
    retiredRunIds: [...postimages].flatMap(([id, entry]) => (entry ? [] : [id])),
  };
}

function historySettledPolicyDraft(entry: SubagentRunRecord) {
  const deliveredAt = Date.now();
  entry.delivery = {
    ...entry.delivery,
    status: "delivered",
    disposition: "delivered",
    deliveredAt,
    announcedAt: deliveredAt,
    lastDropReason: undefined,
    queueId: undefined,
  };
  clearSubagentPendingDelivery(entry);
  entry.wakeOnDescendantSettle = undefined;
}

function createRequesterSettleWakeMutationFixture(
  owners: CompletionPolicyOwners,
): typeof mutateRequesterCompletionBatch {
  return async (params) => {
    const operation = params.operation;
    if (operation.kind === "settle") {
      throw new Error("Outcome settlement requires its settlement fixture");
    }
    if (params.committed) {
      throw new Error("Native receipt reconciliation requires the registered worker fixture");
    }
    return mutatePolicyBatch(owners, params, (next) => {
      if (operation.kind === "transition") {
        transitionRequesterSettleWakeState(next, operation.state);
        if (operation.requesterDelivery) {
          recordRequesterDelivery(next, operation.requesterDelivery);
        }
        return next;
      }
      return completeRequesterSettleWakeState(next) ? null : next;
    });
  };
}

async function mutatePolicyBatch(
  owners: CompletionPolicyOwners,
  params: Parameters<typeof mutateRequesterCompletionBatch>[0],
  mutate: (next: SubagentRunRecord, current: SubagentRunRecord) => SubagentRunRecord | null,
): ReturnType<typeof mutateRequesterCompletionBatch> {
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
        postimages.set(current.runId, mutate(structuredClone(current), current));
      }
      return { value: { entries: original, result: policyReceipt(postimages) }, postimages };
    },
    {
      runs: owner.runs,
      context: params.context,
      assertCurrent: params.assertCurrent,
      onPublished(_postimages, receipt) {
        params.onCommitted?.(receipt);
        params.onPublished?.();
      },
    },
  );
  return { applied: true, publication: "published" };
}

export async function mockRegistryRequesterWakeMutation() {
  const store = await import("../completion/subagent-completion-admission.store.js");
  const original = store.mutateRequesterCompletionBatch;
  const owners: CompletionPolicyOwners = new Map();
  const mutate = createRequesterSettleWakeMutationFixture(owners);
  const spy = vi
    .spyOn(store, "mutateRequesterCompletionBatch")
    .mockImplementation((params) =>
      params.operation.kind !== "settle" &&
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

export function mockHistoryCompletionSettlementOwner(completionDeliveryMocks: {
  settleSubagentCompletionInHistory: Mock<typeof settleSubagentCompletionInHistory>;
  mutateRequesterCompletionBatch: Mock<typeof mutateRequesterCompletionBatch>;
  ownersByEntry: CompletionPolicyOwners;
}): void {
  // Policy fixtures use the real row owner; native worker suites own committed receipts.
  const mutateWake = createRequesterSettleWakeMutationFixture(
    completionDeliveryMocks.ownersByEntry,
  );
  completionDeliveryMocks.mutateRequesterCompletionBatch.mockImplementation(async (params) => {
    if (params.operation.kind !== "settle") {
      return mutateWake(params);
    }
    const { outcome } = params.operation;
    return mutatePolicyBatch(completionDeliveryMocks.ownersByEntry, params, (next) => {
      if (
        next.pauseReason !== "sessions_yield" &&
        next.expectsCompletionMessage &&
        ["pending", "in_progress", "failed", "suspended"].includes(
          next.delivery?.status ?? "pending",
        )
      ) {
        // A missed wake already appended the children's status to requester history.
        historySettledPolicyDraft(next);
        if (outcome.delivered && outcome.deliveredAt !== undefined) {
          next.delivery!.deliveredAt = outcome.deliveredAt;
          next.delivery!.announcedAt = outcome.deliveredAt;
        }
      }
      return completeRequesterSettleWakeState(next) ? null : next;
    });
  });
  completionDeliveryMocks.settleSubagentCompletionInHistory.mockImplementation(async (params) => {
    const owner = policyOwner(completionDeliveryMocks.ownersByEntry, [params.subagent]);
    return mutateSubagentRuns(
      [params.subagent.runId],
      (rows) => {
        const current = rows.get(params.subagent.runId);
        if (
          !current ||
          !isSameSubagentRunOwner(current, params.subagent) ||
          current.delivery?.status === "delivered"
        ) {
          return { value: false };
        }
        const next = structuredClone(current);
        historySettledPolicyDraft(next);
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
}: LifecycleTestDrivers & {
  completionDeliveryMocks: {
    settleSubagentCompletionInHistory: Mock<typeof settleSubagentCompletionInHistory>;
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
      const requesterTurn = holdLiveRequesterTurns("run-requester");
      const requester = {
        requesterSessionKey: entry.requesterSessionKey,
        requesterTurnRunId: "run-requester",
      };
      try {
        expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(false);
        expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
        expect(readLifecycleRun(entry).cleanupHandled).not.toBe(true);
        expect(readLifecycleRun(entry).completion?.resultText).toBe("private child result");
        if (requesterYielded) {
          await controller.markRequesterTurnYielded(requester);
        }
        requesterTurn.end("run-requester");
        expect(
          await controller.settleRequesterTurnAfterSessionSpawns({
            ...requester,
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
        const settled = readLifecycleRun(entry);
        expectUndefinedFields(settled, ["requesterTurnRunId"]);
        expect(settled.delivery?.status).toBe(requesterYielded ? "pending" : "delivered");
        expectUndefinedFields(settled.delivery, ["lastError", "lastDropReason"]);
        expect(settled.requesterSettleWake?.requesterYieldBatch).toBe(
          requesterYielded ? true : undefined,
        );
        expect(readLifecycleRun(sibling).execution.endedAt).toBeUndefined();
        expect(completionDeliveryMocks.settleSubagentCompletionInHistory).not.toHaveBeenCalled();
      } finally {
        requesterTurn.restore();
        controller.clearRuntimeState();
      }
    },
  );
}

export function makeSubagentCompletion(
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionRequest>, "runId"> = {},
): SubagentCompletionRequest {
  return {
    runId: entry.runId,
    endedAt: 4_000,
    outcome: { status: "ok" },
    reason: SUBAGENT_ENDED_REASON_COMPLETE,
    triggerCleanup: false,
    terminalReply: { disposition: "visible", text: "final completion reply" },
    ...overrides,
  };
}

export function makeKilledSubagentCompletion(
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionRequest>, "runId"> = {},
): SubagentCompletionRequest {
  return makeSubagentCompletion(entry, {
    outcome: { status: "error", error: "agent run aborted" },
    reason: SUBAGENT_ENDED_REASON_KILLED,
    terminalReply: undefined,
    ...overrides,
  });
}

export function registerNativeCompletionAuthorityTest({
  createRunEntry,
  createLifecycleController,
  completeRun,
  helperMocks,
}: Omit<LifecycleTestDrivers, "waitForLifecycleState"> & {
  completeRun: CompleteLifecycleRun;
  helperMocks: { persistSubagentSessionTiming: Mock<() => Promise<void>> };
}) {
  it("keeps provisional cancellation when a repeated success has no producer reply evidence", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
      endedAt: 4_000,
      outcome: { status: "error", error: "killed" },
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000, suppressTaskDelivery: true },
      completion: { required: true, resultText: null, capturedAt: 4_000 },
    });
    const original = structuredClone(entry);
    const controller = createLifecycleController({ entry });
    await completeRun(controller, entry, {
      endedAt: 4_001,
      terminalReply: undefined,
      triggerCleanup: false,
    });
    expect(readLifecycleRun(entry)).toEqual(original);
    expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
  });
  it.each(["replacement", "host authority"] as const)(
    "does not commit a captured result after %s retires its owner",
    async (transition) => {
      const entry = createRunEntry({ expectsCompletionMessage: false });
      const runs = new Map([[entry.runId, entry]]);
      await using gate = createSubagentTestGate();
      const beforeWrite = vi.fn();
      let hostCurrent = true;
      const controller = createLifecycleController({
        entry,
        runs,
        beforeWrite,
        captureSubagentCompletionReply: async () => {
          await gate.wait();
          return "old result";
        },
      });
      const pending = completeRun(controller, entry, {
        terminalReply: undefined,
        triggerCleanup: false,
        recoveryCurrent: {
          prepare: async () => true,
          isHostCurrent: () => hostCurrent,
        },
      });
      const settled = gate.track(Promise.allSettled([pending]));
      await gate.entered;
      if (transition === "host authority") {
        hostCurrent = false;
      } else {
        await mutateLifecycleRun(entry, (draft) => {
          draft.generation = (draft.generation ?? 0) + 1;
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
      gate.release();
      const [result] = await settled;
      expect(result).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ message: "Subagent terminal execution changed" }),
      });
      expect(runs.get(entry.runId)).toBe(successor);
      expect(beforeWrite).not.toHaveBeenCalled();
      expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
    },
  );
}

export function registerRequesterSettleRetirementTests({
  createRunEntry,
  createLifecycleController,
  waitForLifecycleState,
  completeRun,
}: LifecycleTestDrivers & {
  completeRun: CompleteLifecycleRun;
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
        beforeWrite: ({ postimages }) => {
          if (failRetirement && postimages.get(intermediate.runId) === null) {
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
          // Nothing retries a failed retirement; the next settlement event re-arms it.
          failRetirement = false;
          const retained = subagentRuns.get(intermediate.runId)!;
          controller.resumeRequesterSettleWake(retained.runId, retained);
        }
        await waitForLifecycleState(() => expect(subagentRuns.has(intermediate.runId)).toBe(false));
        await completeRun(controller, descendant, {
          endedAt: Date.now(),
          triggerCleanup: true,
        });
        await waitForLifecycleState(() =>
          expect(readLifecycleRun(ancestor).cleanupCompletedAt).toBeTypeOf("number"),
        );
      } finally {
        controller.clearRuntimeState();
        for (const entry of [ancestor, intermediate, descendant]) {
          subagentRuns.delete(entry.runId);
        }
        vi.useRealTimers();
      }
    },
  );
}
