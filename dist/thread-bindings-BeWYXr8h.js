import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as isAcpSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { n as readAcpSessionEntry } from "./session-meta-CZ8B2a4Z.js";
import { i as writeJsonFileAtomically } from "./json-store-ChgPP2Sf.js";
import { i as registerSessionBindingAdapter, o as unregisterSessionBindingAdapter } from "./session-binding-service-B19FMAqz.js";
import { i as resolveThreadBindingEffectiveExpiresAt } from "./thread-bindings-policy-BAuuUJk1.js";
import "./error-runtime-DGHc7DZw.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./state-paths-iYyQ0JoC.js";
import "./routing-79DRZvfm.js";
import { t as resolveTelegramToken } from "./token-CEwSHtbY.js";
import "./conversation-runtime-guwDSNIo.js";
import { t as resolveThreadBindingConversationIdFromBindingId } from "./thread-binding-id-DKmKA6Dw.js";
import { t as formatThreadBindingDurationLabel } from "./thread-bindings-messages-D73K8IGt.js";
import "./acp-runtime-Dk1AA16X.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region extensions/telegram/src/thread-bindings.ts
const DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS = 1440 * 60 * 1e3;
const DEFAULT_THREAD_BINDING_MAX_AGE_MS = 0;
const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 6e4;
const STORE_VERSION = 1;
let telegramSendModulePromise;
async function loadTelegramSendModule() {
	telegramSendModulePromise ??= import("./send-DC1zAoDQ.js");
	return await telegramSendModulePromise;
}
/**
* Keep Telegram thread binding state shared across bundled chunks so routing,
* binding lookups, and binding mutations all observe the same live registry.
*/
const TELEGRAM_THREAD_BINDINGS_STATE_KEY = Symbol.for("openclaw.telegramThreadBindingsState");
let threadBindingsState;
function getThreadBindingsState() {
	if (!threadBindingsState) {
		const globalStore = globalThis;
		threadBindingsState = globalStore[TELEGRAM_THREAD_BINDINGS_STATE_KEY] ?? {
			managersByAccountId: /* @__PURE__ */ new Map(),
			bindingsByAccountConversation: /* @__PURE__ */ new Map(),
			persistQueueByAccountId: /* @__PURE__ */ new Map()
		};
		globalStore[TELEGRAM_THREAD_BINDINGS_STATE_KEY] = threadBindingsState;
	}
	return threadBindingsState;
}
function normalizeDurationMs(raw, fallback) {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	return Math.max(0, Math.floor(raw));
}
function resolveBindingKey(params) {
	return `${params.accountId}:${params.conversationId}`;
}
function toSessionBindingTargetKind(raw) {
	return raw === "subagent" ? "subagent" : "session";
}
function toTelegramTargetKind(raw) {
	return raw === "subagent" ? "subagent" : "acp";
}
function toSessionBindingRecord(record, defaults) {
	return {
		bindingId: resolveBindingKey({
			accountId: record.accountId,
			conversationId: record.conversationId
		}),
		targetSessionKey: record.targetSessionKey,
		targetKind: toSessionBindingTargetKind(record.targetKind),
		conversation: {
			channel: "telegram",
			accountId: record.accountId,
			conversationId: record.conversationId
		},
		status: "active",
		boundAt: record.boundAt,
		expiresAt: resolveThreadBindingEffectiveExpiresAt({
			record,
			defaultIdleTimeoutMs: defaults.idleTimeoutMs,
			defaultMaxAgeMs: defaults.maxAgeMs
		}),
		metadata: {
			agentId: record.agentId,
			label: record.label,
			boundBy: record.boundBy,
			lastActivityAt: record.lastActivityAt,
			idleTimeoutMs: typeof record.idleTimeoutMs === "number" ? Math.max(0, Math.floor(record.idleTimeoutMs)) : defaults.idleTimeoutMs,
			maxAgeMs: typeof record.maxAgeMs === "number" ? Math.max(0, Math.floor(record.maxAgeMs)) : defaults.maxAgeMs,
			...record.metadata
		}
	};
}
function fromSessionBindingInput(params) {
	const now = Date.now();
	const metadata = params.input.metadata ?? {};
	const existing = getThreadBindingsState().bindingsByAccountConversation.get(resolveBindingKey({
		accountId: params.accountId,
		conversationId: params.input.conversationId
	}));
	const record = {
		accountId: params.accountId,
		conversationId: params.input.conversationId,
		targetKind: toTelegramTargetKind(params.input.targetKind),
		targetSessionKey: params.input.targetSessionKey,
		agentId: typeof metadata.agentId === "string" && metadata.agentId.trim() ? metadata.agentId.trim() : existing?.agentId,
		label: typeof metadata.label === "string" && metadata.label.trim() ? metadata.label.trim() : existing?.label,
		boundBy: typeof metadata.boundBy === "string" && metadata.boundBy.trim() ? metadata.boundBy.trim() : existing?.boundBy,
		boundAt: now,
		lastActivityAt: now,
		metadata: {
			...existing?.metadata,
			...metadata
		}
	};
	if (typeof metadata.idleTimeoutMs === "number" && Number.isFinite(metadata.idleTimeoutMs)) record.idleTimeoutMs = Math.max(0, Math.floor(metadata.idleTimeoutMs));
	else if (typeof existing?.idleTimeoutMs === "number") record.idleTimeoutMs = existing.idleTimeoutMs;
	if (typeof metadata.maxAgeMs === "number" && Number.isFinite(metadata.maxAgeMs)) record.maxAgeMs = Math.max(0, Math.floor(metadata.maxAgeMs));
	else if (typeof existing?.maxAgeMs === "number") record.maxAgeMs = existing.maxAgeMs;
	return record;
}
function resolveBindingsPath(accountId, env = process.env) {
	const stateDir = resolveStateDir(env, os.homedir);
	return path.join(stateDir, "telegram", `thread-bindings-${accountId}.json`);
}
function summarizeLifecycleForLog(record, defaults) {
	const idleTimeoutMs = typeof record.idleTimeoutMs === "number" ? record.idleTimeoutMs : defaults.idleTimeoutMs;
	const maxAgeMs = typeof record.maxAgeMs === "number" ? record.maxAgeMs : defaults.maxAgeMs;
	return `idle=${formatThreadBindingDurationLabel(Math.max(0, Math.floor(idleTimeoutMs)))} maxAge=${formatThreadBindingDurationLabel(Math.max(0, Math.floor(maxAgeMs)))}`;
}
function loadBindingsFromDisk(accountId) {
	const filePath = resolveBindingsPath(accountId);
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.bindings)) return [];
		const bindings = [];
		for (const entry of parsed.bindings) {
			const conversationId = normalizeOptionalString(entry?.conversationId);
			const targetSessionKey = normalizeOptionalString(entry?.targetSessionKey) ?? "";
			const targetKind = entry?.targetKind === "subagent" ? "subagent" : "acp";
			if (!conversationId || !targetSessionKey) continue;
			const boundAt = typeof entry?.boundAt === "number" && Number.isFinite(entry.boundAt) ? Math.floor(entry.boundAt) : Date.now();
			const record = {
				accountId,
				conversationId,
				targetSessionKey,
				targetKind,
				boundAt,
				lastActivityAt: typeof entry?.lastActivityAt === "number" && Number.isFinite(entry.lastActivityAt) ? Math.floor(entry.lastActivityAt) : boundAt
			};
			if (typeof entry?.idleTimeoutMs === "number" && Number.isFinite(entry.idleTimeoutMs)) record.idleTimeoutMs = Math.max(0, Math.floor(entry.idleTimeoutMs));
			if (typeof entry?.maxAgeMs === "number" && Number.isFinite(entry.maxAgeMs)) record.maxAgeMs = Math.max(0, Math.floor(entry.maxAgeMs));
			if (typeof entry?.agentId === "string" && entry.agentId.trim()) record.agentId = entry.agentId.trim();
			if (typeof entry?.label === "string" && entry.label.trim()) record.label = entry.label.trim();
			if (typeof entry?.boundBy === "string" && entry.boundBy.trim()) record.boundBy = entry.boundBy.trim();
			if (entry?.metadata && typeof entry.metadata === "object") record.metadata = { ...entry.metadata };
			bindings.push(record);
		}
		return bindings;
	} catch (err) {
		if (err.code !== "ENOENT") logVerbose(`telegram thread bindings load failed (${accountId}): ${String(err)}`);
		return [];
	}
}
async function persistBindingsToDisk(params) {
	if (!params.persist) return;
	const payload = {
		version: STORE_VERSION,
		bindings: params.bindings ?? [...getThreadBindingsState().bindingsByAccountConversation.values()].filter((entry) => entry.accountId === params.accountId)
	};
	await writeJsonFileAtomically(resolveBindingsPath(params.accountId), payload);
}
function listBindingsForAccount(accountId) {
	return [...getThreadBindingsState().bindingsByAccountConversation.values()].filter((entry) => entry.accountId === accountId);
}
function enqueuePersistBindings(params) {
	if (!params.persist) return Promise.resolve();
	const next = (getThreadBindingsState().persistQueueByAccountId.get(params.accountId) ?? Promise.resolve()).catch(() => void 0).then(async () => {
		await persistBindingsToDisk(params);
	});
	getThreadBindingsState().persistQueueByAccountId.set(params.accountId, next);
	const cleanup = () => {
		if (getThreadBindingsState().persistQueueByAccountId.get(params.accountId) === next) getThreadBindingsState().persistQueueByAccountId.delete(params.accountId);
	};
	next.then(cleanup, cleanup);
	return next;
}
function persistBindingsSafely(params) {
	enqueuePersistBindings(params).catch((err) => {
		logVerbose(`telegram thread bindings persist failed (${params.accountId}, ${params.reason}): ${String(err)}`);
	});
}
function normalizeTimestampMs(raw) {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return Date.now();
	return Math.max(0, Math.floor(raw));
}
function shouldExpireByIdle(params) {
	const idleTimeoutMs = typeof params.record.idleTimeoutMs === "number" ? Math.max(0, Math.floor(params.record.idleTimeoutMs)) : params.defaultIdleTimeoutMs;
	if (idleTimeoutMs <= 0) return false;
	return params.now >= Math.max(params.record.lastActivityAt, params.record.boundAt) + idleTimeoutMs;
}
function shouldExpireByMaxAge(params) {
	const maxAgeMs = typeof params.record.maxAgeMs === "number" ? Math.max(0, Math.floor(params.record.maxAgeMs)) : params.defaultMaxAgeMs;
	if (maxAgeMs <= 0) return false;
	return params.now >= params.record.boundAt + maxAgeMs;
}
function createTelegramThreadBindingManager(params) {
	const accountId = normalizeAccountId(params.accountId);
	const existing = getThreadBindingsState().managersByAccountId.get(accountId);
	if (existing) return existing;
	const persist = params.persist ?? true;
	const idleTimeoutMs = normalizeDurationMs(params.idleTimeoutMs, DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS);
	const maxAgeMs = normalizeDurationMs(params.maxAgeMs, DEFAULT_THREAD_BINDING_MAX_AGE_MS);
	const loaded = loadBindingsFromDisk(accountId);
	for (const entry of loaded) {
		const key = resolveBindingKey({
			accountId,
			conversationId: entry.conversationId
		});
		getThreadBindingsState().bindingsByAccountConversation.set(key, {
			...entry,
			accountId
		});
	}
	const acpSessionKeys = /* @__PURE__ */ new Set();
	for (const binding of getThreadBindingsState().bindingsByAccountConversation.values()) {
		if (binding.targetKind !== "acp" || !isAcpSessionKey(binding.targetSessionKey)) continue;
		acpSessionKeys.add(binding.targetSessionKey);
	}
	const staleSessionKeys = /* @__PURE__ */ new Set();
	for (const targetSessionKey of acpSessionKeys) {
		const sessionEntry = readAcpSessionEntry({ sessionKey: targetSessionKey });
		if (!sessionEntry || sessionEntry.storeReadFailed) continue;
		if (!sessionEntry.entry || sessionEntry.entry.status === "failed" || sessionEntry.entry.status === "killed" || sessionEntry.entry.status === "timeout" || sessionEntry.entry.acp?.state === "error") staleSessionKeys.add(targetSessionKey);
	}
	let needsPersist = false;
	for (const sessionKey of staleSessionKeys) {
		const bindingsToRemove = listBindingsForAccount(accountId).filter((b) => b.targetSessionKey === sessionKey);
		for (const binding of bindingsToRemove) getThreadBindingsState().bindingsByAccountConversation.delete(resolveBindingKey({
			accountId,
			conversationId: binding.conversationId
		}));
		if (bindingsToRemove.length > 0) {
			needsPersist = true;
			logVerbose(`telegram thread binding: cleaned up ${bindingsToRemove.length} stale binding(s) for session ${sessionKey}`);
		}
	}
	if (needsPersist && persist) persistBindingsSafely({
		accountId,
		persist: true,
		bindings: listBindingsForAccount(accountId),
		reason: "cleanup-stale"
	});
	let sweepTimer = null;
	const manager = {
		accountId,
		shouldPersistMutations: () => persist,
		getIdleTimeoutMs: () => idleTimeoutMs,
		getMaxAgeMs: () => maxAgeMs,
		getByConversationId: (conversationIdRaw) => {
			const conversationId = normalizeOptionalString(conversationIdRaw);
			if (!conversationId) return;
			return getThreadBindingsState().bindingsByAccountConversation.get(resolveBindingKey({
				accountId,
				conversationId
			}));
		},
		listBySessionKey: (targetSessionKeyRaw) => {
			const targetSessionKey = targetSessionKeyRaw.trim();
			if (!targetSessionKey) return [];
			return listBindingsForAccount(accountId).filter((entry) => entry.targetSessionKey === targetSessionKey);
		},
		listBindings: () => listBindingsForAccount(accountId),
		touchConversation: (conversationIdRaw, at) => {
			const conversationId = normalizeOptionalString(conversationIdRaw);
			if (!conversationId) return null;
			const key = resolveBindingKey({
				accountId,
				conversationId
			});
			const existing = getThreadBindingsState().bindingsByAccountConversation.get(key);
			if (!existing) return null;
			const nextRecord = {
				...existing,
				lastActivityAt: normalizeTimestampMs(at ?? Date.now())
			};
			getThreadBindingsState().bindingsByAccountConversation.set(key, nextRecord);
			persistBindingsSafely({
				accountId,
				persist: manager.shouldPersistMutations(),
				bindings: listBindingsForAccount(accountId),
				reason: "touch"
			});
			return nextRecord;
		},
		unbindConversation: (unbindParams) => {
			const conversationId = normalizeOptionalString(unbindParams.conversationId);
			if (!conversationId) return null;
			const key = resolveBindingKey({
				accountId,
				conversationId
			});
			const removed = getThreadBindingsState().bindingsByAccountConversation.get(key) ?? null;
			if (!removed) return null;
			getThreadBindingsState().bindingsByAccountConversation.delete(key);
			persistBindingsSafely({
				accountId,
				persist: manager.shouldPersistMutations(),
				bindings: listBindingsForAccount(accountId),
				reason: "unbind-conversation"
			});
			return removed;
		},
		unbindBySessionKey: (unbindParams) => {
			const targetSessionKey = unbindParams.targetSessionKey.trim();
			if (!targetSessionKey) return [];
			const removed = [];
			for (const entry of listBindingsForAccount(accountId)) {
				if (entry.targetSessionKey !== targetSessionKey) continue;
				const key = resolveBindingKey({
					accountId,
					conversationId: entry.conversationId
				});
				getThreadBindingsState().bindingsByAccountConversation.delete(key);
				removed.push(entry);
			}
			if (removed.length > 0) persistBindingsSafely({
				accountId,
				persist: manager.shouldPersistMutations(),
				bindings: listBindingsForAccount(accountId),
				reason: "unbind-session"
			});
			return removed;
		},
		stop: () => {
			if (sweepTimer) {
				clearInterval(sweepTimer);
				sweepTimer = null;
			}
			unregisterSessionBindingAdapter({
				channel: "telegram",
				accountId,
				adapter: sessionBindingAdapter
			});
			if (getThreadBindingsState().managersByAccountId.get(accountId) === manager) getThreadBindingsState().managersByAccountId.delete(accountId);
		}
	};
	const sessionBindingAdapter = {
		channel: "telegram",
		accountId,
		capabilities: { placements: ["current", "child"] },
		bind: async (input) => {
			if (input.conversation.channel !== "telegram") return null;
			const targetSessionKey = input.targetSessionKey.trim();
			if (!targetSessionKey) return null;
			const placement = input.placement === "child" ? "child" : "current";
			const metadata = input.metadata ?? {};
			let conversationId;
			if (placement === "child") {
				const rawConversationId = input.conversation.conversationId?.trim() ?? "";
				let chatId = (input.conversation.parentConversationId?.trim() ?? "") || rawConversationId;
				if (!chatId) {
					logVerbose(`telegram: child bind failed: could not resolve group chat ID from conversationId=${rawConversationId}`);
					return null;
				}
				if (!chatId.startsWith("-")) {
					logVerbose(`telegram: child bind failed: conversationId "${chatId}" looks like a bare topic ID, not a group chat ID (expected to start with "-"). Provide a full chatId:topic:topicId conversationId or set parentConversationId to the group chat ID.`);
					return null;
				}
				const threadName = (normalizeOptionalString(metadata.threadName) ?? "") || (normalizeOptionalString(metadata.label) ?? "") || `Agent: ${targetSessionKey.split(":").pop()}`;
				try {
					const tokenResolution = resolveTelegramToken(params.cfg, { accountId });
					if (!tokenResolution.token) return null;
					const { createForumTopicTelegram } = await loadTelegramSendModule();
					const result = await createForumTopicTelegram(chatId, threadName, {
						cfg: params.cfg,
						token: tokenResolution.token,
						accountId
					});
					conversationId = `${result.chatId}:topic:${result.topicId}`;
				} catch (err) {
					logVerbose(`telegram: child thread-binding failed for ${chatId}: ${formatErrorMessage(err)}`);
					return null;
				}
			} else conversationId = normalizeOptionalString(input.conversation.conversationId);
			if (!conversationId) return null;
			const record = fromSessionBindingInput({
				accountId,
				input: {
					targetSessionKey,
					targetKind: input.targetKind,
					conversationId,
					metadata: input.metadata
				}
			});
			getThreadBindingsState().bindingsByAccountConversation.set(resolveBindingKey({
				accountId,
				conversationId
			}), record);
			await enqueuePersistBindings({
				accountId,
				persist: manager.shouldPersistMutations(),
				bindings: listBindingsForAccount(accountId)
			});
			logVerbose(`telegram: bound conversation ${conversationId} -> ${targetSessionKey} (${summarizeLifecycleForLog(record, {
				idleTimeoutMs,
				maxAgeMs
			})})`);
			return toSessionBindingRecord(record, {
				idleTimeoutMs,
				maxAgeMs
			});
		},
		listBySession: (targetSessionKeyRaw) => {
			const targetSessionKey = targetSessionKeyRaw.trim();
			if (!targetSessionKey) return [];
			return manager.listBySessionKey(targetSessionKey).map((entry) => toSessionBindingRecord(entry, {
				idleTimeoutMs,
				maxAgeMs
			}));
		},
		resolveByConversation: (ref) => {
			if (ref.channel !== "telegram") return null;
			const conversationId = normalizeOptionalString(ref.conversationId);
			if (!conversationId) return null;
			const record = manager.getByConversationId(conversationId);
			return record ? toSessionBindingRecord(record, {
				idleTimeoutMs,
				maxAgeMs
			}) : null;
		},
		touch: (bindingId, at) => {
			const conversationId = resolveThreadBindingConversationIdFromBindingId({
				accountId,
				bindingId
			});
			if (!conversationId) return;
			manager.touchConversation(conversationId, at);
		},
		unbind: async (input) => {
			if (input.targetSessionKey?.trim()) {
				const removed = manager.unbindBySessionKey({
					targetSessionKey: input.targetSessionKey,
					reason: input.reason,
					sendFarewell: false
				});
				if (removed.length > 0) await enqueuePersistBindings({
					accountId,
					persist: manager.shouldPersistMutations(),
					bindings: listBindingsForAccount(accountId)
				});
				return removed.map((entry) => toSessionBindingRecord(entry, {
					idleTimeoutMs,
					maxAgeMs
				}));
			}
			const conversationId = resolveThreadBindingConversationIdFromBindingId({
				accountId,
				bindingId: input.bindingId
			});
			if (!conversationId) return [];
			const removed = manager.unbindConversation({
				conversationId,
				reason: input.reason,
				sendFarewell: false
			});
			if (removed) await enqueuePersistBindings({
				accountId,
				persist: manager.shouldPersistMutations(),
				bindings: listBindingsForAccount(accountId)
			});
			return removed ? [toSessionBindingRecord(removed, {
				idleTimeoutMs,
				maxAgeMs
			})] : [];
		}
	};
	registerSessionBindingAdapter(sessionBindingAdapter);
	if (params.enableSweeper !== false) {
		sweepTimer = setInterval(() => {
			const now = Date.now();
			for (const record of listBindingsForAccount(accountId)) {
				const idleExpired = shouldExpireByIdle({
					now,
					record,
					defaultIdleTimeoutMs: idleTimeoutMs
				});
				const maxAgeExpired = shouldExpireByMaxAge({
					now,
					record,
					defaultMaxAgeMs: maxAgeMs
				});
				if (!idleExpired && !maxAgeExpired) continue;
				manager.unbindConversation({
					conversationId: record.conversationId,
					reason: idleExpired ? "idle-expired" : "max-age-expired",
					sendFarewell: false
				});
			}
		}, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
		sweepTimer.unref?.();
	}
	getThreadBindingsState().managersByAccountId.set(accountId, manager);
	return manager;
}
function getTelegramThreadBindingManager(accountId) {
	return getThreadBindingsState().managersByAccountId.get(normalizeAccountId(accountId)) ?? null;
}
function updateTelegramBindingsBySessionKey(params) {
	const targetSessionKey = params.targetSessionKey.trim();
	if (!targetSessionKey) return [];
	const now = Date.now();
	const updated = [];
	for (const entry of params.manager.listBySessionKey(targetSessionKey)) {
		const key = resolveBindingKey({
			accountId: params.manager.accountId,
			conversationId: entry.conversationId
		});
		const next = params.update(entry, now);
		getThreadBindingsState().bindingsByAccountConversation.set(key, next);
		updated.push(next);
	}
	if (updated.length > 0) persistBindingsSafely({
		accountId: params.manager.accountId,
		persist: params.manager.shouldPersistMutations(),
		bindings: listBindingsForAccount(params.manager.accountId),
		reason: "session-lifecycle-update"
	});
	return updated;
}
function setTelegramThreadBindingIdleTimeoutBySessionKey(params) {
	const manager = getTelegramThreadBindingManager(params.accountId);
	if (!manager) return [];
	const idleTimeoutMs = normalizeDurationMs(params.idleTimeoutMs, 0);
	return updateTelegramBindingsBySessionKey({
		manager,
		targetSessionKey: params.targetSessionKey,
		update: (entry, now) => ({
			...entry,
			idleTimeoutMs,
			lastActivityAt: now
		})
	});
}
function setTelegramThreadBindingMaxAgeBySessionKey(params) {
	const manager = getTelegramThreadBindingManager(params.accountId);
	if (!manager) return [];
	const maxAgeMs = normalizeDurationMs(params.maxAgeMs, 0);
	return updateTelegramBindingsBySessionKey({
		manager,
		targetSessionKey: params.targetSessionKey,
		update: (entry, now) => ({
			...entry,
			maxAgeMs,
			lastActivityAt: now
		})
	});
}
async function resetTelegramThreadBindingsForTests() {
	for (const manager of getThreadBindingsState().managersByAccountId.values()) manager.stop();
	const pendingPersists = [...getThreadBindingsState().persistQueueByAccountId.values()];
	if (pendingPersists.length > 0) await Promise.allSettled(pendingPersists);
	getThreadBindingsState().persistQueueByAccountId.clear();
	getThreadBindingsState().managersByAccountId.clear();
	getThreadBindingsState().bindingsByAccountConversation.clear();
}
//#endregion
export { setTelegramThreadBindingMaxAgeBySessionKey as a, setTelegramThreadBindingIdleTimeoutBySessionKey as i, getTelegramThreadBindingManager as n, resetTelegramThreadBindingsForTests as r, createTelegramThreadBindingManager as t };
