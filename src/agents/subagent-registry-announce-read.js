import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { countPendingDescendantRunsExcludingRunFromRuns, countPendingDescendantRunsFromRuns, isSubagentSessionRunActiveFromRuns, listRunsForRequesterFromRuns, resolveRequesterForChildSessionFromRuns, shouldIgnorePostCompletionAnnounceForSessionFromRuns, } from "./subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
export function resolveRequesterForChildSession(childSessionKey) {
    const resolved = resolveRequesterForChildSessionFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), childSessionKey);
    if (!resolved) {
        return null;
    }
    return {
        requesterSessionKey: resolved.requesterSessionKey,
        requesterOrigin: normalizeDeliveryContext(resolved.requesterOrigin),
    };
}
export function isSubagentSessionRunActive(childSessionKey) {
    return isSubagentSessionRunActiveFromRuns(subagentRuns, childSessionKey);
}
export function shouldIgnorePostCompletionAnnounceForSession(childSessionKey) {
    return shouldIgnorePostCompletionAnnounceForSessionFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), childSessionKey);
}
export function listSubagentRunsForRequester(requesterSessionKey, options) {
    return listRunsForRequesterFromRuns(subagentRuns, requesterSessionKey, options);
}
export function countPendingDescendantRuns(rootSessionKey) {
    return countPendingDescendantRunsFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), rootSessionKey);
}
export function countPendingDescendantRunsExcludingRun(rootSessionKey, excludeRunId) {
    return countPendingDescendantRunsExcludingRunFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), rootSessionKey, excludeRunId);
}
