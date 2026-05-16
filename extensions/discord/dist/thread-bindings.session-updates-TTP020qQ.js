import { E as setBindingRecord, O as shouldPersistBindingMutations, T as saveBindingsToDisk, o as ensureBindingsLoaded, t as BINDINGS_BY_THREAD_ID, v as resolveBindingIdsForSession } from "./thread-bindings.state-Dzu1gCE7.js";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
//#region extensions/discord/src/monitor/thread-bindings.session-shared.ts
function normalizeNonNegativeMs(raw) {
	if (!Number.isFinite(raw)) return 0;
	return Math.max(0, Math.floor(raw));
}
function resolveBindingIdsForTargetSession(params) {
	ensureBindingsLoaded();
	const targetSessionKey = params.targetSessionKey.trim();
	if (!targetSessionKey) return [];
	return resolveBindingIdsForSession({
		targetSessionKey,
		accountId: params.accountId ? normalizeAccountId(params.accountId) : void 0,
		targetKind: params.targetKind
	});
}
function updateBindingsForTargetSession(ids, update) {
	if (ids.length === 0) return [];
	const now = Date.now();
	const updated = [];
	for (const bindingKey of ids) {
		const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
		if (!existing) continue;
		const nextRecord = update(existing, now);
		setBindingRecord(nextRecord);
		updated.push(nextRecord);
	}
	if (updated.length > 0 && shouldPersistBindingMutations()) saveBindingsToDisk({ force: true });
	return updated;
}
//#endregion
//#region extensions/discord/src/monitor/thread-bindings.session-updates.ts
function setThreadBindingIdleTimeoutBySessionKey(params) {
	const ids = resolveBindingIdsForTargetSession(params);
	const idleTimeoutMs = normalizeNonNegativeMs(params.idleTimeoutMs);
	return updateBindingsForTargetSession(ids, (existing, now) => ({
		...existing,
		idleTimeoutMs,
		lastActivityAt: now
	}));
}
function setThreadBindingMaxAgeBySessionKey(params) {
	const ids = resolveBindingIdsForTargetSession(params);
	const maxAgeMs = normalizeNonNegativeMs(params.maxAgeMs);
	return updateBindingsForTargetSession(ids, (existing, now) => ({
		...existing,
		maxAgeMs,
		boundAt: now,
		lastActivityAt: now
	}));
}
//#endregion
export { setThreadBindingMaxAgeBySessionKey as n, resolveBindingIdsForTargetSession as r, setThreadBindingIdleTimeoutBySessionKey as t };
