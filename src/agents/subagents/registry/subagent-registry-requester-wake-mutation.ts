import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import {
  mutateRequesterSettleWakeBatch,
  settleRequesterCompletionBatch,
} from "../completion/subagent-completion-admission.store.js";
import type { RequesterWakeMutation } from "../completion/subagent-completion-mutation.types.js";
import type {
  PendingRequesterSettleWakeCommit,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import { getPendingWakeCommit } from "./subagent-registry-requester-wake-commit.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";

export const isCurrentRequesterSettleWakeBatch = (
  context: SubagentLifecycleWakeContext,
  batch: readonly SubagentRunRecord[],
  rearmGeneration?: number,
  visibleFinalDelivered = false,
): boolean => {
  // Closure can precede replacement activation. Only a recorded visible final
  // may settle then; cancellation or an in-flight handoff must retain the wake.
  try {
    const ownsRows = () =>
      batch.every((entry) => {
        const current = context.options.runs.get(entry.runId);
        return (
          !context.cancelledRequesterSettleWakeRuns.has(getSubagentRunRuntimeKey(entry)) &&
          isSameSubagentRunOwner(current, entry) &&
          current?.requesterSettleWake !== undefined &&
          current.requesterSettleWake.rearmGeneration === rearmGeneration &&
          (current.requesterSettleWake.yieldedFinalDeliverable === true) ===
            (entry.requesterSettleWake?.yieldedFinalDeliverable === true)
        );
      });
    return (
      batch.length > 0 &&
      ownsRows() &&
      (visibleFinalDelivered ||
        batch.every((entry) => {
          const resolve = getGatewayContextResolver(entry);
          return !resolve || Boolean(resolve());
        })) &&
      ownsRows()
    );
  } catch {
    return false;
  }
};

function assertRequesterWakeCommitCurrent(
  context: SubagentLifecycleWakeContext,
  entries: readonly SubagentRunRecord[],
  stateContext: OpenClawStateWorkerContext,
  pending: PendingRequesterSettleWakeCommit,
  visibleFinalDelivered = false,
): void {
  assertSubagentRegistryWriteSourceCurrent(stateContext);
  if (!entries.every((entry) => getPendingWakeCommit(context, entry) === pending)) {
    throw new Error("Requester wake lost its current commit episode");
  }
  for (const entry of entries) {
    if (context.cancelledRequesterSettleWakeRuns.has(getSubagentRunRuntimeKey(entry))) {
      throw new Error("Requester wake was cancelled before commit");
    }
    const resolve = getGatewayContextResolver(entry);
    if (!visibleFinalDelivered && resolve && !resolve()) {
      throw new Error("Requester wake Gateway owner is closed");
    }
  }
}

export async function commitRequesterSettleWakeMutation(
  context: SubagentLifecycleWakeContext,
  entries: readonly SubagentRunRecord[],
  operation: RequesterWakeMutation | { kind: "settle"; outcome: SubagentAnnounceDeliveryResult },
  stateContext: OpenClawStateWorkerContext,
  pending: PendingRequesterSettleWakeCommit,
  onPublished?: (entries: readonly SubagentRunRecord[]) => void,
): Promise<boolean> {
  const visibleFinalDelivered =
    operation.kind === "settle" &&
    operation.outcome.delivered &&
    operation.outcome.requesterVisibleFinalDelivered === true;
  if (
    !pending.committedWake &&
    !isCurrentRequesterSettleWakeBatch(context, entries, pending.generation, visibleFinalDelivered)
  ) {
    return false;
  }
  const assertCurrent = () =>
    assertRequesterWakeCommitCurrent(
      context,
      entries,
      stateContext,
      pending,
      visibleFinalDelivered,
    );
  assertCurrent();
  const options = {
    committed: pending.committedWake,
    context: stateContext,
    assertCurrent,
    onCommitted: (write: NonNullable<PendingRequesterSettleWakeCommit["committedWake"]>) => {
      pending.committedWake = write;
    },
    onPublished: () => {
      const published = pending.adoptPublished(entries);
      onPublished?.(published);
    },
  };
  const result = await (operation.kind === "settle"
    ? settleRequesterCompletionBatch({
        ...options,
        entries: entries.map((subagent) => ({ subagent })),
        outcome: operation.outcome,
        isCurrent: () => {
          assertCurrent();
          return true;
        },
      })
    : mutateRequesterSettleWakeBatch({ ...options, entries, operation }));
  return result.applied === true && result.publication === "published";
}
