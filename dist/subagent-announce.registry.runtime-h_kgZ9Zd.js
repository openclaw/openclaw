import { o as normalizeDeliveryContext } from "./delivery-context.shared-CBmB9dF7.js";
import { M as subagentRuns, c as countPendingDescendantRunsExcludingRunFromRuns, d as isSubagentSessionRunActiveFromRuns, g as shouldIgnorePostCompletionAnnounceForSessionFromRuns, h as resolveRequesterForChildSessionFromRuns, l as countPendingDescendantRunsFromRuns, m as listRunsForRequesterFromRuns, t as getSubagentRunsSnapshotForRead } from "./subagent-registry-state-DbOPrqYx.js";
import { n as countActiveDescendantRuns, r as getLatestSubagentRunByChildSessionKey } from "./subagent-registry-read-0y5BjaUV.js";
import { r as replaceSubagentRunAfterSteer } from "./subagent-registry-steer-runtime-9Vso0zzU.js";
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
