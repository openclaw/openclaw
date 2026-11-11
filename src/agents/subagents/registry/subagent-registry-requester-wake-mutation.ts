import { persistGatewaySessionLifecycleEvent } from "../../../gateway/session-lifecycle-state.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { recordGatewaySessionRunFailure } from "../../../sessions/session-run-error.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { buildAnnounceIdempotencyKey } from "../../announce-idempotency.js";
import { renderRuntimeCoordinationFailureCopy } from "../../failover/assistant-request-failure-copy.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { mutateRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import type {
  RequesterWakeCommittedWrite,
  RequesterWakeMutation,
} from "../completion/subagent-completion-mutation.types.js";
import { captureSubagentControllerInputRetirement } from "./subagent-controller-inputs.js";
import type { SubagentLifecycleWakeContext } from "./subagent-registry-lifecycle-context.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import type { RequesterSettleWakeState, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  buildRequesterSettleWakeIdentity,
  sameRequesterSettleRunIdentity,
} from "./subagent-requester-settle-identity.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";

export type RequesterWakeMutationReceipt = { committed?: RequesterWakeCommittedWrite };

/** A retired peer releases only its own obligation; acknowledged retirements remain reconcilable. */
export function isRetainedRequesterSettleWakeMember(
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
  rearmGeneration: number | undefined,
  receipt: RequesterWakeMutationReceipt,
): boolean {
  const current = context.options.runs.get(entry.runId);
  if (!current) {
    return receipt.committed?.result.retiredRunIds.includes(entry.runId) === true;
  }
  return (
    isSameSubagentRunOwner(current, entry) &&
    sameRequesterSettleRunIdentity(current, entry) &&
    ((current.requesterSettleWake !== undefined &&
      current.requesterSettleWake.rearmGeneration === rearmGeneration) ||
      (receipt.committed !== undefined && current.requesterSettleWake === undefined))
  );
}

/** A recorded visible final can finish bookkeeping after its Gateway owner closes. */
export function assertRequesterSettleWakeBatchCurrent(
  context: SubagentLifecycleWakeContext,
  batch: readonly SubagentRunRecord[],
  rearmGeneration: number | undefined,
  visibleFinalDelivered: boolean,
): void {
  for (const entry of batch) {
    const current = context.options.runs.get(entry.runId);
    if (
      !isSameSubagentRunOwner(current, entry) ||
      !current?.requesterSettleWake ||
      current.requesterSettleWake.rearmGeneration !== rearmGeneration ||
      (current.requesterSettleWake.yieldedFinalDeliverable === true) !==
        (entry.requesterSettleWake?.yieldedFinalDeliverable === true)
    ) {
      throw new Error("Requester wake batch changed before its outcome was recorded");
    }
    const resolve = getGatewayContextResolver(entry);
    if (!visibleFinalDelivered && resolve && !resolve()) {
      throw new Error("Requester wake Gateway owner is closed");
    }
  }
}

/** Storage records dispatch and terminal facts; the controller owns when work runs. */
export async function mutateRequesterSettleWakeBatch(
  context: SubagentLifecycleWakeContext,
  batch: readonly SubagentRunRecord[],
  rearmGeneration: number | undefined,
  operation: RequesterWakeMutation | { kind: "settle"; outcome: SubagentAnnounceDeliveryResult },
  stateContext: OpenClawStateWorkerContext,
  receipt: RequesterWakeMutationReceipt,
  onPublished?: (entries: readonly SubagentRunRecord[]) => void,
): Promise<boolean> {
  const visibleFinalDelivered =
    operation.kind === "settle" &&
    operation.outcome.delivered &&
    operation.outcome.requesterVisibleFinalDelivered === true;
  const assertCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    // An acknowledged write must reconcile its own postimages rather than replaying it.
    if (!receipt.committed) {
      assertRequesterSettleWakeBatchCurrent(context, batch, rearmGeneration, visibleFinalDelivered);
    }
  };
  try {
    assertCurrent();
  } catch {
    return false;
  }
  const result = await mutateRequesterCompletionBatch({
    entries: batch,
    operation,
    context: stateContext,
    assertCurrent,
    committed: receipt.committed,
    onCommitted: (write) => {
      receipt.committed = write;
    },
    onPublished: () => {
      onPublished?.(batch.map((entry) => context.options.runs.get(entry.runId) ?? entry));
    },
  });
  return result.applied === true && result.publication === "published";
}

/** Records one observed outcome, or retires a wake that owes no delivery. */
export function settleRequesterSettleWakeBatch(
  context: SubagentLifecycleWakeContext,
  batch: readonly SubagentRunRecord[],
  rearmGeneration: number | undefined,
  outcome: SubagentAnnounceDeliveryResult | undefined,
  stateContext: OpenClawStateWorkerContext,
  receipt: RequesterWakeMutationReceipt = {},
): Promise<boolean> {
  return mutateRequesterSettleWakeBatch(
    context,
    batch,
    rearmGeneration,
    outcome ? { kind: "settle", outcome } : { kind: "complete" },
    stateContext,
    receipt,
  );
}

