import { hasSubagentRunEnded, isLiveUnendedSubagentRun } from "./subagent-run-liveness.js";
function resolveControllerSessionKey(entry) {
    return entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
}
export function findRunIdsByChildSessionKeyFromRuns(runs, childSessionKey) {
    const key = childSessionKey.trim();
    if (!key) {
        return [];
    }
    const runIds = [];
    for (const [runId, entry] of runs.entries()) {
        if (entry.childSessionKey === key) {
            runIds.push(runId);
        }
    }
    return runIds;
}
export function listRunsForRequesterFromRuns(runs, requesterSessionKey, options) {
    const key = requesterSessionKey.trim();
    if (!key) {
        return [];
    }
    const requesterRunId = options?.requesterRunId?.trim();
    const requesterRun = requesterRunId ? runs.get(requesterRunId) : undefined;
    const requesterRunMatchesScope = requesterRun && requesterRun.childSessionKey === key ? requesterRun : undefined;
    const lowerBound = requesterRunMatchesScope?.startedAt ?? requesterRunMatchesScope?.createdAt;
    const upperBound = requesterRunMatchesScope?.endedAt;
    return [...runs.values()].filter((entry) => {
        if (entry.requesterSessionKey !== key) {
            return false;
        }
        if (typeof lowerBound === "number" && entry.createdAt < lowerBound) {
            return false;
        }
        if (typeof upperBound === "number" && entry.createdAt > upperBound) {
            return false;
        }
        return true;
    });
}
export function listRunsForControllerFromRuns(runs, controllerSessionKey) {
    const key = controllerSessionKey.trim();
    if (!key) {
        return [];
    }
    return [...runs.values()].filter((entry) => resolveControllerSessionKey(entry) === key);
}
function findLatestRunForChildSession(runs, childSessionKey) {
    const key = childSessionKey.trim();
    if (!key) {
        return undefined;
    }
    let latest;
    for (const entry of runs.values()) {
        if (entry.childSessionKey !== key) {
            continue;
        }
        if (!latest || entry.createdAt > latest.createdAt) {
            latest = entry;
        }
    }
    return latest;
}
export function isSubagentSessionRunActiveFromRuns(runs, childSessionKey) {
    const latest = findLatestRunForChildSession(runs, childSessionKey);
    return Boolean(latest && isLiveUnendedSubagentRun(latest));
}
export function getSubagentRunByChildSessionKeyFromRuns(runs, childSessionKey) {
    const key = childSessionKey.trim();
    if (!key) {
        return null;
    }
    let latestActive = null;
    let latestEnded = null;
    for (const entry of runs.values()) {
        if (entry.childSessionKey !== key) {
            continue;
        }
        if (isLiveUnendedSubagentRun(entry)) {
            if (!latestActive || entry.createdAt > latestActive.createdAt) {
                latestActive = entry;
            }
            continue;
        }
        if (!latestEnded || entry.createdAt > latestEnded.createdAt) {
            latestEnded = entry;
        }
    }
    return latestActive ?? latestEnded;
}
export function resolveRequesterForChildSessionFromRuns(runs, childSessionKey) {
    const latest = findLatestRunForChildSession(runs, childSessionKey);
    if (!latest) {
        return null;
    }
    return {
        requesterSessionKey: latest.requesterSessionKey,
        requesterOrigin: latest.requesterOrigin,
    };
}
export function shouldIgnorePostCompletionAnnounceForSessionFromRuns(runs, childSessionKey) {
    const latest = findLatestRunForChildSession(runs, childSessionKey);
    return Boolean(latest &&
        latest.spawnMode !== "session" &&
        typeof latest.endedAt === "number" &&
        typeof latest.cleanupCompletedAt === "number" &&
        latest.cleanupCompletedAt >= latest.endedAt);
}
export function countActiveRunsForSessionFromRuns(runs, controllerSessionKey) {
    const key = controllerSessionKey.trim();
    if (!key) {
        return 0;
    }
    const pendingDescendantCache = new Map();
    const pendingDescendantCount = (sessionKey) => {
        if (pendingDescendantCache.has(sessionKey)) {
            return pendingDescendantCache.get(sessionKey) ?? 0;
        }
        const pending = countPendingDescendantRunsInternal(runs, sessionKey);
        pendingDescendantCache.set(sessionKey, pending);
        return pending;
    };
    const latestByChildSessionKey = new Map();
    for (const entry of runs.values()) {
        if (resolveControllerSessionKey(entry) !== key) {
            continue;
        }
        const existing = latestByChildSessionKey.get(entry.childSessionKey);
        if (!existing || entry.createdAt > existing.createdAt) {
            latestByChildSessionKey.set(entry.childSessionKey, entry);
        }
    }
    let count = 0;
    for (const entry of latestByChildSessionKey.values()) {
        if (isLiveUnendedSubagentRun(entry)) {
            count += 1;
            continue;
        }
        if (pendingDescendantCount(entry.childSessionKey) > 0) {
            count += 1;
        }
    }
    return count;
}
function forEachDescendantRun(runs, rootSessionKey, visitor) {
    const root = rootSessionKey.trim();
    if (!root) {
        return false;
    }
    const pending = [root];
    const visited = new Set([root]);
    for (let index = 0; index < pending.length; index += 1) {
        const requester = pending[index];
        if (!requester) {
            continue;
        }
        const latestByChildSessionKey = new Map();
        for (const [runId, entry] of runs.entries()) {
            if (entry.requesterSessionKey !== requester) {
                continue;
            }
            const childKey = entry.childSessionKey.trim();
            const existing = latestByChildSessionKey.get(childKey);
            if (!existing || entry.createdAt > existing[1].createdAt) {
                latestByChildSessionKey.set(childKey, [runId, entry]);
            }
        }
        for (const [runId, entry] of latestByChildSessionKey.values()) {
            const latestForChildSession = findLatestRunForChildSession(runs, entry.childSessionKey);
            if (!latestForChildSession ||
                latestForChildSession.runId !== runId ||
                latestForChildSession.requesterSessionKey !== requester) {
                continue;
            }
            visitor(runId, entry);
            const childKey = entry.childSessionKey.trim();
            if (!childKey || visited.has(childKey)) {
                continue;
            }
            visited.add(childKey);
            pending.push(childKey);
        }
    }
    return true;
}
export function countActiveDescendantRunsFromRuns(runs, rootSessionKey) {
    let count = 0;
    if (!forEachDescendantRun(runs, rootSessionKey, (_runId, entry) => {
        if (isLiveUnendedSubagentRun(entry)) {
            count += 1;
        }
    })) {
        return 0;
    }
    return count;
}
function countPendingDescendantRunsInternal(runs, rootSessionKey, excludeRunId) {
    const excludedRunId = excludeRunId?.trim();
    let count = 0;
    if (!forEachDescendantRun(runs, rootSessionKey, (runId, entry) => {
        const runEnded = hasSubagentRunEnded(entry);
        const cleanupCompleted = typeof entry.cleanupCompletedAt === "number";
        const runPending = runEnded ? !cleanupCompleted : isLiveUnendedSubagentRun(entry);
        if (runPending && runId !== excludedRunId) {
            count += 1;
        }
    })) {
        return 0;
    }
    return count;
}
export function countPendingDescendantRunsFromRuns(runs, rootSessionKey) {
    return countPendingDescendantRunsInternal(runs, rootSessionKey);
}
export function countPendingDescendantRunsExcludingRunFromRuns(runs, rootSessionKey, excludeRunId) {
    return countPendingDescendantRunsInternal(runs, rootSessionKey, excludeRunId);
}
export function listDescendantRunsForRequesterFromRuns(runs, rootSessionKey) {
    const descendants = [];
    if (!forEachDescendantRun(runs, rootSessionKey, (_runId, entry) => {
        descendants.push(entry);
    })) {
        return [];
    }
    return descendants;
}
