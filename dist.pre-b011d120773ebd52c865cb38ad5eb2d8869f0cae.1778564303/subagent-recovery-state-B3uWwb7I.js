//#region src/agents/subagent-recovery-state.ts
const SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS = 2;
const SUBAGENT_RECOVERY_REWEDGE_WINDOW_MS = 2 * 6e4;
function isRecentRecoveryAttempt(entry, now) {
	const lastAttemptAt = entry.subagentRecovery?.lastAttemptAt;
	return typeof lastAttemptAt === "number" && Number.isFinite(lastAttemptAt) && now - lastAttemptAt <= SUBAGENT_RECOVERY_REWEDGE_WINDOW_MS;
}
function isSubagentRecoveryWedgedEntry(entry) {
	if (!entry || typeof entry !== "object") return false;
	const recovery = entry.subagentRecovery;
	return typeof recovery?.wedgedAt === "number" && Number.isFinite(recovery.wedgedAt) && recovery.wedgedAt > 0;
}
function formatSubagentRecoveryWedgedReason(entry) {
	return entry.subagentRecovery?.wedgedReason?.trim() || "subagent orphan recovery is tombstoned for this session";
}
function evaluateSubagentRecoveryGate(entry, now) {
	if (isSubagentRecoveryWedgedEntry(entry)) return {
		allowed: false,
		reason: formatSubagentRecoveryWedgedReason(entry),
		shouldMarkWedged: false
	};
	const previousAttempts = isRecentRecoveryAttempt(entry, now) ? Math.max(0, entry.subagentRecovery?.automaticAttempts ?? 0) : 0;
	if (previousAttempts >= SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS) return {
		allowed: false,
		reason: `subagent orphan recovery blocked after ${previousAttempts} rapid accepted resume attempts; run "openclaw tasks maintenance --apply" or "openclaw doctor --fix" to reconcile it`,
		shouldMarkWedged: true
	};
	return {
		allowed: true,
		nextAttempt: previousAttempts + 1
	};
}
function markSubagentRecoveryAttempt(params) {
	params.entry.subagentRecovery = {
		automaticAttempts: Math.max(1, params.attempt),
		lastAttemptAt: params.now,
		lastRunId: params.runId
	};
}
function markSubagentRecoveryWedged(params) {
	params.entry.abortedLastRun = false;
	params.entry.subagentRecovery = {
		...params.entry.subagentRecovery,
		automaticAttempts: Math.max(params.entry.subagentRecovery?.automaticAttempts ?? 0, SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS),
		lastAttemptAt: params.entry.subagentRecovery?.lastAttemptAt ?? params.now,
		...params.runId ? { lastRunId: params.runId } : {},
		wedgedAt: params.now,
		wedgedReason: params.reason
	};
	params.entry.updatedAt = params.now;
}
function clearWedgedSubagentRecoveryAbort(entry, now) {
	if (!isSubagentRecoveryWedgedEntry(entry) || entry.abortedLastRun !== true) return false;
	entry.abortedLastRun = false;
	entry.updatedAt = now;
	return true;
}
//#endregion
export { markSubagentRecoveryAttempt as a, isSubagentRecoveryWedgedEntry as i, evaluateSubagentRecoveryGate as n, markSubagentRecoveryWedged as o, formatSubagentRecoveryWedgedReason as r, clearWedgedSubagentRecoveryAbort as t };
