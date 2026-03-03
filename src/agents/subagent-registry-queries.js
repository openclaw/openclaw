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
export function listRunsForRequesterFromRuns(runs, requesterSessionKey) {
    const key = requesterSessionKey.trim();
    if (!key) {
        return [];
    }
    return [...runs.values()].filter((entry) => entry.requesterSessionKey === key);
}
export function resolveRequesterForChildSessionFromRuns(runs, childSessionKey) {
    const key = childSessionKey.trim();
    if (!key) {
        return null;
    }
    let best;
    for (const entry of runs.values()) {
        if (entry.childSessionKey !== key) {
            continue;
        }
        if (!best || entry.createdAt > best.createdAt) {
            best = entry;
        }
    }
    if (!best) {
        return null;
    }
    return {
        requesterSessionKey: best.requesterSessionKey,
        requesterOrigin: best.requesterOrigin,
    };
}
export function countActiveRunsForSessionFromRuns(runs, requesterSessionKey) {
    const key = requesterSessionKey.trim();
    if (!key) {
        return 0;
    }
    let count = 0;
    for (const entry of runs.values()) {
        if (entry.requesterSessionKey !== key) {
            continue;
        }
        if (typeof entry.endedAt === "number") {
            continue;
        }
        count += 1;
    }
    return count;
}
export function countActiveDescendantRunsFromRuns(runs, rootSessionKey) {
    const root = rootSessionKey.trim();
    if (!root) {
        return 0;
    }
    const pending = [root];
    const visited = new Set([root]);
    let count = 0;
    while (pending.length > 0) {
        const requester = pending.shift();
        if (!requester) {
            continue;
        }
        for (const entry of runs.values()) {
            if (entry.requesterSessionKey !== requester) {
                continue;
            }
            if (typeof entry.endedAt !== "number") {
                count += 1;
            }
            const childKey = entry.childSessionKey.trim();
            if (!childKey || visited.has(childKey)) {
                continue;
            }
            visited.add(childKey);
            pending.push(childKey);
        }
    }
    return count;
}
function countPendingDescendantRunsInternal(runs, rootSessionKey, excludeRunId) {
    const root = rootSessionKey.trim();
    if (!root) {
        return 0;
    }
    const excludedRunId = excludeRunId?.trim();
    const pending = [root];
    const visited = new Set([root]);
    let count = 0;
    for (let index = 0; index < pending.length; index += 1) {
        const requester = pending[index];
        if (!requester) {
            continue;
        }
        for (const [runId, entry] of runs.entries()) {
            if (entry.requesterSessionKey !== requester) {
                continue;
            }
            const runEnded = typeof entry.endedAt === "number";
            const cleanupCompleted = typeof entry.cleanupCompletedAt === "number";
            if ((!runEnded || !cleanupCompleted) && runId !== excludedRunId) {
                count += 1;
            }
            const childKey = entry.childSessionKey.trim();
            if (!childKey || visited.has(childKey)) {
                continue;
            }
            visited.add(childKey);
            pending.push(childKey);
        }
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
    const root = rootSessionKey.trim();
    if (!root) {
        return [];
    }
    const pending = [root];
    const visited = new Set([root]);
    const descendants = [];
    while (pending.length > 0) {
        const requester = pending.shift();
        if (!requester) {
            continue;
        }
        for (const entry of runs.values()) {
            if (entry.requesterSessionKey !== requester) {
                continue;
            }
            descendants.push(entry);
            const childKey = entry.childSessionKey.trim();
            if (!childKey || visited.has(childKey)) {
                continue;
            }
            visited.add(childKey);
            pending.push(childKey);
        }
    }
    return descendants;
}
