/**
 * Whether a restored run may resume normally, or whether a different owner
 * already holds its settlement. Kept beside the restorer as one predicate so
 * the two "someone else owns this" conditions read together.
 */
import type { InternalSessionEntry } from "../../../config/sessions.js";
import { isRetiredSubagentSessionOwner } from "./subagent-registry-restart-recovery-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentRunOrphanReason } from "./subagent-session-reconciliation.js";

export function isRestoredSubagentRunHeldByAnotherOwner(
  entry: SubagentRunRecord,
  sessionEntry: InternalSessionEntry | undefined,
): boolean {
  // Orphan recovery owns aborted sessions and exact still-running retired
  // executions. Completed sessions must resume normal settlement and delivery.
  if (sessionEntry?.abortedLastRun === true || isRetiredSubagentSessionOwner(entry, sessionEntry)) {
    return true;
  }
  // The sweeper owns active restored orphans so it can attribute a gateway
  // death and publish a requester-visible terminal outcome.
  return (
    entry.execution.status !== "queued" &&
    entry.execution.endedAt === undefined &&
    Boolean(resolveSubagentRunOrphanReason({ entry, includeStaleUnended: true }))
  );
}
