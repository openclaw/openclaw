import { i as normalizeDeliveryContext } from "./delivery-context.shared-Cx37tn1U.js";
import { M as subagentRuns, c as countPendingDescendantRunsFromRuns, d as listAncestorSessionKeysFromRuns, g as shouldIgnorePostCompletionAnnounceForSessionFromRuns, h as resolveRequesterForChildSessionFromRuns, m as listRunsForRequesterFromRuns, s as countPendingDescendantRunsExcludingRunFromRuns, t as getSubagentRunsSnapshotForRead, u as isSubagentSessionRunActiveFromRuns } from "./subagent-registry-state-ZrQyB1gH.js";
import { n as countActiveDescendantRuns, r as getLatestSubagentRunByChildSessionKey } from "./subagent-registry-read-DE26_fAR.js";
import { r as replaceSubagentRunAfterSteer } from "./subagent-registry-steer-runtime-Dz5jWN2E.js";
//#region src/agents/subagent-registry-announce-read.ts
function resolveRequesterForChildSession(childSessionKey) {
	const resolved = resolveRequesterForChildSessionFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), childSessionKey);
	if (!resolved) return null;
	return {
		requesterSessionKey: resolved.requesterSessionKey,
		requesterOrigin: normalizeDeliveryContext(resolved.requesterOrigin)
	};
}
function listAncestorSessionKeys(sessionKey) {
	return listAncestorSessionKeysFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), sessionKey);
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
export { countActiveDescendantRuns, countPendingDescendantRuns, countPendingDescendantRunsExcludingRun, getLatestSubagentRunByChildSessionKey, isSubagentSessionRunActive, listAncestorSessionKeys, listSubagentRunsForRequester, replaceSubagentRunAfterSteer, resolveRequesterForChildSession, shouldIgnorePostCompletionAnnounceForSession };
