import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { mutateRequesterSettleWakeBatch } from "../completion/subagent-completion-admission.store.js";
import type { RequesterWakeMutation } from "../completion/subagent-completion-mutation.types.js";
import type {
  PendingRequesterSettleWakeCommit,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import { getPendingWakeCommit } from "./subagent-registry-requester-wake-commit.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export const isCurrentRequesterSettleWakeBatch = (
  context: SubagentLifecycleWakeContext,
  batch: readonly SubagentRunRecord[],
  rearmGeneration?: number,
  visibleFinalDelivered = false,
): boolean => {
  // Closure can precede replacement activation. Only a recorded visible final
  // may settle then; cancellation or an in-flight handoff must retain the wake.
  try {
    return (
      batch.length > 0 &&
      (visibleFinalDelivered ||
        batch.every((entry) => {
          const resolve = getGatewayContextResolver(entry);
          return !resolve || Boolean(resolve());
        })) &&
      // Validate every row and generation after calling the captured owner fences.
      batch.every(
        (entry) =>
          context.options.runs.get(entry.runId) === entry &&
          entry.requesterSettleWake &&
          entry.requesterSettleWake.rearmGeneration === rearmGeneration,
      )
    );
  } catch {
    return false;
  }
};

export function assertRequesterWakeCommitCurrent(
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
    const resolve = getGatewayContextResolver(entry);
    if (!visibleFinalDelivered && resolve && !resolve()) {
      throw new Error("Requester wake Gateway owner is closed");
    }
  }
}

export async function commitRequesterSettleWakeMutation(
  context: SubagentLifecycleWakeContext,
  entries: readonly SubagentRunRecord[],
  operation: RequesterWakeMutation,
  stateContext: OpenClawStateWorkerContext,
  pending: PendingRequesterSettleWakeCommit,
): Promise<boolean> {
  if (
    !pending.committedWake &&
    !isCurrentRequesterSettleWakeBatch(context, entries, pending.generation)
  ) {
    return false;
  }
  const assertCurrent = () =>
    assertRequesterWakeCommitCurrent(context, entries, stateContext, pending);
  assertCurrent();
  const result = await mutateRequesterSettleWakeBatch({
    entries,
    operation,
    committed: pending.committedWake,
    context: stateContext,
    assertCurrent,
    onCommitted: (write) => {
      pending.committedWake = write;
    },
    onPublished: () => pending.adoptPublished(entries),
    retiredPreimages: new Set(entries.filter((entry) => pending.isPublishedRetirement(entry))),
  });
  return result.applied === true && result.publication === "published";
}
