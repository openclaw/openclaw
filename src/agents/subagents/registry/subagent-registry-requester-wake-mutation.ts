import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { mutateRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import type {
  RequesterWakeCommittedWrite,
  RequesterWakeMutation,
} from "../completion/subagent-completion-mutation.types.js";
import type { SubagentLifecycleWakeContext } from "./subagent-registry-lifecycle-context.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

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
