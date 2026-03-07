import * as subagentRegistry from "./subagent-registry.js";

export const countActiveDescendantRuns = subagentRegistry.countActiveDescendantRuns;
export const countPendingDescendantRuns = subagentRegistry.countPendingDescendantRuns;
export const countPendingDescendantRunsExcludingRun =
  subagentRegistry.countPendingDescendantRunsExcludingRun;
export const isSubagentSessionRunActive = subagentRegistry.isSubagentSessionRunActive;
export const listSubagentRunsForRequester = subagentRegistry.listSubagentRunsForRequester;
export const replaceSubagentRunAfterSteer = subagentRegistry.replaceSubagentRunAfterSteer;
export const resolveRequesterForChildSession = subagentRegistry.resolveRequesterForChildSession;

// Compatibility shim for branches that adopt the newer announce flow before the
// corresponding registry helper lands. Absent richer suppression state, do not
// suppress descendant completion delivery.
export function shouldIgnorePostCompletionAnnounceForSession(sessionKey?: string): boolean {
  if (
    typeof subagentRegistry.shouldIgnorePostCompletionAnnounceForSession !== "function" ||
    typeof sessionKey !== "string"
  ) {
    return false;
  }
  return subagentRegistry.shouldIgnorePostCompletionAnnounceForSession(sessionKey);
}
