import { resolveIntegerOption } from "./numeric-options.mjs";
import { randomUUID } from "node:crypto";
//#region src/session.ts
const DEFAULT_MAX_SESSIONS = 5e3;
const DEFAULT_IDLE_TTL_MS = 1440 * 60 * 1e3;
function createInMemorySessionStore(options = {}) {
	const maxSessions = resolveIntegerOption(options.maxSessions, DEFAULT_MAX_SESSIONS, { min: 1 });
	const idleTtlMs = resolveIntegerOption(options.idleTtlMs, DEFAULT_IDLE_TTL_MS, { min: 1e3 });
	const now = options.now ?? Date.now;
	const sessions = /* @__PURE__ */ new Map();
	const runIdToSessionId = /* @__PURE__ */ new Map();
	const touchSession = (session, nowMs) => {
		session.lastTouchedAt = nowMs;
	};
	const removeSession = (sessionId) => {
		const session = sessions.get(sessionId);
		if (!session) return false;
		if (session.activeRunId) runIdToSessionId.delete(session.activeRunId);
		session.abortController?.abort();
		sessions.delete(sessionId);
		return true;
	};
	const reapIdleSessions = (nowMs) => {
		const idleBefore = nowMs - idleTtlMs;
		for (const [sessionId, session] of sessions.entries()) {
			if (session.activeRunId || session.abortController) continue;
			if (session.lastTouchedAt > idleBefore) continue;
			removeSession(sessionId);
		}
	};
	const evictOldestIdleSession = () => {
		let oldestSessionId = null;
		let oldestLastTouchedAt = Number.POSITIVE_INFINITY;
		for (const [sessionId, session] of sessions.entries()) {
			if (session.activeRunId || session.abortController) continue;
			if (session.lastTouchedAt >= oldestLastTouchedAt) continue;
			oldestLastTouchedAt = session.lastTouchedAt;
			oldestSessionId = sessionId;
		}
		if (!oldestSessionId) return false;
		return removeSession(oldestSessionId);
	};
	const createSession = (params) => {
		const nowMs = now();
		const sessionId = params.sessionId ?? randomUUID();
		const existingSession = sessions.get(sessionId);
		if (existingSession) {
			existingSession.sessionKey = params.sessionKey;
			if ("ledgerSessionId" in params) existingSession.ledgerSessionId = params.ledgerSessionId;
			existingSession.cwd = params.cwd;
			touchSession(existingSession, nowMs);
			return existingSession;
		}
		reapIdleSessions(nowMs);
		if (sessions.size >= maxSessions && !evictOldestIdleSession()) throw new Error(`ACP session limit reached (max ${maxSessions}). Close idle ACP clients and retry.`);
		const session = {
			sessionId,
			sessionKey: params.sessionKey,
			...params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {},
			cwd: params.cwd,
			createdAt: nowMs,
			lastTouchedAt: nowMs,
			abortController: null,
			activeRunId: null
		};
		sessions.set(sessionId, session);
		return session;
	};
	const hasSession = (sessionId) => sessions.has(sessionId);
	const getSession = (sessionId) => {
		const session = sessions.get(sessionId);
		if (session) touchSession(session, now());
		return session;
	};
	const getSessionByRunId = (runId) => {
		const sessionId = runIdToSessionId.get(runId);
		if (!sessionId) return;
		const session = sessions.get(sessionId);
		if (session) touchSession(session, now());
		return session;
	};
	const setActiveRun = (sessionId, runId, abortController) => {
		const session = sessions.get(sessionId);
		if (!session) return;
		session.activeRunId = runId;
		session.abortController = abortController;
		runIdToSessionId.set(runId, sessionId);
		touchSession(session, now());
	};
	const clearActiveRun = (sessionId) => {
		const session = sessions.get(sessionId);
		if (!session) return;
		if (session.activeRunId) runIdToSessionId.delete(session.activeRunId);
		session.activeRunId = null;
		session.abortController = null;
		touchSession(session, now());
	};
	const cancelActiveRun = (sessionId) => {
		const session = sessions.get(sessionId);
		if (!session?.abortController) return false;
		session.abortController.abort();
		if (session.activeRunId) runIdToSessionId.delete(session.activeRunId);
		session.abortController = null;
		session.activeRunId = null;
		touchSession(session, now());
		return true;
	};
	const deleteSession = (sessionId) => removeSession(sessionId);
	const clearAllSessionsForTest = () => {
		for (const session of sessions.values()) session.abortController?.abort();
		sessions.clear();
		runIdToSessionId.clear();
	};
	return {
		createSession,
		hasSession,
		getSession,
		getSessionByRunId,
		setActiveRun,
		clearActiveRun,
		cancelActiveRun,
		deleteSession,
		clearAllSessionsForTest
	};
}
const defaultAcpSessionStore = createInMemorySessionStore();
//#endregion
export { createInMemorySessionStore, defaultAcpSessionStore };
