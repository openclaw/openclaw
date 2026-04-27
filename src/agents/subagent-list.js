import { resolveSubagentLabel, sortSubagentRuns } from "../auto-reply/reply/subagents-utils.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { formatDurationCompact, formatTokenUsageDisplay, resolveTotalTokens, truncateLine, } from "../shared/subagents-format.js";
import { resolveModelDisplayName, resolveModelDisplayRef } from "./model-selection-display.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { countActiveDescendantRunsFromRuns, countPendingDescendantRunsFromRuns, } from "./subagent-registry-queries.js";
import { getSubagentSessionRuntimeMs, getSubagentSessionStartedAt, } from "./subagent-registry-read.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import { hasSubagentRunEnded, isLiveUnendedSubagentRun, shouldKeepSubagentRunChildLink, } from "./subagent-run-liveness.js";
function resolveStorePathForKey(cfg, key, parsed) {
    return resolveStorePath(cfg.session?.store, {
        agentId: parsed?.agentId,
    });
}
export function resolveSessionEntryForKey(params) {
    const parsed = parseAgentSessionKey(params.key);
    const storePath = resolveStorePathForKey(params.cfg, params.key, parsed);
    let store = params.cache.get(storePath);
    if (!store) {
        store = loadSessionStore(storePath);
        params.cache.set(storePath, store);
    }
    return {
        storePath,
        entry: store[params.key],
    };
}
export function buildLatestSubagentRunIndex(runs, options) {
    const now = options?.now ?? Date.now();
    const latestByChildSessionKey = new Map();
    for (const entry of runs.values()) {
        const childSessionKey = entry.childSessionKey?.trim();
        if (!childSessionKey) {
            continue;
        }
        const existing = latestByChildSessionKey.get(childSessionKey);
        if (!existing || entry.createdAt > existing.createdAt) {
            latestByChildSessionKey.set(childSessionKey, entry);
        }
    }
    const childSessionsByController = new Map();
    for (const [childSessionKey, entry] of latestByChildSessionKey.entries()) {
        const controllerSessionKey = entry.controllerSessionKey?.trim() || entry.requesterSessionKey?.trim();
        if (!controllerSessionKey) {
            continue;
        }
        if (!shouldKeepSubagentRunChildLink(entry, {
            activeDescendants: countActiveDescendantRunsFromRuns(runs, childSessionKey),
            now,
        })) {
            continue;
        }
        const existing = childSessionsByController.get(controllerSessionKey);
        if (existing) {
            existing.push(childSessionKey);
            continue;
        }
        childSessionsByController.set(controllerSessionKey, [childSessionKey]);
    }
    for (const [controllerSessionKey, childSessions] of childSessionsByController) {
        childSessionsByController.set(controllerSessionKey, childSessions.toSorted());
    }
    return {
        latestByChildSessionKey,
        childSessionsByController,
    };
}
export function createPendingDescendantCounter(runsSnapshot) {
    const pendingDescendantCache = new Map();
    return (sessionKey) => {
        if (pendingDescendantCache.has(sessionKey)) {
            return pendingDescendantCache.get(sessionKey) ?? 0;
        }
        const snapshot = runsSnapshot ?? getSubagentRunsSnapshotForRead(subagentRuns);
        const pending = Math.max(0, countPendingDescendantRunsFromRuns(snapshot, sessionKey));
        pendingDescendantCache.set(sessionKey, pending);
        return pending;
    };
}
export function isActiveSubagentRun(entry, pendingDescendantCount) {
    return isLiveUnendedSubagentRun(entry) || pendingDescendantCount(entry.childSessionKey) > 0;
}
function resolveRunStatus(entry, options) {
    const pendingDescendants = Math.max(0, options?.pendingDescendants ?? 0);
    if (pendingDescendants > 0) {
        const childLabel = pendingDescendants === 1 ? "child" : "children";
        return `active (waiting on ${pendingDescendants} ${childLabel})`;
    }
    if (!hasSubagentRunEnded(entry)) {
        return "running";
    }
    const status = entry.outcome?.status ?? "done";
    if (status === "ok") {
        return "done";
    }
    if (status === "error") {
        return "failed";
    }
    return status;
}
function resolveModelRef(entry, fallbackModel) {
    return resolveModelDisplayRef({
        runtimeProvider: entry?.modelProvider,
        runtimeModel: entry?.model,
        overrideProvider: entry?.providerOverride,
        overrideModel: entry?.modelOverride,
        fallbackModel,
    });
}
function resolveModelDisplay(entry, fallbackModel) {
    return resolveModelDisplayName({
        runtimeProvider: entry?.modelProvider,
        runtimeModel: entry?.model,
        overrideProvider: entry?.providerOverride,
        overrideModel: entry?.modelOverride,
        fallbackModel,
    });
}
function buildListText(params) {
    const lines = [];
    lines.push("active subagents:");
    if (params.active.length === 0) {
        lines.push("(none)");
    }
    else {
        lines.push(...params.active.map((entry) => entry.line));
    }
    lines.push("");
    lines.push(`recent (last ${params.recentMinutes}m):`);
    if (params.recent.length === 0) {
        lines.push("(none)");
    }
    else {
        lines.push(...params.recent.map((entry) => entry.line));
    }
    return lines.join("\n");
}
export function buildSubagentList(params) {
    const now = Date.now();
    const recentCutoff = now - params.recentMinutes * 60_000;
    const dedupedRuns = [];
    const seenChildSessionKeys = new Set();
    for (const entry of sortSubagentRuns(params.runs)) {
        if (seenChildSessionKeys.has(entry.childSessionKey)) {
            continue;
        }
        seenChildSessionKeys.add(entry.childSessionKey);
        dedupedRuns.push(entry);
    }
    const cache = new Map();
    const snapshot = getSubagentRunsSnapshotForRead(subagentRuns);
    const { childSessionsByController } = buildLatestSubagentRunIndex(snapshot);
    const pendingDescendantCount = createPendingDescendantCounter(snapshot);
    let index = 1;
    const buildListEntry = (entry, runtimeMs) => {
        const sessionEntry = resolveSessionEntryForKey({
            cfg: params.cfg,
            key: entry.childSessionKey,
            cache,
        }).entry;
        const totalTokens = resolveTotalTokens(sessionEntry);
        const usageText = formatTokenUsageDisplay(sessionEntry);
        const pendingDescendants = pendingDescendantCount(entry.childSessionKey);
        const status = resolveRunStatus(entry, {
            pendingDescendants,
        });
        const childSessions = childSessionsByController.get(entry.childSessionKey) ?? [];
        const runtime = formatDurationCompact(runtimeMs) ?? "n/a";
        const label = truncateLine(resolveSubagentLabel(entry), 48);
        const task = truncateLine(entry.task.trim(), params.taskMaxChars ?? 72);
        const line = `${index}. ${label} (${resolveModelDisplay(sessionEntry, entry.model)}, ${runtime}${usageText ? `, ${usageText}` : ""}) ${status}${normalizeLowercaseStringOrEmpty(task) !== normalizeLowercaseStringOrEmpty(label) ? ` - ${task}` : ""}`;
        const view = {
            index,
            line,
            runId: entry.runId,
            sessionKey: entry.childSessionKey,
            label,
            task,
            status,
            pendingDescendants,
            runtime,
            runtimeMs,
            ...(childSessions.length > 0 ? { childSessions } : {}),
            model: resolveModelRef(sessionEntry, entry.model),
            totalTokens,
            startedAt: getSubagentSessionStartedAt(entry),
            ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
        };
        index += 1;
        return view;
    };
    const active = dedupedRuns
        .filter((entry) => isActiveSubagentRun(entry, pendingDescendantCount))
        .map((entry) => buildListEntry(entry, getSubagentSessionRuntimeMs(entry, now) ?? 0));
    const recent = dedupedRuns
        .filter((entry) => !isActiveSubagentRun(entry, pendingDescendantCount) &&
        !!entry.endedAt &&
        (entry.endedAt ?? 0) >= recentCutoff)
        .map((entry) => buildListEntry(entry, getSubagentSessionRuntimeMs(entry, entry.endedAt ?? now) ?? 0));
    return {
        total: dedupedRuns.length,
        active,
        recent,
        text: buildListText({ active, recent, recentMinutes: params.recentMinutes }),
    };
}
