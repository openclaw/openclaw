import { i as normalizeDeliveryContext } from "./delivery-context.shared-Dk7-07JJ.js";
import { c as countPendingDescendantRunsFromRuns, h as shouldIgnorePostCompletionAnnounceForSessionFromRuns, j as subagentRuns, m as resolveRequesterForChildSessionFromRuns, p as listRunsForRequesterFromRuns, s as countPendingDescendantRunsExcludingRunFromRuns, t as getSubagentRunsSnapshotForRead, u as isSubagentSessionRunActiveFromRuns } from "./subagent-registry-state-DKEodHtB.js";
import { n as countActiveDescendantRuns, r as getLatestSubagentRunByChildSessionKey } from "./subagent-registry-read-CUpdXOkd.js";
import { r as replaceSubagentRunAfterSteer } from "./subagent-registry-steer-runtime-CwTomh-c.js";
//#region src/agents/subagent-registry-announce-read.ts
function resolveRequesterForChildSession(childSessionKey) {
	const resolved = resolveRequesterForChildSessionFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), childSessionKey);
	if (!resolved) return null;
	return {
		requesterSessionKey: resolved.requesterSessionKey,
		requesterOrigin: normalizeDeliveryContext(resolved.requesterOrigin)
	};
}
function isSubagentSessionRunActive(childSessionKey) {
	return isSubagentSessionRunActiveFromRuns(subagentRuns, childSessionKey);
}
function shouldIgnorePostCompletionAnnounceForSession(childSessionKey) {
	return shouldIgnorePostCompletionAnnounceForSessionFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), childSessionKey);
}
function listSubagentRunsForRequester(requesterSessionKey, options) {
	return listRunsForRequesterFromRuns(subagentRuns, requesterSessionKey, options);
}
function countPendingDescendantRuns(rootSessionKey) {
	return countPendingDescendantRunsFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), rootSessionKey);
}
function countPendingDescendantRunsExcludingRun(rootSessionKey, excludeRunId) {
	return countPendingDescendantRunsExcludingRunFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), rootSessionKey, excludeRunId);
}
//#endregion
export { countActiveDescendantRuns, countPendingDescendantRuns, countPendingDescendantRunsExcludingRun, getLatestSubagentRunByChildSessionKey, isSubagentSessionRunActive, listSubagentRunsForRequester, replaceSubagentRunAfterSteer, resolveRequesterForChildSession, shouldIgnorePostCompletionAnnounceForSession };
