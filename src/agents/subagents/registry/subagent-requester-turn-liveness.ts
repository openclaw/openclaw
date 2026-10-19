import { getSessionControllerEntryForOperation } from "../../../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../../../sessions/session-controller.queries.js";
import { getReplyOperationSessionReader } from "../../../sessions/session-controller.session-reader.js";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

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
