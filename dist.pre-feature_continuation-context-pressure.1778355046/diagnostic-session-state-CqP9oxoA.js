//#region src/logging/diagnostic-session-state.ts
const diagnosticSessionStates = /* @__PURE__ */ new Map();
const SESSION_STATE_TTL_MS = 1800 * 1e3;
const SESSION_STATE_PRUNE_INTERVAL_MS = 60 * 1e3;
const SESSION_STATE_MAX_ENTRIES = 2e3;
let lastSessionPruneAt = 0;
function pruneDiagnosticSessionStates(now = Date.now(), force = false) {
	const shouldPruneForSize = diagnosticSessionStates.size > SESSION_STATE_MAX_ENTRIES;
	if (!force && !shouldPruneForSize && now - lastSessionPruneAt < SESSION_STATE_PRUNE_INTERVAL_MS) return;
	lastSessionPruneAt = now;
	for (const [key, state] of diagnosticSessionStates.entries()) {
		const ageMs = now - state.lastActivity;
		if (state.state === "idle" && state.queueDepth <= 0 && ageMs > SESSION_STATE_TTL_MS) diagnosticSessionStates.delete(key);
	}
	if (diagnosticSessionStates.size <= SESSION_STATE_MAX_ENTRIES) return;
	const excess = diagnosticSessionStates.size - SESSION_STATE_MAX_ENTRIES;
	const ordered = Array.from(diagnosticSessionStates.entries()).toSorted((a, b) => a[1].lastActivity - b[1].lastActivity);
	for (let i = 0; i < excess; i += 1) {
		const key = ordered[i]?.[0];
		if (!key) break;
		diagnosticSessionStates.delete(key);
	}
}
function resolveSessionKey({ sessionKey, sessionId }) {
	return sessionKey ?? sessionId ?? "unknown";
}
function findStateEntryBySessionId(sessionId) {
	for (const entry of diagnosticSessionStates.entries()) {
		const [, state] = entry;
		if (state.sessionId === sessionId) return entry;
	}
}
function sessionStatePriority(state) {
	return {
		idle: 0,
		waiting: 1,
		processing: 2
	}[state];
}
function mergeSessionState(target, source) {
	const sourceIsNewer = source.lastActivity > target.lastActivity;
	const sourceIsSameAgeAndMoreActive = source.lastActivity === target.lastActivity && sessionStatePriority(source.state) > sessionStatePriority(target.state);
	target.sessionId ??= source.sessionId;
	target.sessionKey ??= source.sessionKey;
	if (sourceIsNewer || sourceIsSameAgeAndMoreActive) target.state = source.state;
	target.lastActivity = Math.max(target.lastActivity, source.lastActivity);
	target.queueDepth += source.queueDepth;
	target.lastStuckWarnAgeMs = target.lastStuckWarnAgeMs === void 0 || source.lastStuckWarnAgeMs === void 0 ? void 0 : Math.max(target.lastStuckWarnAgeMs, source.lastStuckWarnAgeMs);
	target.lastLongRunningWarnAgeMs = target.lastLongRunningWarnAgeMs === void 0 || source.lastLongRunningWarnAgeMs === void 0 ? void 0 : Math.max(target.lastLongRunningWarnAgeMs, source.lastLongRunningWarnAgeMs);
	if (source.toolCallHistory?.length) target.toolCallHistory = [...target.toolCallHistory ?? [], ...source.toolCallHistory];
	if (source.toolLoopWarningBuckets?.size) {
		const buckets = target.toolLoopWarningBuckets ??= /* @__PURE__ */ new Map();
		for (const [bucket, count] of source.toolLoopWarningBuckets) buckets.set(bucket, Math.max(buckets.get(bucket) ?? 0, count));
	}
	if (source.commandPollCounts?.size) {
		const counts = target.commandPollCounts ??= /* @__PURE__ */ new Map();
		for (const [command, value] of source.commandPollCounts) {
			const existing = counts.get(command);
			if (!existing || value.lastPollAt > existing.lastPollAt) counts.set(command, value);
		}
	}
}
function getDiagnosticSessionState(ref) {
	pruneDiagnosticSessionStates();
	const key = resolveSessionKey(ref);
	const direct = diagnosticSessionStates.get(key);
	const sessionIdEntry = ref.sessionId ? findStateEntryBySessionId(ref.sessionId) : void 0;
	const existing = direct ?? sessionIdEntry?.[1];
	if (existing) {
		if (direct && sessionIdEntry && sessionIdEntry[1] !== direct) {
			mergeSessionState(direct, sessionIdEntry[1]);
			diagnosticSessionStates.delete(sessionIdEntry[0]);
		} else if (!direct && ref.sessionKey && sessionIdEntry) {
			diagnosticSessionStates.delete(sessionIdEntry[0]);
			diagnosticSessionStates.set(key, existing);
		}
		if (ref.sessionId) existing.sessionId = ref.sessionId;
		if (ref.sessionKey) existing.sessionKey = ref.sessionKey;
		return existing;
	}
	const created = {
		sessionId: ref.sessionId,
		sessionKey: ref.sessionKey,
		lastActivity: Date.now(),
		state: "idle",
		queueDepth: 0
	};
	diagnosticSessionStates.set(key, created);
	pruneDiagnosticSessionStates(Date.now(), true);
	return created;
}
function getDiagnosticSessionStateCountForTest() {
	return diagnosticSessionStates.size;
}
function resetDiagnosticSessionStateForTest() {
	diagnosticSessionStates.clear();
	lastSessionPruneAt = 0;
}
//#endregion
export { resetDiagnosticSessionStateForTest as a, pruneDiagnosticSessionStates as i, getDiagnosticSessionState as n, getDiagnosticSessionStateCountForTest as r, diagnosticSessionStates as t };
