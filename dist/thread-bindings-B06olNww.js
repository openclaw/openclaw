import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { i as writeJsonFileAtomically, n as readJsonFileWithFallback } from "./json-store-ChgPP2Sf.js";
import { i as registerSessionBindingAdapter, o as unregisterSessionBindingAdapter } from "./session-binding-service-B19FMAqz.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { n as resolveThreadBindingFarewellText } from "./thread-bindings-messages-D73K8IGt.js";
import "./thread-bindings-session-runtime-B_bKWdzh.js";
import { a as listBindingsForAccount, c as resolveBindingKey, f as setMatrixThreadBindingManagerEntry, h as toSessionBindingRecord, l as resolveEffectiveBindingExpiry, m as toMatrixBindingTargetKind, o as removeBindingRecord, r as getMatrixThreadBindingManagerEntry, t as deleteMatrixThreadBindingManagerEntry, u as setBindingRecord } from "./thread-bindings-shared-ZCOgSHlI.js";
import { i as resolveMatrixStateFilePath, t as claimCurrentTokenStorageState } from "./storage-BVAqboeh.js";
import { a as sendMessageMatrix } from "./send-xdKxcj70.js";
import path from "node:path";
//#region extensions/matrix/src/matrix/thread-bindings.ts
const STORE_VERSION = 1;
const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 6e4;
const TOUCH_PERSIST_DELAY_MS = 3e4;
function resolveBindingsPath(params) {
	return resolveMatrixStateFilePath({
		auth: params.auth,
		accountId: params.accountId,
		env: params.env,
		stateDir: params.stateDir,
		filename: "thread-bindings.json"
	});
}
async function loadBindingsFromDisk(filePath, accountId) {
	const { value } = await readJsonFileWithFallback(filePath, null);
	if (value?.version !== STORE_VERSION || !Array.isArray(value.bindings)) return [];
	const loaded = [];
	for (const entry of value.bindings) {
		const conversationId = normalizeOptionalString(entry?.conversationId);
		const parentConversationId = normalizeOptionalString(entry?.parentConversationId);
		const targetSessionKey = normalizeOptionalString(entry?.targetSessionKey) ?? "";
		if (!conversationId || !targetSessionKey) continue;
		const boundAt = typeof entry?.boundAt === "number" && Number.isFinite(entry.boundAt) ? Math.floor(entry.boundAt) : Date.now();
		const lastActivityAt = typeof entry?.lastActivityAt === "number" && Number.isFinite(entry.lastActivityAt) ? Math.floor(entry.lastActivityAt) : boundAt;
		loaded.push({
			accountId,
			conversationId,
			...parentConversationId ? { parentConversationId } : {},
			targetKind: entry?.targetKind === "subagent" ? "subagent" : "acp",
			targetSessionKey,
			agentId: normalizeOptionalString(entry?.agentId) || void 0,
			label: normalizeOptionalString(entry?.label) || void 0,
			boundBy: normalizeOptionalString(entry?.boundBy) || void 0,
			boundAt,
			lastActivityAt: Math.max(lastActivityAt, boundAt),
			idleTimeoutMs: typeof entry?.idleTimeoutMs === "number" && Number.isFinite(entry.idleTimeoutMs) ? Math.max(0, Math.floor(entry.idleTimeoutMs)) : void 0,
			maxAgeMs: typeof entry?.maxAgeMs === "number" && Number.isFinite(entry.maxAgeMs) ? Math.max(0, Math.floor(entry.maxAgeMs)) : void 0
		});
	}
	return loaded;
}
function toStoredBindingsState(bindings) {
	return {
		version: STORE_VERSION,
		bindings: [...bindings].toSorted((a, b) => a.boundAt - b.boundAt)
	};
}
async function persistBindingsSnapshot(filePath, bindings) {
	await writeJsonFileAtomically(filePath, toStoredBindingsState(bindings));
	claimCurrentTokenStorageState({ rootDir: path.dirname(filePath) });
}
function buildMatrixBindingIntroText(params) {
	const introText = normalizeOptionalString(params.metadata?.introText);
	if (introText) return introText;
	const label = normalizeOptionalString(params.metadata?.label);
	const agentId = normalizeOptionalString(params.metadata?.agentId) || resolveAgentIdFromSessionKey(params.targetSessionKey);
	return `⚙️ ${label || agentId || "session"} session active. Messages here go directly to this session.`;
}
async function sendBindingMessage(params) {
	const trimmed = params.text.trim();
	if (!trimmed) return null;
	return (await sendMessageMatrix(`room:${params.roomId}`, trimmed, {
		cfg: params.cfg,
		client: params.client,
		accountId: params.accountId,
		...params.threadId ? { threadId: params.threadId } : {}
	})).messageId || null;
}
async function sendFarewellMessage(params) {
	const roomId = params.record.parentConversationId ?? params.record.conversationId;
	const idleTimeoutMs = typeof params.record.idleTimeoutMs === "number" ? params.record.idleTimeoutMs : params.defaultIdleTimeoutMs;
	const maxAgeMs = typeof params.record.maxAgeMs === "number" ? params.record.maxAgeMs : params.defaultMaxAgeMs;
	const farewellText = resolveThreadBindingFarewellText({
		reason: params.reason,
		idleTimeoutMs,
		maxAgeMs
	});
	await sendBindingMessage({
		cfg: params.cfg,
		client: params.client,
		accountId: params.accountId,
		roomId,
		threadId: params.record.parentConversationId && params.record.parentConversationId !== params.record.conversationId ? params.record.conversationId : void 0,
		text: farewellText
	}).catch(() => {});
}
async function createMatrixThreadBindingManager(params) {
	if (params.auth.accountId !== params.accountId) throw new Error(`Matrix thread binding account mismatch: requested ${params.accountId}, auth resolved ${params.auth.accountId}`);
	const filePath = resolveBindingsPath({
		auth: params.auth,
		accountId: params.accountId,
		env: params.env,
		stateDir: params.stateDir
	});
	const existingEntry = getMatrixThreadBindingManagerEntry(params.accountId);
	if (existingEntry) {
		if (existingEntry.filePath === filePath) return existingEntry.manager;
		existingEntry.manager.stop();
	}
	const loaded = await loadBindingsFromDisk(filePath, params.accountId);
	for (const record of loaded) setBindingRecord(record);
	let persistQueue = Promise.resolve();
	const enqueuePersist = (bindings) => {
		const snapshot = bindings ?? listBindingsForAccount(params.accountId);
		const next = persistQueue.catch(() => {}).then(async () => {
			await persistBindingsSnapshot(filePath, snapshot);
		});
		persistQueue = next;
		return next;
	};
	const persist = async () => await enqueuePersist();
	const persistSafely = (reason, bindings) => {
		enqueuePersist(bindings).catch((err) => {
			params.logVerboseMessage?.(`matrix: failed persisting thread bindings account=${params.accountId} action=${reason}: ${String(err)}`);
		});
	};
	const defaults = {
		idleTimeoutMs: params.idleTimeoutMs,
		maxAgeMs: params.maxAgeMs
	};
	let persistTimer = null;
	const schedulePersist = (delayMs) => {
		if (persistTimer) return;
		persistTimer = setTimeout(() => {
			persistTimer = null;
			persistSafely("delayed-touch");
		}, delayMs);
		persistTimer.unref?.();
	};
	const updateBindingsBySessionKey = (input) => {
		const targetSessionKey = input.targetSessionKey.trim();
		if (!targetSessionKey) return [];
		const now = Date.now();
		const nextBindings = listBindingsForAccount(params.accountId).filter((entry) => entry.targetSessionKey === targetSessionKey).map((entry) => input.update(entry, now));
		if (nextBindings.length === 0) return [];
		for (const entry of nextBindings) setBindingRecord(entry);
		persistSafely(input.persistReason);
		return nextBindings;
	};
	const manager = {
		accountId: params.accountId,
		getIdleTimeoutMs: () => defaults.idleTimeoutMs,
		getMaxAgeMs: () => defaults.maxAgeMs,
		persist,
		getByConversation: ({ conversationId, parentConversationId }) => listBindingsForAccount(params.accountId).find((entry) => {
			if (entry.conversationId !== conversationId.trim()) return false;
			if (!parentConversationId) return true;
			return (entry.parentConversationId ?? "") === parentConversationId.trim();
		}),
		listBySessionKey: (targetSessionKey) => listBindingsForAccount(params.accountId).filter((entry) => entry.targetSessionKey === targetSessionKey.trim()),
		listBindings: () => listBindingsForAccount(params.accountId),
		touchBinding: (bindingId, at) => {
			const record = listBindingsForAccount(params.accountId).find((entry) => resolveBindingKey(entry) === bindingId.trim());
			if (!record) return null;
			const nextRecord = {
				...record,
				lastActivityAt: typeof at === "number" && Number.isFinite(at) ? Math.max(record.lastActivityAt, Math.floor(at)) : Date.now()
			};
			setBindingRecord(nextRecord);
			schedulePersist(TOUCH_PERSIST_DELAY_MS);
			return nextRecord;
		},
		setIdleTimeoutBySessionKey: ({ targetSessionKey, idleTimeoutMs }) => {
			return updateBindingsBySessionKey({
				targetSessionKey,
				persistReason: "idle-timeout-update",
				update: (entry, now) => ({
					...entry,
					idleTimeoutMs: Math.max(0, Math.floor(idleTimeoutMs)),
					lastActivityAt: now
				})
			});
		},
		setMaxAgeBySessionKey: ({ targetSessionKey, maxAgeMs }) => {
			return updateBindingsBySessionKey({
				targetSessionKey,
				persistReason: "max-age-update",
				update: (entry, now) => ({
					...entry,
					maxAgeMs: Math.max(0, Math.floor(maxAgeMs)),
					lastActivityAt: now
				})
			});
		},
		stop: () => {
			if (sweepTimer) clearInterval(sweepTimer);
			if (persistTimer) {
				clearTimeout(persistTimer);
				persistTimer = null;
				persistSafely("shutdown-flush");
			}
			unregisterSessionBindingAdapter({
				channel: "matrix",
				accountId: params.accountId,
				adapter: sessionBindingAdapter
			});
			if (getMatrixThreadBindingManagerEntry(params.accountId)?.manager === manager) deleteMatrixThreadBindingManagerEntry(params.accountId);
			for (const record of listBindingsForAccount(params.accountId)) removeBindingRecord(record);
		}
	};
	let sweepTimer = null;
	const removeRecords = (records) => {
		if (records.length === 0) return [];
		return records.map((record) => removeBindingRecord(record)).filter((record) => Boolean(record));
	};
	const sendFarewellMessages = async (removed, reason) => {
		await Promise.all(removed.map(async (record) => {
			await sendFarewellMessage({
				cfg: params.cfg,
				client: params.client,
				accountId: params.accountId,
				record,
				defaultIdleTimeoutMs: defaults.idleTimeoutMs,
				defaultMaxAgeMs: defaults.maxAgeMs,
				reason: typeof reason === "function" ? reason(record) : reason
			});
		}));
	};
	const unbindRecords = async (records, reason) => {
		const removed = removeRecords(records);
		if (removed.length === 0) return [];
		await persist();
		await sendFarewellMessages(removed, reason);
		return removed.map((record) => toSessionBindingRecord(record, defaults));
	};
	const sessionBindingAdapter = {
		channel: "matrix",
		accountId: params.accountId,
		capabilities: {
			placements: ["current", "child"],
			bindSupported: true,
			unbindSupported: true
		},
		bind: async (input) => {
			const conversationId = input.conversation.conversationId.trim();
			const parentConversationId = normalizeOptionalString(input.conversation.parentConversationId);
			const targetSessionKey = input.targetSessionKey.trim();
			if (!conversationId || !targetSessionKey) return null;
			let boundConversationId = conversationId;
			let boundParentConversationId = parentConversationId;
			const introText = buildMatrixBindingIntroText({
				metadata: input.metadata,
				targetSessionKey
			});
			if (input.placement === "child") {
				const roomId = parentConversationId || conversationId;
				const rootEventId = await sendBindingMessage({
					cfg: params.cfg,
					client: params.client,
					accountId: params.accountId,
					roomId,
					text: introText
				});
				if (!rootEventId) return null;
				boundConversationId = rootEventId;
				boundParentConversationId = roomId;
			}
			const now = Date.now();
			const record = {
				accountId: params.accountId,
				conversationId: boundConversationId,
				...boundParentConversationId ? { parentConversationId: boundParentConversationId } : {},
				targetKind: toMatrixBindingTargetKind(input.targetKind),
				targetSessionKey,
				agentId: normalizeOptionalString(input.metadata?.agentId) || resolveAgentIdFromSessionKey(targetSessionKey),
				label: normalizeOptionalString(input.metadata?.label) || void 0,
				boundBy: normalizeOptionalString(input.metadata?.boundBy) || "system",
				boundAt: now,
				lastActivityAt: now,
				idleTimeoutMs: defaults.idleTimeoutMs,
				maxAgeMs: defaults.maxAgeMs
			};
			setBindingRecord(record);
			await persist();
			if (input.placement === "current" && introText) {
				const roomId = boundParentConversationId || boundConversationId;
				const threadId = boundParentConversationId && boundParentConversationId !== boundConversationId ? boundConversationId : void 0;
				await sendBindingMessage({
					cfg: params.cfg,
					client: params.client,
					accountId: params.accountId,
					roomId,
					threadId,
					text: introText
				}).catch(() => {});
			}
			return toSessionBindingRecord(record, defaults);
		},
		listBySession: (targetSessionKey) => manager.listBySessionKey(targetSessionKey).map((record) => toSessionBindingRecord(record, defaults)),
		resolveByConversation: (ref) => {
			const record = manager.getByConversation({
				conversationId: ref.conversationId,
				parentConversationId: ref.parentConversationId
			});
			return record ? toSessionBindingRecord(record, defaults) : null;
		},
		touch: (bindingId, at) => {
			manager.touchBinding(bindingId, at);
		},
		unbind: async (input) => {
			return await unbindRecords(listBindingsForAccount(params.accountId).filter((record) => {
				if (input.bindingId?.trim()) return resolveBindingKey(record) === input.bindingId.trim();
				if (input.targetSessionKey?.trim()) return record.targetSessionKey === input.targetSessionKey.trim();
				return false;
			}), input.reason);
		}
	};
	registerSessionBindingAdapter(sessionBindingAdapter);
	if (params.enableSweeper !== false) {
		sweepTimer = setInterval(() => {
			const now = Date.now();
			const expired = listBindingsForAccount(params.accountId).map((record) => ({
				record,
				lifecycle: resolveEffectiveBindingExpiry({
					record,
					defaultIdleTimeoutMs: defaults.idleTimeoutMs,
					defaultMaxAgeMs: defaults.maxAgeMs
				})
			})).filter((entry) => typeof entry.lifecycle.expiresAt === "number" && entry.lifecycle.expiresAt <= now && Boolean(entry.lifecycle.reason));
			if (expired.length === 0) return;
			const reasonByBindingKey = new Map(expired.map(({ record, lifecycle }) => [resolveBindingKey(record), lifecycle.reason]));
			(async () => {
				const removed = removeRecords(expired.map(({ record }) => record));
				if (removed.length === 0) return;
				for (const record of removed) {
					const reason = reasonByBindingKey.get(resolveBindingKey(record));
					params.logVerboseMessage?.(`matrix: auto-unbinding ${record.conversationId} due to ${reason}`);
				}
				await persist();
				await sendFarewellMessages(removed, (record) => reasonByBindingKey.get(resolveBindingKey(record)));
			})().catch((err) => {
				params.logVerboseMessage?.(`matrix: failed auto-unbinding expired bindings account=${params.accountId}: ${String(err)}`);
			});
		}, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
		sweepTimer.unref?.();
	}
	setMatrixThreadBindingManagerEntry(params.accountId, {
		filePath,
		manager
	});
	return manager;
}
//#endregion
export { createMatrixThreadBindingManager as t };
