/**
 * Whether a restored run may resume normally, or whether a different owner
 * already holds its settlement. Kept beside the restorer as one predicate so
 * the two "someone else owns this" conditions read together.
 */
import type { InternalSessionEntry } from "../../../config/sessions.js";
import { isRetiredSubagentSessionOwner } from "./subagent-registry-restart-recovery-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  classifySubagentRunOrphanFromSessionEntry,
  resolveSubagentRunOrphanReason,
} from "./subagent-session-reconciliation.js";

export function isRestoredSubagentRunHeldByAnotherOwner(
  entry: SubagentRunRecord,
  sessionEntry: InternalSessionEntry | undefined,
): boolean {
  // Orphan recovery owns aborted sessions and exact still-running retired
  // executions. Completed sessions must resume normal settlement and delivery.
  if (sessionEntry?.abortedLastRun === true || isRetiredSubagentSessionOwner(entry, sessionEntry)) {
    return true;
  }
  if (entry.execution.status === "queued" || entry.execution.endedAt !== undefined) {
    return false;
  }
  // The sweeper owns active restored orphans so it can attribute a gateway
  // death and publish a requester-visible terminal outcome.
  const classification = resolveSubagentRunOrphanReason({ entry, includeStaleUnended: true });
  if (classification === null) {
    return false;
  }
  if (typeof classification === "string") {
    return true;
  }
  // The deferred form defers only the child session read, which the restorer
  // has already performed for this exact owner. Finish the classification
  // against that entry: treating the pending reader as an orphan verdict would
  // hand the sweeper every active restored run, including children whose
  // sessions already finished, and leave their requesters unsettled until a
  // later sweep.
  return (
    classifySubagentRunOrphanFromSessionEntry({
      entry,
      sessionEntry,
      includeStaleUnended: true,
    }) !== null
  );
}
