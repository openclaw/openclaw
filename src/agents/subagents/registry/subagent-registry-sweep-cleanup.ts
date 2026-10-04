import type { callGateway } from "../../../gateway/call.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { normalizeDeleteCleanupTarget } from "./subagent-delivery-state.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { isRestoredQueuedFailureSettlementClaimed } from "./subagent-registry-restore.js";
import { isSuspendedPendingFinalDelivery } from "./subagent-registry-suspended-delivery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

export type FrozenSessionIdentity = { sessionId: string; lifecycleRevision: string };

function freezeSessionIdentity(childSessionKey: string): FrozenSessionIdentity | undefined {
  const sessionEntry = loadSubagentSessionEntry({ childSessionKey });
  const sessionId = sessionEntry?.sessionId?.trim();
  const lifecycleRevision = sessionEntry?.lifecycleRevision?.trim();
  return sessionId && lifecycleRevision ? { sessionId, lifecycleRevision } : undefined;
}

export function freezeCleanupSessionIdentity(
  entry: SubagentRunRecord,
): FrozenSessionIdentity | undefined {
  if (shouldSuppressSubagentRecoverySessionEffects(entry)) {
    return undefined;
  }
  return entry.cleanup === "delete" &&
    (entry.deleteCleanupDispatchedAt !== undefined || entry.deleteCleanupTarget)
    ? normalizeDeleteCleanupTarget(entry.deleteCleanupTarget)
    : freezeSessionIdentity(entry.childSessionKey);
}

export const shouldRunSweptSessionEffects = (
  entry: SubagentRunRecord,
  suppressSessionEffects = shouldSuppressSubagentRecoverySessionEffects(entry),
) =>
  !suppressSessionEffects &&
  !(entry.cleanup === "delete" && typeof entry.cleanupCompletedAt === "number");

export const sweptContext = (entry: SubagentRunRecord) => ({
  childSessionKey: entry.childSessionKey,
  reason: "swept" as const,
  agentDir: entry.agentDir,
  workspaceDir: entry.workspaceDir,
});

export const isSessionCleanupDeferred = (entry: SubagentRunRecord) =>
  entry.pauseReason === "sessions_yield" ||
  entry.delivery?.status === "in_progress" ||
  (entry.delivery?.status === "pending" &&
    (entry.expectsCompletionMessage === true ||
      entry.delivery.payload !== undefined ||
      entry.delivery.disposition === "session_queued"));

export const isCollectorArchiveReady = (entry: SubagentRunRecord, now: number): boolean =>
  entry.collectorCompletion !== undefined &&
  entry.collectorLaunchCleanupPending !== true &&
  entry.archiveAtMs !== undefined &&
  entry.archiveAtMs <= now;

export function isCleanupCurrent(
  current: SubagentRunRecord | undefined,
  expected: SubagentRunRecord,
): current is SubagentRunRecord {
  return (
    current !== undefined &&
    isSameSubagentRunOwner(current, expected) &&
    current.execution.status === expected.execution.status &&
    current.execution.endedAt === expected.execution.endedAt &&
    typeof current.execution.endedAt === "number" &&
    !current.killIntent &&
    !current.killReconciliation &&
    !current.requesterSettleWake &&
    !isRestoredQueuedFailureSettlementClaimed(current) &&
    !isSuspendedPendingFinalDelivery(current) &&
    !isSessionCleanupDeferred(current)
  );
}

export async function deleteSweptSession(
  entry: SubagentRunRecord,
  identity: FrozenSessionIdentity,
  runs: Map<string, SubagentRunRecord>,
  call: typeof callGateway,
): Promise<"deleted" | "changed"> {
  let failure: unknown;
  const outcome = await deleteSubagentSessionForCleanup({
    callGateway: call,
    gatewayBinding: { resolveGatewayContext: getGatewayContextResolver(entry) },
    isCurrent: () => isCleanupCurrent(runs.get(entry.runId), entry),
    childSessionKey: entry.childSessionKey,
    expectedSessionId: identity.sessionId,
    expectedLifecycleRevision: identity.lifecycleRevision,
    onError: (error) => {
      failure = error;
    },
  });
  if (outcome === "failed") {
    throw failure;
  }
  return outcome;
}

export function mutateCleanup(
  runs: Map<string, SubagentRunRecord>,
  entry: SubagentRunRecord,
  ready: (current: SubagentRunRecord) => boolean,
  update: (draft: SubagentRunRecord) => SubagentRunRecord | null,
) {
  return mutateSubagentRuns(
    [entry.runId],
    (rows) => {
      const current = rows.get(entry.runId);
      if (!isCleanupCurrent(current, entry) || !ready(current)) {
        return { value: undefined };
      }
      const next = update(structuredClone(current));
      return { value: next, postimages: new Map([[entry.runId, next]]) };
    },
    { runs },
  );
}
