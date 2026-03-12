import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";

//#region src/agents/command-poll-backoff.ts
var command_poll_backoff_exports = /* @__PURE__ */ __exportAll({
	calculateBackoffMs: () => calculateBackoffMs,
	pruneStaleCommandPolls: () => pruneStaleCommandPolls,
	recordCommandPoll: () => recordCommandPoll,
	resetCommandPollCount: () => resetCommandPollCount
});
const BACKOFF_SCHEDULE_MS = [
	5e3,
	1e4,
	3e4,
	6e4
];
/**
* Calculate suggested retry delay based on consecutive no-output poll count.
* Implements exponential backoff schedule: 5s → 10s → 30s → 60s (capped).
*/
function calculateBackoffMs(consecutiveNoOutputPolls) {
	return BACKOFF_SCHEDULE_MS[Math.min(consecutiveNoOutputPolls, BACKOFF_SCHEDULE_MS.length - 1)] ?? 6e4;
}
/**
* Record a command poll and return suggested retry delay.
* @param state Session state to track polling in
* @param commandId Unique identifier for the command being polled
* @param hasNewOutput Whether this poll returned new output
* @returns Suggested delay in milliseconds before next poll
*/
function recordCommandPoll(state, commandId, hasNewOutput) {
	if (!state.commandPollCounts) state.commandPollCounts = /* @__PURE__ */ new Map();
	const existing = state.commandPollCounts.get(commandId);
	const now = Date.now();
	if (hasNewOutput) {
		state.commandPollCounts.set(commandId, {
			count: 0,
			lastPollAt: now
		});
		return BACKOFF_SCHEDULE_MS[0] ?? 5e3;
	}
	const newCount = (existing?.count ?? -1) + 1;
	state.commandPollCounts.set(commandId, {
		count: newCount,
		lastPollAt: now
	});
	return calculateBackoffMs(newCount);
}
/**
* Reset poll count for a command (e.g., when command completes).
*/
function resetCommandPollCount(state, commandId) {
	state.commandPollCounts?.delete(commandId);
}
/**
* Prune stale command poll records (older than 1 hour).
* Call periodically to prevent memory bloat.
*/
function pruneStaleCommandPolls(state, maxAgeMs = 36e5) {
	if (!state.commandPollCounts) return;
	const now = Date.now();
	for (const [commandId, data] of state.commandPollCounts.entries()) if (now - data.lastPollAt > maxAgeMs) state.commandPollCounts.delete(commandId);
}

//#endregion
export { recordCommandPoll as n, resetCommandPollCount as r, command_poll_backoff_exports as t };