import { getActiveAgentRunDelegatedAuthority } from "../../../infra/agent-run-registry.js";
import { getSessionControllerEntryForOperation } from "../../../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../../../sessions/session-controller.queries.js";
import { getReplyOperationSessionReader } from "../../../sessions/session-controller.session-reader.js";
import { mergeAcceptedSessionSpawnsForRun } from "../../accepted-session-spawn.js";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

/** Persisted cohort identity is not liveness; only its current physical requester can hold it. */
export function isClaimedByLiveRequesterTurn(entry: SubagentRunRecord): boolean {
  if (entry.expectsCompletionMessage !== true || !entry.requesterTurnRunId) {
    return false;
  }
  const operation = findSessionControllerOperationByRunId(entry.requesterTurnRunId);
  if (!operation) {
    return false;
  }
  const target = getSessionControllerEntryForOperation(operation).target;
  return (
    target !== undefined &&
    (!entry.requesterStorePath ||
      entry.requesterStorePath ===
        (getReplyOperationSessionReader(operation)?.database.path ??
          target.physicalStorePath ??
          target.storeScope)) &&
    matchesSubagentChildSessionOwner(
      { childSessionKey: entry.requesterSessionKey, childAgentId: entry.requesterAgentId },
      operation.key,
      operation.agentId ?? target.agentId,
    )
  );
}

/** A delivered row may still be the live producer's only complete-batch witness. */
export function hasRequiredRequesterReceipt(
  entry: SubagentRunRecord,
  runs: ReadonlyMap<string, SubagentRunRecord>,
): boolean {
  const instance = subagentRuns.getRequesterRunInstance(entry);
  return Boolean(
    instance &&
    isSameSubagentRunOwner(runs.get(entry.runId), entry) &&
    entry.delivery?.status === "delivered" &&
    entry.requesterTurnRunId === instance.runId &&
    getActiveAgentRunDelegatedAuthority(instance)?.operationalRunInstance === instance &&
    mergeAcceptedSessionSpawnsForRun(instance).some(
      (receipt) =>
        receipt.runId === (entry.taskRunId ?? entry.runId) &&
        receipt.childSessionKey === entry.childSessionKey &&
        receipt.expectsCompletionMessage === true,
    ),
  );
}
