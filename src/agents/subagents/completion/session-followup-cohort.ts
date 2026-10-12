import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  getSubagentRunRuntimeKey,
  isSameSubagentRun,
  isSameSubagentRunOwner,
} from "../registry/subagent-run-generation.js";
import type { FollowupCompletionOwner } from "./session-followup-completion.types.js";

// Weak projection only: the logical followup owner retains custody and makes every decision.
const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.sessions.followupCohorts"),
  () => new WeakMap<object, FollowupCompletionOwner>(),
);
export function getFollowupCohortOwner(entry: SubagentRunRecord) {
  return owners.get(getSubagentRunRuntimeKey(entry));
}
export function bindFollowupCohortOwner(entry: SubagentRunRecord, owner: FollowupCompletionOwner) {
  owners.set(getSubagentRunRuntimeKey(entry), owner);
}
export function transferFollowupCohort(previous: SubagentRunRecord, next: SubagentRunRecord): void {
  if (isSameSubagentRun(previous, next) && !isSameSubagentRunOwner(previous, next)) {
    return;
  }
  const owner = owners.get(getSubagentRunRuntimeKey(previous));
  if (!owner) {
    return;
  }
  // Keep the restriction even when a replacement cannot inherit the old obligation.
  owners.set(getSubagentRunRuntimeKey(next), owner);
  owner.replaceCohortEntry(previous, next);
}
