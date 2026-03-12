import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";

//#region src/logging/diagnostic-session-state.ts
var diagnostic_session_state_exports = /* @__PURE__ */ __exportAll({
	diagnosticSessionStates: () => diagnosticSessionStates,
	getDiagnosticSessionState: () => getDiagnosticSessionState,
	pruneDiagnosticSessionStates: () => pruneDiagnosticSessionStates
});
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
function findStateBySessionId(sessionId) {
	for (const state of diagnosticSessionStates.values()) if (state.sessionId === sessionId) return state;
}
function getDiagnosticSessionState(ref) {
	pruneDiagnosticSessionStates();
	const key = resolveSessionKey(ref);
	const existing = diagnosticSessionStates.get(key) ?? (ref.sessionId && findStateBySessionId(ref.sessionId));
	if (existing) {
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

//#endregion
export { pruneDiagnosticSessionStates as i, diagnostic_session_state_exports as n, getDiagnosticSessionState as r, diagnosticSessionStates as t };