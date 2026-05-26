import { c as getAgentRunContext } from "./agent-events-BuYtWSh4.js";
import { M as subagentRuns, a as buildSubagentRunReadIndexFromRuns, f as listDescendantRunsForRequesterFromRuns, o as countActiveDescendantRunsFromRuns, p as listRunsForControllerFromRuns, t as getSubagentRunsSnapshotForRead, u as getSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-state-DbOPrqYx.js";
//#region src/agents/subagent-registry-read.ts
function buildSubagentRunReadIndex(now = Date.now()) {
	return buildSubagentRunReadIndexFromRuns({
		runs: getSubagentRunsSnapshotForRead(subagentRuns),
		inMemoryRuns: subagentRuns.values(),
		now
	});
}
function listSubagentRunsForController(controllerSessionKey) {
	return listRunsForControllerFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), controllerSessionKey);
}
function countActiveDescendantRuns(rootSessionKey) {
	return countActiveDescendantRunsFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), rootSessionKey);
}
function listDescendantRunsForRequester(rootSessionKey) {
	return listDescendantRunsForRequesterFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), rootSessionKey);
}
function getSubagentRunByChildSessionKey(childSessionKey) {
	return getSubagentRunByChildSessionKeyFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), childSessionKey);
}
function isSubagentRunLive(entry) {
	if (!entry || typeof entry.endedAt === "number") return false;
	return Boolean(getAgentRunContext(entry.runId));
}
function getSessionDisplaySubagentRunByChildSessionKey(childSessionKey) {
	const key = childSessionKey.trim();
	if (!key) return null;
	let latestInMemoryActive = null;
	let latestInMemoryEnded = null;
	for (const entry of subagentRuns.values()) {
		if (entry.childSessionKey !== key) continue;
		if (typeof entry.endedAt === "number") {
			if (!latestInMemoryEnded || entry.createdAt > latestInMemoryEnded.createdAt) latestInMemoryEnded = entry;
			continue;
		}
		if (!latestInMemoryActive || entry.createdAt > latestInMemoryActive.createdAt) latestInMemoryActive = entry;
	}
	if (latestInMemoryEnded || latestInMemoryActive) {
		if (latestInMemoryEnded && (!latestInMemoryActive || latestInMemoryEnded.createdAt > latestInMemoryActive.createdAt)) return latestInMemoryEnded;
		return latestInMemoryActive ?? latestInMemoryEnded;
	}
	return getSubagentRunByChildSessionKey(key);
}
function getLatestSubagentRunByChildSessionKey(childSessionKey) {
	const key = childSessionKey.trim();
	if (!key) return null;
	let latest = null;
	for (const entry of getSubagentRunsSnapshotForRead(subagentRuns).values()) {
		if (entry.childSessionKey !== key) continue;
		if (!latest || entry.createdAt > latest.createdAt) latest = entry;
	}
	return latest;
}
//#endregion
export { isSubagentRunLive as a, getSessionDisplaySubagentRunByChildSessionKey as i, countActiveDescendantRuns as n, listDescendantRunsForRequester as o, getLatestSubagentRunByChildSessionKey as r, listSubagentRunsForController as s, buildSubagentRunReadIndex as t };
