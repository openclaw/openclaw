import { getSubagentSessionStartedAt } from "./subagent-session-metrics.js";
export const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;
export const RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS = 30 * 60 * 1_000;
const EXPLICIT_TIMEOUT_STALE_GRACE_MS = 60_000;
const MIN_REALISTIC_RUN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);
export function hasSubagentRunEnded(entry) {
    return typeof entry.endedAt === "number" && Number.isFinite(entry.endedAt);
}
function resolveStaleCutoffMs(entry) {
    const timeoutSeconds = entry.runTimeoutSeconds;
    if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
        return Math.max(STALE_UNENDED_SUBAGENT_RUN_MS, Math.floor(timeoutSeconds) * 1_000 + EXPLICIT_TIMEOUT_STALE_GRACE_MS);
    }
    return STALE_UNENDED_SUBAGENT_RUN_MS;
}
export function isStaleUnendedSubagentRun(entry, now = Date.now()) {
    if (hasSubagentRunEnded(entry)) {
        return false;
    }
    const startedAt = getSubagentSessionStartedAt(entry);
    if (typeof startedAt !== "number" ||
        !Number.isFinite(startedAt) ||
        startedAt < MIN_REALISTIC_RUN_TIMESTAMP_MS) {
        return false;
    }
    return now - startedAt > resolveStaleCutoffMs(entry);
}
export function isLiveUnendedSubagentRun(entry, now = Date.now()) {
    return !hasSubagentRunEnded(entry) && !isStaleUnendedSubagentRun(entry, now);
}
export function isRecentlyEndedSubagentRun(entry, now = Date.now(), recentMs = RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS) {
    if (!hasSubagentRunEnded(entry)) {
        return false;
    }
    return now - entry.endedAt <= recentMs;
}
export function shouldKeepSubagentRunChildLink(entry, options) {
    const now = options?.now ?? Date.now();
    return (isLiveUnendedSubagentRun(entry, now) ||
        (options?.activeDescendants ?? 0) > 0 ||
        isRecentlyEndedSubagentRun(entry, now));
}
