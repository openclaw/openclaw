import { getAgentRunContext } from "../infra/agent-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { countActiveDescendantRunsFromRuns, getSubagentRunByChildSessionKeyFromRuns, listDescendantRunsForRequesterFromRuns, listRunsForControllerFromRuns, } from "./subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
export { getSubagentSessionRuntimeMs, getSubagentSessionStartedAt, resolveSubagentSessionStatus, } from "./subagent-session-metrics.js";
export function listSubagentRunsForController(controllerSessionKey) {
    return listRunsForControllerFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), controllerSessionKey);
}
export function countActiveDescendantRuns(rootSessionKey) {
    return countActiveDescendantRunsFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), rootSessionKey);
}
export function listDescendantRunsForRequester(rootSessionKey) {
    return listDescendantRunsForRequesterFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), rootSessionKey);
}
export function getSubagentRunByChildSessionKey(childSessionKey) {
    return getSubagentRunByChildSessionKeyFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), childSessionKey);
}
export function isSubagentRunLive(entry) {
    if (!entry || typeof entry.endedAt === "number") {
        return false;
    }
    return Boolean(getAgentRunContext(entry.runId));
}
export function getSessionDisplaySubagentRunByChildSessionKey(childSessionKey) {
    const key = childSessionKey.trim();
    if (!key) {
        return null;
    }
    let latestInMemoryActive = null;
    let latestInMemoryEnded = null;
    for (const entry of subagentRuns.values()) {
        if (entry.childSessionKey !== key) {
            continue;
        }
        if (typeof entry.endedAt === "number") {
            if (!latestInMemoryEnded || entry.createdAt > latestInMemoryEnded.createdAt) {
                latestInMemoryEnded = entry;
            }
            continue;
        }
        if (!latestInMemoryActive || entry.createdAt > latestInMemoryActive.createdAt) {
            latestInMemoryActive = entry;
        }
    }
    if (latestInMemoryEnded || latestInMemoryActive) {
        if (latestInMemoryEnded &&
            (!latestInMemoryActive || latestInMemoryEnded.createdAt > latestInMemoryActive.createdAt)) {
            return latestInMemoryEnded;
        }
        return latestInMemoryActive ?? latestInMemoryEnded;
    }
    return getSubagentRunByChildSessionKey(key);
}
export function getLatestSubagentRunByChildSessionKey(childSessionKey) {
    const key = childSessionKey.trim();
    if (!key) {
        return null;
    }
    let latest = null;
    for (const entry of getSubagentRunsSnapshotForRead(subagentRuns).values()) {
        if (entry.childSessionKey !== key) {
            continue;
        }
        if (!latest || entry.createdAt > latest.createdAt) {
            latest = entry;
        }
    }
    return latest;
}
