import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { i as registerSessionBindingAdapter, o as unregisterSessionBindingAdapter } from "./session-binding-service-B19FMAqz.js";
import { c as resolveThreadBindingMaxAgeMsForChannel, o as resolveThreadBindingIdleTimeoutMsForChannel } from "./thread-bindings-policy-BAuuUJk1.js";
import { t as resolveThreadBindingConversationIdFromBindingId } from "./thread-binding-id-DKmKA6Dw.js";
//#region src/infra/outbound/account-scoped-conversation-bindings.ts
function getState(stateKey) {
	const globalStore = globalThis;
	const existing = globalStore[stateKey];
	if (existing) return existing;
	const next = {
		managersByAccountId: /* @__PURE__ */ new Map(),
		bindingsByAccountConversation: /* @__PURE__ */ new Map()
	};
	globalStore[stateKey] = next;
	return next;
}
function resolveBindingKey(params) {
	return `${params.accountId}:${params.conversationId}`;
}
function toSessionBindingRecord(params) {
	const idleExpiresAt = params.idleTimeoutMs > 0 ? params.record.lastActivityAt + params.idleTimeoutMs : void 0;
	const maxAgeExpiresAt = params.maxAgeMs > 0 ? params.record.boundAt + params.maxAgeMs : void 0;
	const expiresAt = idleExpiresAt != null && maxAgeExpiresAt != null ? Math.min(idleExpiresAt, maxAgeExpiresAt) : idleExpiresAt ?? maxAgeExpiresAt;
	return {
		bindingId: resolveBindingKey({
			accountId: params.record.accountId,
			conversationId: params.record.conversationId
		}),
		targetSessionKey: params.record.targetSessionKey,
		targetKind: params.toSessionBindingTargetKind(params.record.targetKind),
		conversation: {
			channel: params.channel,
			accountId: params.record.accountId,
			conversationId: params.record.conversationId
		},
		status: "active",
		boundAt: params.record.boundAt,
		expiresAt,
		metadata: {
			agentId: params.record.agentId,
			label: params.record.label,
			boundBy: params.record.boundBy,
			lastActivityAt: params.record.lastActivityAt,
			idleTimeoutMs: params.idleTimeoutMs,
			maxAgeMs: params.maxAgeMs
		}
	};
}
function createAccountScopedConversationBindingManager(params) {
	const accountId = normalizeAccountId(params.accountId);
	const existing = getState(params.stateKey).managersByAccountId.get(accountId);
	if (existing) return existing;
	const idleTimeoutMs = resolveThreadBindingIdleTimeoutMsForChannel({
		cfg: params.cfg,
		channel: params.channel,
		accountId
	});
	const maxAgeMs = resolveThreadBindingMaxAgeMsForChannel({
		cfg: params.cfg,
		channel: params.channel,
		accountId
	});
	let sessionBindingAdapter;
	const manager = {
		accountId,
		getByConversationId: (conversationId) => getState(params.stateKey).bindingsByAccountConversation.get(resolveBindingKey({
			accountId,
			conversationId
		})),
		listBySessionKey: (targetSessionKey) => [...getState(params.stateKey).bindingsByAccountConversation.values()].filter((record) => record.accountId === accountId && record.targetSessionKey === targetSessionKey),
		bindConversation: ({ conversationId, targetKind, targetSessionKey, metadata }) => {
			const normalizedConversationId = conversationId.trim();
			const normalizedTargetSessionKey = targetSessionKey.trim();
			if (!normalizedConversationId || !normalizedTargetSessionKey) return null;
			const existing = getState(params.stateKey).bindingsByAccountConversation.get(resolveBindingKey({
				accountId,
				conversationId: normalizedConversationId
			}));
			const now = Date.now();
			const record = {
				accountId,
				conversationId: normalizedConversationId,
				targetKind: params.toStoredTargetKind(targetKind),
				targetSessionKey: normalizedTargetSessionKey,
				agentId: typeof metadata?.agentId === "string" && metadata.agentId.trim() ? metadata.agentId.trim() : existing?.agentId ?? resolveAgentIdFromSessionKey(normalizedTargetSessionKey),
				label: typeof metadata?.label === "string" && metadata.label.trim() ? metadata.label.trim() : existing?.label,
				boundBy: typeof metadata?.boundBy === "string" && metadata.boundBy.trim() ? metadata.boundBy.trim() : existing?.boundBy,
				boundAt: now,
				lastActivityAt: now
			};
			getState(params.stateKey).bindingsByAccountConversation.set(resolveBindingKey({
				accountId,
				conversationId: normalizedConversationId
			}), record);
			return record;
		},
		touchConversation: (conversationId, at = Date.now()) => {
			const key = resolveBindingKey({
				accountId,
				conversationId
			});
			const existingRecord = getState(params.stateKey).bindingsByAccountConversation.get(key);
			if (!existingRecord) return null;
			const updated = {
				...existingRecord,
				lastActivityAt: at
			};
			getState(params.stateKey).bindingsByAccountConversation.set(key, updated);
			return updated;
		},
		unbindConversation: (conversationId) => {
			const key = resolveBindingKey({
				accountId,
				conversationId
			});
			const existingRecord = getState(params.stateKey).bindingsByAccountConversation.get(key);
			if (!existingRecord) return null;
			getState(params.stateKey).bindingsByAccountConversation.delete(key);
			return existingRecord;
		},
		unbindBySessionKey: (targetSessionKey) => {
			const removed = [];
			for (const record of getState(params.stateKey).bindingsByAccountConversation.values()) {
				if (record.accountId !== accountId || record.targetSessionKey !== targetSessionKey) continue;
				getState(params.stateKey).bindingsByAccountConversation.delete(resolveBindingKey({
					accountId,
					conversationId: record.conversationId
				}));
				removed.push(record);
			}
			return removed;
		},
		stop: () => {
			for (const key of getState(params.stateKey).bindingsByAccountConversation.keys()) if (key.startsWith(`${accountId}:`)) getState(params.stateKey).bindingsByAccountConversation.delete(key);
			getState(params.stateKey).managersByAccountId.delete(accountId);
			unregisterSessionBindingAdapter({
				channel: params.channel,
				accountId,
				adapter: sessionBindingAdapter
			});
		}
	};
	sessionBindingAdapter = {
		channel: params.channel,
		accountId,
		capabilities: { placements: ["current"] },
		bind: async (input) => {
			if (input.conversation.channel !== params.channel || input.placement === "child") return null;
			const bound = manager.bindConversation({
				conversationId: input.conversation.conversationId,
				targetKind: input.targetKind,
				targetSessionKey: input.targetSessionKey,
				metadata: input.metadata
			});
			return bound ? toSessionBindingRecord({
				channel: params.channel,
				record: bound,
				idleTimeoutMs,
				maxAgeMs,
				toSessionBindingTargetKind: params.toSessionBindingTargetKind
			}) : null;
		},
		listBySession: (targetSessionKey) => manager.listBySessionKey(targetSessionKey).map((entry) => toSessionBindingRecord({
			channel: params.channel,
			record: entry,
			idleTimeoutMs,
			maxAgeMs,
			toSessionBindingTargetKind: params.toSessionBindingTargetKind
		})),
		resolveByConversation: (ref) => {
			if (ref.channel !== params.channel) return null;
			const found = manager.getByConversationId(ref.conversationId);
			return found ? toSessionBindingRecord({
				channel: params.channel,
				record: found,
				idleTimeoutMs,
				maxAgeMs,
				toSessionBindingTargetKind: params.toSessionBindingTargetKind
			}) : null;
		},
		touch: (bindingId, at) => {
			const conversationId = resolveThreadBindingConversationIdFromBindingId({
				accountId,
				bindingId
			});
			if (conversationId) manager.touchConversation(conversationId, at);
		},
		unbind: async (input) => {
			if (input.targetSessionKey?.trim()) return manager.unbindBySessionKey(input.targetSessionKey.trim()).map((entry) => toSessionBindingRecord({
				channel: params.channel,
				record: entry,
				idleTimeoutMs,
				maxAgeMs,
				toSessionBindingTargetKind: params.toSessionBindingTargetKind
			}));
			const conversationId = resolveThreadBindingConversationIdFromBindingId({
				accountId,
				bindingId: input.bindingId
			});
			if (!conversationId) return [];
			const removed = manager.unbindConversation(conversationId);
			return removed ? [toSessionBindingRecord({
				channel: params.channel,
				record: removed,
				idleTimeoutMs,
				maxAgeMs,
				toSessionBindingTargetKind: params.toSessionBindingTargetKind
			})] : [];
		}
	};
	registerSessionBindingAdapter(sessionBindingAdapter);
	getState(params.stateKey).managersByAccountId.set(accountId, manager);
	return manager;
}
function resetAccountScopedConversationBindingsForTests(params) {
	const state = getState(params.stateKey);
	for (const manager of state.managersByAccountId.values()) manager.stop();
	state.managersByAccountId.clear();
	state.bindingsByAccountConversation.clear();
}
//#endregion
export { resetAccountScopedConversationBindingsForTests as n, createAccountScopedConversationBindingManager as t };
