import { t as resolveThreadBindingLifecycle } from "./thread-binding-lifecycle-BL-h7xfb.js";
import "./thread-bindings-session-runtime-B_bKWdzh.js";
//#region extensions/matrix/src/matrix/thread-bindings-shared.ts
const MANAGERS_BY_ACCOUNT_ID = /* @__PURE__ */ new Map();
const BINDINGS_BY_ACCOUNT_CONVERSATION = /* @__PURE__ */ new Map();
function resolveBindingKey(params) {
	return `${params.accountId}:${params.parentConversationId?.trim() || "-"}:${params.conversationId}`;
}
function toSessionBindingTargetKind(raw) {
	return raw === "subagent" ? "subagent" : "session";
}
function toMatrixBindingTargetKind(raw) {
	return raw === "subagent" ? "subagent" : "acp";
}
function resolveEffectiveBindingExpiry(params) {
	return resolveThreadBindingLifecycle(params);
}
function toSessionBindingRecord(record, defaults) {
	const lifecycle = resolveEffectiveBindingExpiry({
		record,
		defaultIdleTimeoutMs: defaults.idleTimeoutMs,
		defaultMaxAgeMs: defaults.maxAgeMs
	});
	const idleTimeoutMs = typeof record.idleTimeoutMs === "number" ? record.idleTimeoutMs : defaults.idleTimeoutMs;
	const maxAgeMs = typeof record.maxAgeMs === "number" ? record.maxAgeMs : defaults.maxAgeMs;
	return {
		bindingId: resolveBindingKey(record),
		targetSessionKey: record.targetSessionKey,
		targetKind: toSessionBindingTargetKind(record.targetKind),
		conversation: {
			channel: "matrix",
			accountId: record.accountId,
			conversationId: record.conversationId,
			parentConversationId: record.parentConversationId
		},
		status: "active",
		boundAt: record.boundAt,
		expiresAt: lifecycle.expiresAt,
		metadata: {
			agentId: record.agentId,
			label: record.label,
			boundBy: record.boundBy,
			lastActivityAt: record.lastActivityAt,
			idleTimeoutMs,
			maxAgeMs
		}
	};
}
function setBindingRecord(record) {
	BINDINGS_BY_ACCOUNT_CONVERSATION.set(resolveBindingKey(record), record);
}
function removeBindingRecord(record) {
	const key = resolveBindingKey(record);
	const removed = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key) ?? null;
	if (removed) BINDINGS_BY_ACCOUNT_CONVERSATION.delete(key);
	return removed;
}
function listBindingsForAccount(accountId) {
	return [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()].filter((entry) => entry.accountId === accountId);
}
function listAllBindings() {
	return [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()];
}
function getMatrixThreadBindingManagerEntry(accountId) {
	return MANAGERS_BY_ACCOUNT_ID.get(accountId) ?? null;
}
function setMatrixThreadBindingManagerEntry(accountId, entry) {
	MANAGERS_BY_ACCOUNT_ID.set(accountId, entry);
}
function deleteMatrixThreadBindingManagerEntry(accountId) {
	MANAGERS_BY_ACCOUNT_ID.delete(accountId);
}
function getMatrixThreadBindingManager(accountId) {
	return MANAGERS_BY_ACCOUNT_ID.get(accountId)?.manager ?? null;
}
function setMatrixThreadBindingIdleTimeoutBySessionKey(params) {
	const manager = MANAGERS_BY_ACCOUNT_ID.get(params.accountId)?.manager;
	if (!manager) return [];
	return manager.setIdleTimeoutBySessionKey(params).map((record) => toSessionBindingRecord(record, {
		idleTimeoutMs: manager.getIdleTimeoutMs(),
		maxAgeMs: manager.getMaxAgeMs()
	}));
}
function setMatrixThreadBindingMaxAgeBySessionKey(params) {
	const manager = MANAGERS_BY_ACCOUNT_ID.get(params.accountId)?.manager;
	if (!manager) return [];
	return manager.setMaxAgeBySessionKey(params).map((record) => toSessionBindingRecord(record, {
		idleTimeoutMs: manager.getIdleTimeoutMs(),
		maxAgeMs: manager.getMaxAgeMs()
	}));
}
function resetMatrixThreadBindingsForTests() {
	for (const { manager } of MANAGERS_BY_ACCOUNT_ID.values()) manager.stop();
	MANAGERS_BY_ACCOUNT_ID.clear();
	BINDINGS_BY_ACCOUNT_CONVERSATION.clear();
}
//#endregion
export { listBindingsForAccount as a, resolveBindingKey as c, setMatrixThreadBindingIdleTimeoutBySessionKey as d, setMatrixThreadBindingManagerEntry as f, toSessionBindingRecord as h, listAllBindings as i, resolveEffectiveBindingExpiry as l, toMatrixBindingTargetKind as m, getMatrixThreadBindingManager as n, removeBindingRecord as o, setMatrixThreadBindingMaxAgeBySessionKey as p, getMatrixThreadBindingManagerEntry as r, resetMatrixThreadBindingsForTests as s, deleteMatrixThreadBindingManagerEntry as t, setBindingRecord as u };
