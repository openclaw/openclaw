import { t as __exportAll } from "./rolldown-runtime-C3SqQTfK.js";
import { s as resolveDiscordChannelId } from "./normalize-B-ktw-T_.js";
import { at as getChannel } from "./discord-eZlimVfW.js";
import { N as createDiscordRestClient } from "./send.shared-e9Pd_Em0.js";
import { A as DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS, C as resolveThreadBindingMaxAgeMs$1, D as shouldDefaultPersist, E as setBindingRecord, M as THREAD_BINDINGS_SWEEP_INTERVAL_MS, S as resolveThreadBindingMaxAgeExpiresAt, T as saveBindingsToDisk, _ as resetThreadBindingsForTests, a as THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS, b as resolveThreadBindingIdleTimeoutMs$1, c as getThreadBindingToken, d as normalizeThreadBindingDurationMs, f as normalizeThreadId, g as removeBindingRecord, h as rememberThreadBindingToken, n as MANAGERS_BY_ACCOUNT_ID, o as ensureBindingsLoaded, p as rememberRecentUnboundWebhookEcho, r as PERSIST_BY_ACCOUNT_ID, s as forgetThreadBindingToken, t as BINDINGS_BY_THREAD_ID, u as normalizeTargetKind, v as resolveBindingIdsForSession, w as resolveThreadBindingsPath, x as resolveThreadBindingInactivityExpiresAt, y as resolveBindingRecordKey } from "./thread-bindings.state-Dzu1gCE7.js";
import { a as isThreadArchived, c as summarizeDiscordError, f as resolveThreadBindingFarewellText, i as isDiscordThreadGoneError, m as resolveThreadBindingThreadName, n as createWebhookForChannel, o as maybeSendBindingMessage, r as findReusableWebhook, s as resolveChannelIdForBinding, t as createThreadForBinding } from "./thread-bindings.discord-api-BJF6acLK.js";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { registerSessionBindingAdapter, resolveThreadBindingConversationIdFromBindingId, unregisterSessionBindingAdapter } from "openclaw/plugin-sdk/conversation-runtime";
//#region extensions/discord/src/monitor/thread-bindings.session-adapter.ts
function normalizeChildBindingParentChannelId(raw) {
	const trimmed = normalizeOptionalString(raw) ?? "";
	if (!trimmed) return;
	try {
		return resolveDiscordChannelId(trimmed);
	} catch {
		return;
	}
}
function toSessionBindingTargetKind(raw) {
	return raw === "subagent" ? "subagent" : "session";
}
function toThreadBindingTargetKind(raw) {
	return raw === "subagent" ? "subagent" : "acp";
}
function resolveEffectiveBindingExpiresAt(params) {
	const inactivityExpiresAt = resolveThreadBindingInactivityExpiresAt({
		record: params.record,
		defaultIdleTimeoutMs: params.defaultIdleTimeoutMs
	});
	const maxAgeExpiresAt = resolveThreadBindingMaxAgeExpiresAt({
		record: params.record,
		defaultMaxAgeMs: params.defaultMaxAgeMs
	});
	if (inactivityExpiresAt != null && maxAgeExpiresAt != null) return Math.min(inactivityExpiresAt, maxAgeExpiresAt);
	return inactivityExpiresAt ?? maxAgeExpiresAt;
}
function toSessionBindingRecord(record, defaults) {
	return {
		bindingId: resolveBindingRecordKey({
			accountId: record.accountId,
			threadId: record.threadId
		}) ?? `${record.accountId}:${record.threadId}`,
		targetSessionKey: record.targetSessionKey,
		targetKind: toSessionBindingTargetKind(record.targetKind),
		conversation: {
			channel: "discord",
			accountId: record.accountId,
			conversationId: record.threadId,
			parentConversationId: record.channelId
		},
		status: "active",
		boundAt: record.boundAt,
		expiresAt: resolveEffectiveBindingExpiresAt({
			record,
			defaultIdleTimeoutMs: defaults.idleTimeoutMs,
			defaultMaxAgeMs: defaults.maxAgeMs
		}),
		metadata: {
			agentId: record.agentId,
			label: record.label,
			webhookId: record.webhookId,
			webhookToken: record.webhookToken,
			boundBy: record.boundBy,
			lastActivityAt: record.lastActivityAt,
			idleTimeoutMs: resolveThreadBindingIdleTimeoutMs$1({
				record,
				defaultIdleTimeoutMs: defaults.idleTimeoutMs
			}),
			maxAgeMs: resolveThreadBindingMaxAgeMs$1({
				record,
				defaultMaxAgeMs: defaults.maxAgeMs
			}),
			...record.metadata
		}
	};
}
function createThreadBindingSessionAdapter(params) {
	const toRecord = (entry) => toSessionBindingRecord(entry, params.defaults);
	return {
		channel: "discord",
		accountId: params.accountId,
		capabilities: { placements: ["current", "child"] },
		bind: async (input) => {
			if (input.conversation.channel !== "discord") return null;
			const targetSessionKey = input.targetSessionKey.trim();
			if (!targetSessionKey) return null;
			const conversationId = normalizeOptionalString(input.conversation.conversationId) ?? "";
			const placement = input.placement === "child" ? "child" : "current";
			const metadata = input.metadata ?? {};
			const label = normalizeOptionalString(metadata.label);
			const threadName = typeof metadata.threadName === "string" ? normalizeOptionalString(metadata.threadName) : void 0;
			const introText = typeof metadata.introText === "string" ? normalizeOptionalString(metadata.introText) : void 0;
			const boundBy = typeof metadata.boundBy === "string" ? normalizeOptionalString(metadata.boundBy) : void 0;
			const agentId = typeof metadata.agentId === "string" ? normalizeOptionalString(metadata.agentId) : void 0;
			let threadId;
			let channelId;
			let createThread = false;
			if (placement === "child") {
				createThread = true;
				channelId = normalizeChildBindingParentChannelId(input.conversation.parentConversationId);
				if (!channelId && conversationId) channelId = await resolveChannelIdForBinding({
					cfg: params.resolveCurrentCfg(),
					accountId: params.accountId,
					token: params.resolveCurrentToken(),
					threadId: conversationId
				}) ?? void 0;
			} else threadId = conversationId || void 0;
			const bound = await params.manager.bindTarget({
				threadId,
				channelId,
				createThread,
				threadName,
				targetKind: toThreadBindingTargetKind(input.targetKind),
				targetSessionKey,
				agentId,
				label,
				boundBy,
				introText,
				metadata
			});
			return bound ? toRecord(bound) : null;
		},
		listBySession: (targetSessionKey) => params.manager.listBySessionKey(targetSessionKey).map(toRecord),
		resolveByConversation: (ref) => {
			if (ref.channel !== "discord") return null;
			const binding = params.manager.getByThreadId(ref.conversationId);
			return binding ? toRecord(binding) : null;
		},
		touch: (bindingId, at) => {
			const threadId = resolveThreadBindingConversationIdFromBindingId({
				accountId: params.accountId,
				bindingId
			});
			if (!threadId) return;
			params.manager.touchThread({
				threadId,
				at,
				persist: true
			});
		},
		unbind: async (input) => {
			if (input.targetSessionKey?.trim()) return params.manager.unbindBySessionKey({
				targetSessionKey: input.targetSessionKey,
				reason: input.reason
			}).map(toRecord);
			const threadId = resolveThreadBindingConversationIdFromBindingId({
				accountId: params.accountId,
				bindingId: input.bindingId
			});
			if (!threadId) return [];
			const removed = params.manager.unbindThread({
				threadId,
				reason: input.reason
			});
			return removed ? [toRecord(removed)] : [];
		}
	};
}
//#endregion
//#region extensions/discord/src/monitor/thread-bindings.manager.ts
var thread_bindings_manager_exports = /* @__PURE__ */ __exportAll({
	__testing: () => __testing,
	createNoopThreadBindingManager: () => createNoopThreadBindingManager,
	createThreadBindingManager: () => createThreadBindingManager,
	getThreadBindingManager: () => getThreadBindingManager
});
function registerManager(manager) {
	MANAGERS_BY_ACCOUNT_ID.set(manager.accountId, manager);
}
function unregisterManager(accountId, manager) {
	if (MANAGERS_BY_ACCOUNT_ID.get(accountId) === manager) MANAGERS_BY_ACCOUNT_ID.delete(accountId);
}
const SWEEPERS_BY_ACCOUNT_ID = /* @__PURE__ */ new Map();
function createNoopManager(accountIdRaw) {
	return {
		accountId: normalizeAccountId(accountIdRaw),
		getIdleTimeoutMs: () => DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
		getMaxAgeMs: () => 0,
		getByThreadId: () => void 0,
		getBySessionKey: () => void 0,
		listBySessionKey: () => [],
		listBindings: () => [],
		touchThread: () => null,
		bindTarget: async () => null,
		unbindThread: () => null,
		unbindBySessionKey: () => [],
		stop: () => {}
	};
}
function isDirectConversationBindingId(value) {
	const trimmed = normalizeOptionalString(value);
	return Boolean(trimmed && /^(user:|channel:)/i.test(trimmed));
}
function createThreadBindingManager(params) {
	ensureBindingsLoaded();
	const accountId = normalizeAccountId(params.accountId);
	const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
	if (existing) {
		rememberThreadBindingToken({
			accountId,
			token: params.token
		});
		return existing;
	}
	rememberThreadBindingToken({
		accountId,
		token: params.token
	});
	const persist = params.persist ?? shouldDefaultPersist();
	PERSIST_BY_ACCOUNT_ID.set(accountId, persist);
	const idleTimeoutMs = normalizeThreadBindingDurationMs(params.idleTimeoutMs, DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS);
	const maxAgeMs = normalizeThreadBindingDurationMs(params.maxAgeMs, 0);
	const resolveCurrentCfg = () => getRuntimeConfigSnapshot() ?? params.cfg;
	const resolveCurrentToken = () => getThreadBindingToken(accountId) ?? params.token;
	let sweepTimer = null;
	const runSweepOnce = async () => {
		const bindings = manager.listBindings();
		if (bindings.length === 0) return;
		let rest = null;
		for (const snapshotBinding of bindings) {
			const binding = manager.getByThreadId(snapshotBinding.threadId);
			if (!binding) continue;
			const now = Date.now();
			const inactivityExpiresAt = resolveThreadBindingInactivityExpiresAt({
				record: binding,
				defaultIdleTimeoutMs: idleTimeoutMs
			});
			const maxAgeExpiresAt = resolveThreadBindingMaxAgeExpiresAt({
				record: binding,
				defaultMaxAgeMs: maxAgeMs
			});
			const expirationCandidates = [];
			if (inactivityExpiresAt != null && now >= inactivityExpiresAt) expirationCandidates.push({
				reason: "idle-expired",
				at: inactivityExpiresAt
			});
			if (maxAgeExpiresAt != null && now >= maxAgeExpiresAt) expirationCandidates.push({
				reason: "max-age-expired",
				at: maxAgeExpiresAt
			});
			if (expirationCandidates.length > 0) {
				expirationCandidates.sort((a, b) => a.at - b.at);
				const reason = expirationCandidates[0]?.reason ?? "idle-expired";
				manager.unbindThread({
					threadId: binding.threadId,
					reason,
					sendFarewell: true,
					farewellText: resolveThreadBindingFarewellText({
						reason,
						idleTimeoutMs: resolveThreadBindingIdleTimeoutMs$1({
							record: binding,
							defaultIdleTimeoutMs: idleTimeoutMs
						}),
						maxAgeMs: resolveThreadBindingMaxAgeMs$1({
							record: binding,
							defaultMaxAgeMs: maxAgeMs
						})
					})
				});
				continue;
			}
			if (isDirectConversationBindingId(binding.threadId)) continue;
			if (!rest) try {
				rest = createDiscordRestClient({
					cfg: resolveCurrentCfg(),
					accountId,
					token: resolveCurrentToken()
				}).rest;
			} catch {
				return;
			}
			try {
				const channel = await getChannel(rest, binding.threadId);
				if (!channel || typeof channel !== "object") {
					logVerbose(`discord thread binding sweep probe returned invalid payload for ${binding.threadId}`);
					continue;
				}
				if (isThreadArchived(channel)) manager.unbindThread({
					threadId: binding.threadId,
					reason: "thread-archived",
					sendFarewell: true
				});
			} catch (err) {
				if (isDiscordThreadGoneError(err)) {
					logVerbose(`discord thread binding sweep removing stale binding ${binding.threadId}: ${summarizeDiscordError(err)}`);
					manager.unbindThread({
						threadId: binding.threadId,
						reason: "thread-delete",
						sendFarewell: false
					});
					continue;
				}
				logVerbose(`discord thread binding sweep probe failed for ${binding.threadId}: ${summarizeDiscordError(err)}`);
			}
		}
	};
	SWEEPERS_BY_ACCOUNT_ID.set(accountId, runSweepOnce);
	const manager = {
		accountId,
		getIdleTimeoutMs: () => idleTimeoutMs,
		getMaxAgeMs: () => maxAgeMs,
		getByThreadId: (threadId) => {
			const key = resolveBindingRecordKey({
				accountId,
				threadId
			});
			if (!key) return;
			const entry = BINDINGS_BY_THREAD_ID.get(key);
			if (!entry || entry.accountId !== accountId) return;
			return entry;
		},
		getBySessionKey: (targetSessionKey) => {
			return manager.listBySessionKey(targetSessionKey)[0];
		},
		listBySessionKey: (targetSessionKey) => {
			return resolveBindingIdsForSession({
				targetSessionKey,
				accountId
			}).map((bindingKey) => BINDINGS_BY_THREAD_ID.get(bindingKey)).filter((entry) => Boolean(entry));
		},
		listBindings: () => [...BINDINGS_BY_THREAD_ID.values()].filter((entry) => entry.accountId === accountId),
		touchThread: (touchParams) => {
			const key = resolveBindingRecordKey({
				accountId,
				threadId: touchParams.threadId
			});
			if (!key) return null;
			const existing = BINDINGS_BY_THREAD_ID.get(key);
			if (!existing || existing.accountId !== accountId) return null;
			const now = Date.now();
			const at = typeof touchParams.at === "number" && Number.isFinite(touchParams.at) ? Math.max(0, Math.floor(touchParams.at)) : now;
			const nextRecord = {
				...existing,
				lastActivityAt: Math.max(existing.lastActivityAt || 0, at)
			};
			setBindingRecord(nextRecord);
			if (touchParams.persist ?? persist) saveBindingsToDisk({ minIntervalMs: THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS });
			return nextRecord;
		},
		bindTarget: async (bindParams) => {
			const cfg = resolveCurrentCfg();
			let threadId = normalizeThreadId(bindParams.threadId);
			let channelId = normalizeOptionalString(bindParams.channelId) ?? "";
			const directConversationBinding = isDirectConversationBindingId(threadId) || isDirectConversationBindingId(channelId);
			if (!threadId && bindParams.createThread) {
				if (!channelId) return null;
				const threadName = resolveThreadBindingThreadName({
					agentId: bindParams.agentId,
					label: bindParams.label
				});
				threadId = await createThreadForBinding({
					cfg,
					accountId,
					token: resolveCurrentToken(),
					channelId,
					threadName: normalizeOptionalString(bindParams.threadName) ?? threadName
				}) ?? void 0;
			}
			if (!threadId) return null;
			if (!channelId && directConversationBinding) channelId = threadId;
			if (!channelId) channelId = await resolveChannelIdForBinding({
				cfg,
				accountId,
				token: resolveCurrentToken(),
				threadId,
				channelId: bindParams.channelId
			}) ?? "";
			if (!channelId) return null;
			const existing = manager.getByThreadId(threadId);
			const targetSessionKey = normalizeOptionalString(bindParams.targetSessionKey) ?? "";
			if (!targetSessionKey) return null;
			const targetKind = normalizeTargetKind(bindParams.targetKind, targetSessionKey);
			let webhookId = normalizeOptionalString(bindParams.webhookId) ?? normalizeOptionalString(existing?.webhookId) ?? "";
			let webhookToken = normalizeOptionalString(bindParams.webhookToken) ?? normalizeOptionalString(existing?.webhookToken) ?? "";
			if (!directConversationBinding && (!webhookId || !webhookToken)) {
				const cachedWebhook = findReusableWebhook({
					accountId,
					channelId
				});
				webhookId = cachedWebhook.webhookId ?? "";
				webhookToken = cachedWebhook.webhookToken ?? "";
			}
			if (!directConversationBinding && (!webhookId || !webhookToken)) {
				const createdWebhook = await createWebhookForChannel({
					cfg,
					accountId,
					token: resolveCurrentToken(),
					channelId
				});
				webhookId = createdWebhook.webhookId ?? "";
				webhookToken = createdWebhook.webhookToken ?? "";
			}
			const now = Date.now();
			const record = {
				accountId,
				channelId,
				threadId,
				targetKind,
				targetSessionKey,
				agentId: normalizeOptionalString(bindParams.agentId) ?? normalizeOptionalString(existing?.agentId) ?? resolveAgentIdFromSessionKey(targetSessionKey),
				label: normalizeOptionalString(bindParams.label) ?? normalizeOptionalString(existing?.label),
				webhookId: webhookId || void 0,
				webhookToken: webhookToken || void 0,
				boundBy: normalizeOptionalString(bindParams.boundBy) ?? normalizeOptionalString(existing?.boundBy) ?? "system",
				boundAt: now,
				lastActivityAt: now,
				idleTimeoutMs: typeof existing?.idleTimeoutMs === "number" ? existing.idleTimeoutMs : idleTimeoutMs,
				maxAgeMs: typeof existing?.maxAgeMs === "number" ? existing.maxAgeMs : maxAgeMs,
				metadata: bindParams.metadata && typeof bindParams.metadata === "object" ? {
					...existing?.metadata,
					...bindParams.metadata
				} : existing?.metadata ? { ...existing.metadata } : void 0
			};
			setBindingRecord(record);
			if (persist) saveBindingsToDisk();
			const introText = bindParams.introText?.trim();
			if (introText && cfg) maybeSendBindingMessage({
				cfg,
				record,
				text: introText
			});
			return record;
		},
		unbindThread: (unbindParams) => {
			const bindingKey = resolveBindingRecordKey({
				accountId,
				threadId: unbindParams.threadId
			});
			if (!bindingKey) return null;
			const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
			if (!existing || existing.accountId !== accountId) return null;
			const removed = removeBindingRecord(bindingKey);
			if (!removed) return null;
			rememberRecentUnboundWebhookEcho(removed);
			if (persist) saveBindingsToDisk();
			if (unbindParams.sendFarewell !== false) {
				const cfg = resolveCurrentCfg();
				const farewell = resolveThreadBindingFarewellText({
					reason: unbindParams.reason,
					farewellText: unbindParams.farewellText,
					idleTimeoutMs: resolveThreadBindingIdleTimeoutMs$1({
						record: removed,
						defaultIdleTimeoutMs: idleTimeoutMs
					}),
					maxAgeMs: resolveThreadBindingMaxAgeMs$1({
						record: removed,
						defaultMaxAgeMs: maxAgeMs
					})
				});
				if (cfg) maybeSendBindingMessage({
					cfg,
					record: removed,
					text: farewell,
					preferWebhook: false
				});
			}
			return removed;
		},
		unbindBySessionKey: (unbindParams) => {
			const ids = resolveBindingIdsForSession({
				targetSessionKey: unbindParams.targetSessionKey,
				accountId,
				targetKind: unbindParams.targetKind
			});
			if (ids.length === 0) return [];
			const removed = [];
			for (const bindingKey of ids) {
				const binding = BINDINGS_BY_THREAD_ID.get(bindingKey);
				if (!binding) continue;
				const entry = manager.unbindThread({
					threadId: binding.threadId,
					reason: unbindParams.reason,
					sendFarewell: unbindParams.sendFarewell,
					farewellText: unbindParams.farewellText
				});
				if (entry) removed.push(entry);
			}
			return removed;
		},
		stop: () => {
			if (sweepTimer) {
				clearInterval(sweepTimer);
				sweepTimer = null;
			}
			SWEEPERS_BY_ACCOUNT_ID.delete(accountId);
			unregisterManager(accountId, manager);
			unregisterSessionBindingAdapter({
				channel: "discord",
				accountId,
				adapter: sessionBindingAdapter
			});
			forgetThreadBindingToken(accountId);
		}
	};
	if (params.enableSweeper !== false) {
		sweepTimer = setInterval(() => {
			runSweepOnce();
		}, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
		if (!(process.env.VITEST || false)) sweepTimer.unref?.();
	}
	const sessionBindingAdapter = createThreadBindingSessionAdapter({
		accountId,
		manager,
		defaults: {
			idleTimeoutMs,
			maxAgeMs
		},
		resolveCurrentCfg,
		resolveCurrentToken
	});
	registerSessionBindingAdapter(sessionBindingAdapter);
	registerManager(manager);
	return manager;
}
function createNoopThreadBindingManager(accountId) {
	return createNoopManager(accountId);
}
function getThreadBindingManager(accountId) {
	const normalized = normalizeAccountId(accountId);
	return MANAGERS_BY_ACCOUNT_ID.get(normalized) ?? null;
}
const __testing = {
	resolveThreadBindingsPath,
	resolveThreadBindingThreadName,
	resetThreadBindingsForTests,
	runThreadBindingSweepForAccount: async (accountId) => {
		const sweep = SWEEPERS_BY_ACCOUNT_ID.get(normalizeAccountId(accountId));
		if (sweep) await sweep();
	}
};
//#endregion
export { thread_bindings_manager_exports as a, getThreadBindingManager as i, createNoopThreadBindingManager as n, createThreadBindingManager as r, __testing as t };
