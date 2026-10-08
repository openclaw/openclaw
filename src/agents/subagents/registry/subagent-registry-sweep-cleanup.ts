import type { callGateway } from "../../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { blocksSwarmGroupArchival } from "./subagent-registry-cleanup.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
} from "./subagent-registry-persistence.js";
import { isRestoredQueuedFailureSettlementClaimed } from "./subagent-registry-restore.js";
import { isSuspendedPendingFinalDelivery } from "./subagent-registry-suspended-delivery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

export function createSubagentSweepReadScope(
  runs: Map<string, SubagentRunRecord>,
  getGatewayRuntime: () => GatewayRecoveryRuntime | undefined,
) {
  let source:
    | { context: ReturnType<typeof captureOpenClawStateWorkerContext> }
    | { error: unknown };
  try {
    source = { context: captureOpenClawStateWorkerContext() };
  } catch (error) {
    source = { error };
  }
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const gatewayRuntime = getGatewayRuntime();
  const retiredRead = new Error("Subagent sweep read lost its selected run");
  let readsStarted = false;
  const assertCurrent = () => {
    // Memory-only sweeps need no read admission; a later read still uses this original source.
    if (readsStarted) {
      if ("error" in source) {
        throw source.error;
      }
      assertSubagentRegistryWriteSourceCurrent(source.context);
    }
    if (
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
      getGatewayRuntime() !== gatewayRuntime
    ) {
      throw new Error("Subagent sweep read lost its Gateway owner");
    }
  };
  const isHostCurrent = () => {
    try {
      assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  return {
    assertCurrent,
    retiredRead,
    completionCurrent: { isHostCurrent, prepare: async () => isHostCurrent() },
    assertRunCurrent: (entry: SubagentRunRecord) => {
      assertCurrent();
      if (runs.get(entry.runId) !== entry) {
        throw retiredRead;
      }
      readsStarted = true;
      assertCurrent();
    },
  };
}

export type FrozenSessionIdentity = { sessionId: string; lifecycleRevision: string };

export async function freezeSessionIdentity(
  entry: Pick<SubagentRunRecord, "childSessionKey" | "childAgentId">,
  assertCurrent: () => void,
): Promise<FrozenSessionIdentity | undefined> {
  const sessionEntry = await loadSubagentSessionEntry({ ...entry, assertCurrent });
  const sessionId = sessionEntry?.sessionId?.trim();
  const lifecycleRevision = sessionEntry?.lifecycleRevision?.trim();
  return sessionId && lifecycleRevision ? { sessionId, lifecycleRevision } : undefined;
}

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
  !blocksSwarmGroupArchival(entry, now);

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
    childAgentId: entry.childAgentId,
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
  update: (draft: SubagentRunRecord) => void | null,
) {
  return mutateSubagentRuns(
    [entry.runId],
    (rows) => {
      const current = rows.get(entry.runId);
      if (!isCleanupCurrent(current, entry) || !ready(current)) {
        return { value: undefined };
      }
      const draft = structuredClone(current);
      const next = update(draft) === null ? null : draft;
      return { value: next, postimages: new Map([[entry.runId, next]]) };
    },
    { runs },
  );
}