// Observed outcomes belong to the run owner, not the transient evaluation. Weak keys release
// retired owners; the scope keeps a later yield generation from consuming an older receipt.
export const pendingRequesterSettlements = new WeakMap<
  object,
  {
    scope: string;
    rearmGeneration: number | undefined;
    receipt: RequesterWakeMutationReceipt;
    stateContext: OpenClawStateWorkerContext;
    settle: () => Promise<void>;
  }
>();
export function hasPendingRequesterSettlement(
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
): boolean {
  const pending = pendingRequesterSettlements.get(getSubagentRunRuntimeKey(entry));
  if (!pending) {
    return false;
  }
  try {
    assertSubagentRegistryWriteSourceCurrent(pending.stateContext);
  } catch {
    return false;
  }
  return isRetainedRequesterSettleWakeMember(
    context,
    entry,
    pending.rearmGeneration,
    pending.receipt,
  );
}

/** Retain the observed outcome until its commit and requester lifecycle effect settle. */
export function createRequesterWakeSettlement(params: {
  context: SubagentLifecycleWakeContext;
  scope: string;
  batch: readonly SubagentRunRecord[];
  rearmGeneration: number | undefined;
  outcome: SubagentAnnounceDeliveryResult | undefined;
  onCommitted?: () => void | Promise<void>;
  stateContext: OpenClawStateWorkerContext;
  admittedWake: RequesterSettleWakeState | undefined;
  release: (members: readonly SubagentRunRecord[]) => void;
}): () => Promise<void> {
  const {
    context,
    scope,
    batch,
    rearmGeneration,
    outcome,
    onCommitted,
    stateContext,
    admittedWake,
    release,
  } = params;
  // Retry bookkeeping with the observed outcome, never by replaying delivery or inventing failure.
  const receipt: RequesterWakeMutationReceipt = {};
  const retireInputs = batch.map(captureSubagentControllerInputRetirement);
  const settlement = {
    scope,
    rearmGeneration,
    receipt,
    stateContext,
    settle: async (): Promise<void> => {
      const members = batch.filter(
        (member) =>
          pendingRequesterSettlements.get(getSubagentRunRuntimeKey(member)) === settlement &&
          isRetainedRequesterSettleWakeMember(context, member, rearmGeneration, receipt),
      );
      // A quiet decision needs its whole cohort; a recorded outcome stays with surviving peers.
      const settlesMembers =
        members.length > 0 &&
        (outcome !== undefined ||
          receipt.committed !== undefined ||
          members.length === batch.length);
      if (
        settlesMembers &&
        !(await settleRequesterSettleWakeBatch(
          context,
          members,
          rearmGeneration,
          outcome,
          stateContext,
          receipt,
        ))
      ) {
        return;
      }
      if (settlesMembers) {
        const requester = batch[0];
        if (
          !admittedWake?.pauseNotice &&
          admittedWake?.requesterYieldBatch &&
          requester?.completionRequesterSessionId &&
          outcome?.delivered !== true
        ) {
          const error =
            outcome?.error ?? "Child completion could not continue the yielded request.";
          const notice = renderRuntimeCoordinationFailureCopy("child_completion_delivery_failed");
          const runId = admittedWake.requesterRunId;
          if (runId) {
            // A newer turn, reset, or Stop cannot inherit the failed batch's terminal.
            await persistGatewaySessionLifecycleEvent({
              sessionKey: requester.requesterSessionKey,
              agentId: requester.requesterAgentId,
              expectedWriter: {
                runId,
                sessionId: requester.completionRequesterSessionId,
                lifecycleRevision: requester.completionRequesterLifecycleRevision,
                requireYielded: true,
              },
              event: {
                runId,
                sessionId: requester.completionRequesterSessionId,
                ts: Date.now(),
                data: { phase: "error", error, errorNotice: notice },
              },
            });
          } else {
            // Stable batches lost their original run id. Report the batch failure,
            // never assign whichever writer now occupies this session to that batch.
            const { batchKey } = buildRequesterSettleWakeIdentity({
              requesterSessionKey: requester.requesterSessionKey,
              requesterAgentId: requester.requesterAgentId,
              batchRunIds: admittedWake.batchRunIds ?? batch.map((entry) => entry.runId),
              rearmGeneration,
            });
            await recordGatewaySessionRunFailure({
              target: {
                sessionKey: requester.requesterSessionKey,
                agentId: requester.requesterAgentId,
                storePath: requester.requesterStorePath,
                sessionId: requester.completionRequesterSessionId,
                expectedLifecycleRevision: requester.completionRequesterLifecycleRevision,
              },
              runId: buildAnnounceIdempotencyKey(`${batchKey}:delivery-failure`),
              error,
              notice,
              assertCommitAllowed: () => assertSubagentRegistryWriteSourceCurrent(stateContext),
            });
          }
        }
        for (const retire of retireInputs) {
          retire();
        }
        await onCommitted?.();
      }
      for (const member of batch) {
        const key = getSubagentRunRuntimeKey(member);
        if (pendingRequesterSettlements.get(key) === settlement) {
          pendingRequesterSettlements.delete(key);
        }
      }
      if (settlesMembers) {
        release(members);
      }
    },
  };
  for (const member of batch) {
    pendingRequesterSettlements.set(getSubagentRunRuntimeKey(member), settlement);
  }
  return settlement.settle;
}
