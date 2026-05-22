//#region src/gateway/server-chat-state.ts
function createChatRunRegistry() {
	const chatRunSessions = /* @__PURE__ */ new Map();
	const add = (sessionId, entry) => {
		const queue = chatRunSessions.get(sessionId);
		if (queue) queue.push(entry);
		else chatRunSessions.set(sessionId, [entry]);
	};
	const peek = (sessionId) => chatRunSessions.get(sessionId)?.[0];
	const shift = (sessionId) => {
		const queue = chatRunSessions.get(sessionId);
		if (!queue || queue.length === 0) return;
		const entry = queue.shift();
		if (!queue.length) chatRunSessions.delete(sessionId);
		return entry;
	};
	const remove = (sessionId, clientRunId, sessionKey) => {
		const queue = chatRunSessions.get(sessionId);
		if (!queue || queue.length === 0) return;
		const idx = queue.findIndex((entry) => entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true));
		if (idx < 0) return;
		const [entry] = queue.splice(idx, 1);
		if (!queue.length) chatRunSessions.delete(sessionId);
		return entry;
	};
	const clear = () => {
		chatRunSessions.clear();
	};
	return {
		add,
		peek,
		shift,
		remove,
		clear
	};
}
function createChatRunState() {
	const registry = createChatRunRegistry();
	const rawBuffers = /* @__PURE__ */ new Map();
	const buffers = /* @__PURE__ */ new Map();
	const deltaSentAt = /* @__PURE__ */ new Map();
	const deltaLastBroadcastLen = /* @__PURE__ */ new Map();
	const abortedRuns = /* @__PURE__ */ new Map();
	const clear = () => {
		registry.clear();
		rawBuffers.clear();
		buffers.clear();
		deltaSentAt.clear();
		deltaLastBroadcastLen.clear();
		abortedRuns.clear();
	};
	return {
		registry,
		rawBuffers,
		buffers,
		deltaSentAt,
		deltaLastBroadcastLen,
		abortedRuns,
		clear
	};
}
const TOOL_EVENT_RECIPIENT_TTL_MS = 600 * 1e3;
const TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS = 30 * 1e3;
function createSessionEventSubscriberRegistry() {
	const connIds = /* @__PURE__ */ new Set();
	const empty = /* @__PURE__ */ new Set();
	return {
		subscribe: (connId) => {
			const normalized = connId.trim();
			if (!normalized) return;
			connIds.add(normalized);
		},
		unsubscribe: (connId) => {
			const normalized = connId.trim();
			if (!normalized) return;
			connIds.delete(normalized);
		},
		getAll: () => connIds.size > 0 ? connIds : empty,
		clear: () => {
			connIds.clear();
		}
	};
}
function createSessionMessageSubscriberRegistry() {
	const sessionToConnIds = /* @__PURE__ */ new Map();
	const connToSessionKeys = /* @__PURE__ */ new Map();
	const empty = /* @__PURE__ */ new Set();
	const normalize = (value) => value.trim();
	return {
		subscribe: (connId, sessionKey) => {
			const normalizedConnId = normalize(connId);
			const normalizedSessionKey = normalize(sessionKey);
			if (!normalizedConnId || !normalizedSessionKey) return;
			const connIds = sessionToConnIds.get(normalizedSessionKey) ?? /* @__PURE__ */ new Set();
			connIds.add(normalizedConnId);
			sessionToConnIds.set(normalizedSessionKey, connIds);
			const sessionKeys = connToSessionKeys.get(normalizedConnId) ?? /* @__PURE__ */ new Set();
			sessionKeys.add(normalizedSessionKey);
			connToSessionKeys.set(normalizedConnId, sessionKeys);
		},
		unsubscribe: (connId, sessionKey) => {
			const normalizedConnId = normalize(connId);
			const normalizedSessionKey = normalize(sessionKey);
			if (!normalizedConnId || !normalizedSessionKey) return;
			const connIds = sessionToConnIds.get(normalizedSessionKey);
			if (connIds) {
				connIds.delete(normalizedConnId);
				if (connIds.size === 0) sessionToConnIds.delete(normalizedSessionKey);
			}
			const sessionKeys = connToSessionKeys.get(normalizedConnId);
			if (sessionKeys) {
				sessionKeys.delete(normalizedSessionKey);
				if (sessionKeys.size === 0) connToSessionKeys.delete(normalizedConnId);
			}
		},
		unsubscribeAll: (connId) => {
			const normalizedConnId = normalize(connId);
			if (!normalizedConnId) return;
			const sessionKeys = connToSessionKeys.get(normalizedConnId);
			if (!sessionKeys) return;
			for (const sessionKey of sessionKeys) {
				const connIds = sessionToConnIds.get(sessionKey);
				if (!connIds) continue;
				connIds.delete(normalizedConnId);
				if (connIds.size === 0) sessionToConnIds.delete(sessionKey);
			}
			connToSessionKeys.delete(normalizedConnId);
		},
		get: (sessionKey) => {
			const normalizedSessionKey = normalize(sessionKey);
			if (!normalizedSessionKey) return empty;
			return sessionToConnIds.get(normalizedSessionKey) ?? empty;
		},
		clear: () => {
			sessionToConnIds.clear();
			connToSessionKeys.clear();
		}
	};
}
function createToolEventRecipientRegistry() {
	const recipients = /* @__PURE__ */ new Map();
	const prune = () => {
		if (recipients.size === 0) return;
		const now = Date.now();
		for (const [runId, entry] of recipients) if (now >= (entry.finalizedAt ? entry.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS : entry.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS)) recipients.delete(runId);
	};
	const add = (runId, connId) => {
		if (!runId || !connId) return;
		const now = Date.now();
		const existing = recipients.get(runId);
		if (existing) {
			existing.connIds.add(connId);
			existing.updatedAt = now;
		} else recipients.set(runId, {
			connIds: new Set([connId]),
			updatedAt: now
		});
		prune();
	};
	const get = (runId) => {
		const entry = recipients.get(runId);
		if (!entry) return;
		entry.updatedAt = Date.now();
		prune();
		return entry.connIds;
	};
	const markFinal = (runId) => {
		const entry = recipients.get(runId);
		if (!entry) return;
		entry.finalizedAt = Date.now();
		prune();
	};
	return {
		add,
		get,
		markFinal
	};
}
//#endregion
export { createToolEventRecipientRegistry as a, createSessionMessageSubscriberRegistry as i, createChatRunState as n, createSessionEventSubscriberRegistry as r, createChatRunRegistry as t };
