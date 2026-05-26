import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { t as resolveGlobalMap } from "./global-singleton-DE6St75u.js";
import { t as loadJsonFile } from "./json-file-DpLhTVdZ.js";
import { t as getActivePluginChannelRegistryFromState } from "./runtime-channel-state-CQNj7c3E.js";
import { a as normalizeAnyChannelId } from "./registry-CtWyD2pE.js";
import { i as normalizeConversationText, n as normalizeConversationRef, t as buildChannelAccountKey } from "./session-binding-normalization-D9PNZGcW.js";
import { r as saveJsonFile } from "./json-store-ChgPP2Sf.js";
import fs from "node:fs";
import path from "node:path";
//#region src/infra/outbound/current-conversation-bindings.ts
const CURRENT_BINDINGS_FILE_VERSION = 1;
const CURRENT_BINDINGS_ID_PREFIX = "generic:";
let bindingsLoaded = false;
const bindingsByConversationKey = /* @__PURE__ */ new Map();
function buildConversationKey(ref) {
	const normalized = normalizeConversationRef(ref);
	return [
		normalized.channel,
		normalized.accountId,
		normalized.parentConversationId ?? "",
		normalized.conversationId
	].join("␟");
}
function buildBindingId(ref) {
	return `${CURRENT_BINDINGS_ID_PREFIX}${buildConversationKey(ref)}`;
}
function resolveBindingsFilePath(env = process.env) {
	return path.join(resolveStateDir(env), "bindings", "current-conversations.json");
}
function isBindingExpired(record, now = Date.now()) {
	return typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) ? record.expiresAt <= now : false;
}
function toPersistedFile() {
	return {
		version: CURRENT_BINDINGS_FILE_VERSION,
		bindings: [...bindingsByConversationKey.values()].filter((record) => !isBindingExpired(record)).toSorted((a, b) => a.bindingId.localeCompare(b.bindingId))
	};
}
function loadBindingsIntoMemory() {
	if (bindingsLoaded) return;
	bindingsLoaded = true;
	bindingsByConversationKey.clear();
	const parsed = loadJsonFile(resolveBindingsFilePath());
	const bindings = parsed?.version === CURRENT_BINDINGS_FILE_VERSION ? parsed.bindings : [];
	for (const record of bindings ?? []) {
		if (!record?.bindingId || !record?.conversation?.conversationId || isBindingExpired(record)) continue;
		const conversation = normalizeConversationRef(record.conversation);
		const targetSessionKey = record.targetSessionKey?.trim() ?? "";
		if (!targetSessionKey) continue;
		bindingsByConversationKey.set(buildConversationKey(conversation), {
			...record,
			bindingId: buildBindingId(conversation),
			targetSessionKey,
			conversation
		});
	}
}
function persistBindingsToDisk() {
	saveJsonFile(resolveBindingsFilePath(), toPersistedFile());
}
function pruneExpiredBinding(key) {
	loadBindingsIntoMemory();
	const record = bindingsByConversationKey.get(key) ?? null;
	if (!record) return null;
	if (!isBindingExpired(record)) return record;
	bindingsByConversationKey.delete(key);
	persistBindingsToDisk();
	return null;
}
function resolveChannelSupportsCurrentConversationBinding(channel) {
	const normalized = normalizeAnyChannelId(channel) ?? normalizeOptionalLowercaseString(normalizeConversationText(channel));
	if (!normalized) return false;
	const matchesPluginId = (plugin) => plugin.id === normalized || (plugin.meta?.aliases ?? []).some((alias) => normalizeOptionalLowercaseString(alias) === normalized);
	if (((getActivePluginChannelRegistryFromState()?.channels ?? []).find((entry) => matchesPluginId(entry.plugin))?.plugin)?.conversationBindings?.supportsCurrentConversationBinding === true) return true;
	return false;
}
function getGenericCurrentConversationBindingCapabilities(params) {
	params.accountId;
	if (!resolveChannelSupportsCurrentConversationBinding(params.channel)) return null;
	return {
		adapterAvailable: true,
		bindSupported: true,
		unbindSupported: true,
		placements: ["current"]
	};
}
async function bindGenericCurrentConversation(input) {
	const conversation = normalizeConversationRef(input.conversation);
	const targetSessionKey = input.targetSessionKey.trim();
	if (!conversation.channel || !conversation.conversationId || !targetSessionKey) return null;
	loadBindingsIntoMemory();
	const now = Date.now();
	const ttlMs = typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs) ? Math.max(0, Math.floor(input.ttlMs)) : void 0;
	const key = buildConversationKey(conversation);
	const existing = pruneExpiredBinding(key);
	const record = {
		bindingId: buildBindingId(conversation),
		targetSessionKey,
		targetKind: input.targetKind,
		conversation,
		status: "active",
		boundAt: now,
		...ttlMs != null ? { expiresAt: now + ttlMs } : {},
		metadata: {
			...existing?.metadata,
			...input.metadata,
			lastActivityAt: now
		}
	};
	bindingsByConversationKey.set(key, record);
	persistBindingsToDisk();
	return record;
}
function resolveGenericCurrentConversationBinding(ref) {
	return pruneExpiredBinding(buildConversationKey(ref));
}
function listGenericCurrentConversationBindingsBySession(targetSessionKey) {
	loadBindingsIntoMemory();
	const results = [];
	for (const key of bindingsByConversationKey.keys()) {
		const record = pruneExpiredBinding(key);
		if (!record || record.targetSessionKey !== targetSessionKey) continue;
		results.push(record);
	}
	return results;
}
function touchGenericCurrentConversationBinding(bindingId, at = Date.now()) {
	loadBindingsIntoMemory();
	if (!bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX)) return;
	const key = bindingId.slice(8);
	const record = pruneExpiredBinding(key);
	if (!record) return;
	bindingsByConversationKey.set(key, {
		...record,
		metadata: {
			...record.metadata,
			lastActivityAt: at
		}
	});
	persistBindingsToDisk();
}
async function unbindGenericCurrentConversationBindings(input) {
	loadBindingsIntoMemory();
	const removed = [];
	const normalizedBindingId = input.bindingId?.trim();
	const normalizedTargetSessionKey = input.targetSessionKey?.trim();
	if (normalizedBindingId?.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
		const key = normalizedBindingId.slice(8);
		const record = pruneExpiredBinding(key);
		if (record) {
			bindingsByConversationKey.delete(key);
			removed.push(record);
			persistBindingsToDisk();
		}
		return removed;
	}
	if (!normalizedTargetSessionKey) return removed;
	for (const key of bindingsByConversationKey.keys()) {
		const record = pruneExpiredBinding(key);
		if (!record || record.targetSessionKey !== normalizedTargetSessionKey) continue;
		bindingsByConversationKey.delete(key);
		removed.push(record);
	}
	if (removed.length > 0) persistBindingsToDisk();
	return removed;
}
const testing$1 = {
	resetCurrentConversationBindingsForTests(params) {
		bindingsLoaded = false;
		bindingsByConversationKey.clear();
		if (params?.deletePersistedFile) {
			const filePath = resolveBindingsFilePath(params.env);
			try {
				fs.rmSync(filePath, { force: true });
			} catch {}
		}
	},
	resolveBindingsFilePath
};
//#endregion
//#region src/infra/outbound/session-binding-service.ts
var SessionBindingError = class extends Error {
	constructor(code, message, details) {
		super(message);
		this.code = code;
		this.details = details;
		this.name = "SessionBindingError";
	}
};
function isSessionBindingError(error) {
	return error instanceof SessionBindingError;
}
function toAdapterKey(params) {
	return buildChannelAccountKey(params);
}
function normalizePlacement(raw) {
	return raw === "current" || raw === "child" ? raw : void 0;
}
function inferDefaultPlacement(ref) {
	return ref.conversationId ? "current" : "child";
}
function resolveAdapterPlacements(adapter) {
	const placements = (adapter.capabilities?.placements?.map((value) => normalizePlacement(value)))?.filter((value) => Boolean(value));
	if (placements && placements.length > 0) return [...new Set(placements)];
	return ["current", "child"];
}
function resolveAdapterCapabilities(adapter) {
	if (!adapter) return {
		adapterAvailable: false,
		bindSupported: false,
		unbindSupported: false,
		placements: []
	};
	const bindSupported = adapter.capabilities?.bindSupported ?? Boolean(adapter.bind);
	return {
		adapterAvailable: true,
		bindSupported,
		unbindSupported: adapter.capabilities?.unbindSupported ?? Boolean(adapter.unbind),
		placements: bindSupported ? resolveAdapterPlacements(adapter) : []
	};
}
const ADAPTERS_BY_CHANNEL_ACCOUNT = resolveGlobalMap(Symbol.for("openclaw.sessionBinding.adapters"));
function getActiveAdapterForKey(key) {
	return ADAPTERS_BY_CHANNEL_ACCOUNT.get(key)?.at(-1)?.normalizedAdapter ?? null;
}
function registerSessionBindingAdapter(adapter) {
	const normalizedAdapter = {
		...adapter,
		...normalizeConversationRef({
			channel: adapter.channel,
			accountId: adapter.accountId,
			conversationId: "unused"
		})
	};
	const key = toAdapterKey({
		channel: normalizedAdapter.channel,
		accountId: normalizedAdapter.accountId
	});
	const existing = ADAPTERS_BY_CHANNEL_ACCOUNT.get(key);
	const registrations = existing ? [...existing] : [];
	registrations.push({
		adapter,
		normalizedAdapter
	});
	ADAPTERS_BY_CHANNEL_ACCOUNT.set(key, registrations);
}
function unregisterSessionBindingAdapter(params) {
	const key = toAdapterKey(params);
	const registrations = ADAPTERS_BY_CHANNEL_ACCOUNT.get(key);
	if (!registrations || registrations.length === 0) return;
	const nextRegistrations = [...registrations];
	if (params.adapter) {
		const registrationIndex = nextRegistrations.findLastIndex((registration) => registration.adapter === params.adapter);
		if (registrationIndex < 0) return;
		nextRegistrations.splice(registrationIndex, 1);
	} else nextRegistrations.pop();
	if (nextRegistrations.length === 0) {
		ADAPTERS_BY_CHANNEL_ACCOUNT.delete(key);
		return;
	}
	ADAPTERS_BY_CHANNEL_ACCOUNT.set(key, nextRegistrations);
}
function resolveAdapterForConversation(ref) {
	return resolveAdapterForChannelAccount({
		channel: ref.channel,
		accountId: ref.accountId
	});
}
function resolveAdapterForChannelAccount(params) {
	return getActiveAdapterForKey(toAdapterKey({
		channel: params.channel,
		accountId: params.accountId
	}));
}
function getActiveRegisteredAdapters() {
	return [...ADAPTERS_BY_CHANNEL_ACCOUNT.values()].map((registrations) => registrations.at(-1)?.normalizedAdapter ?? null).filter((adapter) => Boolean(adapter));
}
function dedupeBindings(records) {
	const byId = /* @__PURE__ */ new Map();
	for (const record of records) {
		if (!record?.bindingId) continue;
		byId.set(record.bindingId, record);
	}
	return [...byId.values()];
}
function createDefaultSessionBindingService() {
	return {
		bind: async (input) => {
			const normalizedConversation = normalizeConversationRef(input.conversation);
			const adapter = resolveAdapterForConversation(normalizedConversation);
			if (!adapter) {
				if (getGenericCurrentConversationBindingCapabilities({
					channel: normalizedConversation.channel,
					accountId: normalizedConversation.accountId
				})?.bindSupported) {
					const placement = normalizePlacement(input.placement) ?? inferDefaultPlacement(normalizedConversation);
					if (placement !== "current") throw new SessionBindingError("BINDING_CAPABILITY_UNSUPPORTED", `Session binding placement "${placement}" is not supported for ${normalizedConversation.channel}:${normalizedConversation.accountId}`, {
						channel: normalizedConversation.channel,
						accountId: normalizedConversation.accountId,
						placement
					});
					const bound = await bindGenericCurrentConversation({
						...input,
						conversation: normalizedConversation,
						placement
					});
					if (!bound) throw new SessionBindingError("BINDING_CREATE_FAILED", "Session binding adapter failed to bind target conversation", {
						channel: normalizedConversation.channel,
						accountId: normalizedConversation.accountId,
						placement
					});
					return bound;
				}
				throw new SessionBindingError("BINDING_ADAPTER_UNAVAILABLE", `Session binding adapter unavailable for ${normalizedConversation.channel}:${normalizedConversation.accountId}`, {
					channel: normalizedConversation.channel,
					accountId: normalizedConversation.accountId
				});
			}
			if (!adapter.bind) throw new SessionBindingError("BINDING_CAPABILITY_UNSUPPORTED", `Session binding adapter does not support binding for ${normalizedConversation.channel}:${normalizedConversation.accountId}`, {
				channel: normalizedConversation.channel,
				accountId: normalizedConversation.accountId
			});
			const placement = normalizePlacement(input.placement) ?? inferDefaultPlacement(normalizedConversation);
			if (!resolveAdapterPlacements(adapter).includes(placement)) throw new SessionBindingError("BINDING_CAPABILITY_UNSUPPORTED", `Session binding placement "${placement}" is not supported for ${normalizedConversation.channel}:${normalizedConversation.accountId}`, {
				channel: normalizedConversation.channel,
				accountId: normalizedConversation.accountId,
				placement
			});
			const bound = await adapter.bind({
				...input,
				conversation: normalizedConversation,
				placement
			});
			if (!bound) throw new SessionBindingError("BINDING_CREATE_FAILED", "Session binding adapter failed to bind target conversation", {
				channel: normalizedConversation.channel,
				accountId: normalizedConversation.accountId,
				placement
			});
			return bound;
		},
		getCapabilities: (params) => {
			const adapter = resolveAdapterForChannelAccount({
				channel: params.channel,
				accountId: params.accountId
			});
			if (!adapter) return getGenericCurrentConversationBindingCapabilities(params) ?? {
				adapterAvailable: false,
				bindSupported: false,
				unbindSupported: false,
				placements: []
			};
			return resolveAdapterCapabilities(adapter);
		},
		listBySession: (targetSessionKey) => {
			const key = targetSessionKey.trim();
			if (!key) return [];
			const results = [];
			for (const adapter of getActiveRegisteredAdapters()) {
				const entries = adapter.listBySession(key);
				if (entries.length > 0) results.push(...entries);
			}
			results.push(...listGenericCurrentConversationBindingsBySession(key));
			return dedupeBindings(results);
		},
		resolveByConversation: (ref) => {
			const normalized = normalizeConversationRef(ref);
			if (!normalized.channel || !normalized.conversationId) return null;
			const adapter = resolveAdapterForConversation(normalized);
			if (!adapter) return resolveGenericCurrentConversationBinding(normalized);
			return adapter.resolveByConversation(normalized);
		},
		touch: (bindingId, at) => {
			const normalizedBindingId = bindingId.trim();
			if (!normalizedBindingId) return;
			for (const adapter of getActiveRegisteredAdapters()) adapter.touch?.(normalizedBindingId, at);
			touchGenericCurrentConversationBinding(normalizedBindingId, at);
		},
		unbind: async (input) => {
			const removed = [];
			for (const adapter of getActiveRegisteredAdapters()) {
				if (!adapter.unbind) continue;
				const entries = await adapter.unbind(input);
				if (entries.length > 0) removed.push(...entries);
			}
			removed.push(...await unbindGenericCurrentConversationBindings(input));
			return dedupeBindings(removed);
		}
	};
}
const DEFAULT_SESSION_BINDING_SERVICE = createDefaultSessionBindingService();
function getSessionBindingService() {
	return DEFAULT_SESSION_BINDING_SERVICE;
}
const testing = {
	resetSessionBindingAdaptersForTests() {
		ADAPTERS_BY_CHANNEL_ACCOUNT.clear();
		testing$1.resetCurrentConversationBindingsForTests({ deletePersistedFile: true });
	},
	getRegisteredAdapterKeys() {
		return [...ADAPTERS_BY_CHANNEL_ACCOUNT.keys()];
	}
};
//#endregion
export { testing as a, registerSessionBindingAdapter as i, getSessionBindingService as n, unregisterSessionBindingAdapter as o, isSessionBindingError as r, SessionBindingError as t };
