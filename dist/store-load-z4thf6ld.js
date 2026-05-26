import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-DyL154ka.js";
import { a as isSubagentSessionKey, c as parseAgentSessionKey, i as isCronSessionKey, l as parseRawSessionConversationRef, n as isAcpSessionKey, o as normalizeSessionKeyPreservingOpaquePeerIds, u as parseThreadSessionSuffix } from "./session-key-utils-Ce_xWkNq.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { r as parseByteSize } from "./zod-schema-Dsy5tXpj.js";
import { t as parseDurationMs } from "./parse-duration-CD4d_yk2.js";
import { r as parseStrictNonNegativeInteger } from "./parse-finite-number-C3Woj8eC.js";
import "./config-B6Oplu5W.js";
import { t as isPluginJsonValue } from "./host-hook-json-BHsxXV1L.js";
import { a as normalizeDeliveryChannelRoute, o as normalizeDeliveryContext, s as normalizeSessionDeliveryFields } from "./delivery-context.shared-CBmB9dF7.js";
import { i as resolveSessionThreadInfo } from "./session-conversation-XHNnUnBT.js";
import { t as getLoadedChannelPluginForRead } from "./registry-loaded-read-DQJDORLt.js";
import { t as normalizePersistedSessionEntryShape } from "./store-entry-shape-D9hG2cVL.js";
import { a as normalizeSessionRuntimeModelFields } from "./types-BgvyBC-3.js";
import fs from "node:fs";
//#region src/config/sessions/store-entry.ts
function normalizeStoreSessionKey(sessionKey) {
	return normalizeSessionKeyPreservingOpaquePeerIds(sessionKey);
}
function resolveSessionStoreEntry(params) {
	const trimmedKey = params.sessionKey.trim();
	const normalizedKey = normalizeStoreSessionKey(trimmedKey);
	const foldedLegacyKey = normalizeLowercaseStringOrEmpty(normalizedKey);
	const legacyKeySet = /* @__PURE__ */ new Set();
	if (trimmedKey !== normalizedKey && Object.prototype.hasOwnProperty.call(params.store, trimmedKey)) legacyKeySet.add(trimmedKey);
	if (foldedLegacyKey !== normalizedKey && Object.prototype.hasOwnProperty.call(params.store, foldedLegacyKey)) legacyKeySet.add(foldedLegacyKey);
	let existing = params.store[normalizedKey] ?? params.store[foldedLegacyKey] ?? (legacyKeySet.size > 0 ? params.store[trimmedKey] : void 0);
	let existingUpdatedAt = existing?.updatedAt ?? 0;
	for (const [candidateKey, candidateEntry] of Object.entries(params.store)) {
		if (candidateKey === normalizedKey) continue;
		if (!(normalizeStoreSessionKey(candidateKey) === normalizedKey || foldedLegacyKey !== normalizedKey && normalizeLowercaseStringOrEmpty(candidateKey) === foldedLegacyKey)) continue;
		legacyKeySet.add(candidateKey);
		const candidateUpdatedAt = candidateEntry?.updatedAt ?? 0;
		if (!existing || candidateUpdatedAt > existingUpdatedAt) {
			existing = candidateEntry;
			existingUpdatedAt = candidateUpdatedAt;
		}
	}
	return {
		normalizedKey,
		existing,
		legacyKeys: [...legacyKeySet]
	};
}
//#endregion
//#region src/config/cache-utils.ts
function resolveCacheTtlMs(params) {
	const { envValue, defaultTtlMs } = params;
	if (envValue) {
		const parsed = parseStrictNonNegativeInteger(envValue);
		if (parsed !== void 0) return parsed;
	}
	return defaultTtlMs;
}
function isCacheEnabled(ttlMs) {
	return ttlMs > 0;
}
function resolveCacheNumeric(value) {
	return typeof value === "function" ? value() : value;
}
function resolvePruneIntervalMs(ttlMs, pruneIntervalMs) {
	if (typeof pruneIntervalMs === "function") return Math.max(0, Math.floor(pruneIntervalMs(ttlMs)));
	if (typeof pruneIntervalMs === "number") return Math.max(0, Math.floor(pruneIntervalMs));
	return ttlMs;
}
function isCacheEntryExpired(storedAt, now, ttlMs) {
	return now - storedAt > ttlMs;
}
function createExpiringMapCache(options) {
	const cache = /* @__PURE__ */ new Map();
	const now = options.clock ?? Date.now;
	let lastPruneAt = 0;
	function getTtlMs() {
		return Math.max(0, Math.floor(resolveCacheNumeric(options.ttlMs)));
	}
	function maybePruneExpiredEntries(nowMs, ttlMs) {
		if (!isCacheEnabled(ttlMs)) return;
		if (nowMs - lastPruneAt < resolvePruneIntervalMs(ttlMs, options.pruneIntervalMs)) return;
		for (const [key, entry] of cache.entries()) if (isCacheEntryExpired(entry.storedAt, nowMs, ttlMs)) cache.delete(key);
		lastPruneAt = nowMs;
	}
	return {
		get: (key) => {
			const ttlMs = getTtlMs();
			if (!isCacheEnabled(ttlMs)) return;
			const nowMs = now();
			maybePruneExpiredEntries(nowMs, ttlMs);
			const entry = cache.get(key);
			if (!entry) return;
			if (isCacheEntryExpired(entry.storedAt, nowMs, ttlMs)) {
				cache.delete(key);
				return;
			}
			return entry.value;
		},
		set: (key, value) => {
			const ttlMs = getTtlMs();
			if (!isCacheEnabled(ttlMs)) return;
			const nowMs = now();
			maybePruneExpiredEntries(nowMs, ttlMs);
			cache.set(key, {
				storedAt: nowMs,
				value
			});
		},
		delete: (key) => {
			cache.delete(key);
		},
		clear: () => {
			cache.clear();
			lastPruneAt = 0;
		},
		keys: () => [...cache.keys()],
		size: () => cache.size,
		pruneExpired: () => {
			const ttlMs = getTtlMs();
			if (!isCacheEnabled(ttlMs)) return;
			const nowMs = now();
			for (const [key, entry] of cache.entries()) if (isCacheEntryExpired(entry.storedAt, nowMs, ttlMs)) cache.delete(key);
			lastPruneAt = nowMs;
		}
	};
}
function getFileStatSnapshot(filePath) {
	try {
		const stats = fs.statSync(filePath);
		return {
			mtimeMs: stats.mtimeMs,
			sizeBytes: stats.size
		};
	} catch {
		return;
	}
}
//#endregion
//#region src/channels/plugins/session-thread-info-loaded.ts
function resolveLoadedSessionConversationThreadInfo(sessionKey) {
	const raw = parseRawSessionConversationRef(sessionKey);
	if (!raw) return null;
	const rawId = raw.rawId.trim();
	if (!rawId) return null;
	const resolved = (getLoadedChannelPluginForRead(raw.channel)?.messaging)?.resolveSessionConversation?.({
		kind: raw.kind,
		rawId
	});
	if (!resolved?.id?.trim()) return null;
	const id = resolved.id.trim();
	const threadId = normalizeOptionalString(resolved.threadId);
	return {
		baseSessionKey: threadId ? `${raw.prefix}:${id}` : normalizeOptionalString(sessionKey),
		threadId
	};
}
function resolveLoadedSessionThreadInfo(sessionKey) {
	return resolveLoadedSessionConversationThreadInfo(sessionKey) ?? parseThreadSessionSuffix(sessionKey);
}
//#endregion
//#region src/config/sessions/thread-info.ts
/**
* Extract deliveryContext and threadId from a sessionKey.
* Supports generic :thread: suffixes plus plugin-owned thread/session grammars.
*/
function parseSessionThreadInfo(sessionKey) {
	return resolveSessionThreadInfo(sessionKey);
}
function parseSessionThreadInfoFast(sessionKey) {
	return resolveLoadedSessionThreadInfo(sessionKey);
}
//#endregion
//#region src/config/sessions/store-maintenance.ts
const log$1 = createSubsystemLogger("sessions/store");
const DEFAULT_SESSION_PRUNE_AFTER_MS = 720 * 60 * 60 * 1e3;
const DEFAULT_SESSION_MAX_ENTRIES = 500;
const DEFAULT_SESSION_MAINTENANCE_MODE = "enforce";
const DEFAULT_SESSION_DISK_BUDGET_HIGH_WATER_RATIO = .8;
const STRICT_ENTRY_MAINTENANCE_MAX_ENTRIES = 49;
const MIN_BATCHED_ENTRY_MAINTENANCE_SLACK = 25;
const BATCHED_ENTRY_MAINTENANCE_SLACK_RATIO = .1;
function resolvePruneAfterMs(maintenance) {
	const normalized = normalizeStringifiedOptionalString(maintenance?.pruneAfter ?? maintenance?.pruneDays);
	if (!normalized) return DEFAULT_SESSION_PRUNE_AFTER_MS;
	try {
		return parseDurationMs(normalized, { defaultUnit: "d" });
	} catch {
		return DEFAULT_SESSION_PRUNE_AFTER_MS;
	}
}
function resolveResetArchiveRetentionMs(maintenance, pruneAfterMs) {
	const raw = maintenance?.resetArchiveRetention;
	if (raw === false) return null;
	const normalized = normalizeStringifiedOptionalString(raw);
	if (!normalized) return pruneAfterMs;
	try {
		return parseDurationMs(normalized, { defaultUnit: "d" });
	} catch {
		return pruneAfterMs;
	}
}
function resolveMaxDiskBytes(maintenance) {
	const raw = maintenance?.maxDiskBytes;
	const normalized = normalizeStringifiedOptionalString(raw);
	if (!normalized) return null;
	try {
		return parseByteSize(normalized, { defaultUnit: "b" });
	} catch {
		return null;
	}
}
function resolveHighWaterBytes(maintenance, maxDiskBytes) {
	const computeDefault = () => {
		if (maxDiskBytes == null) return null;
		if (maxDiskBytes <= 0) return 0;
		return Math.max(1, Math.min(maxDiskBytes, Math.floor(maxDiskBytes * DEFAULT_SESSION_DISK_BUDGET_HIGH_WATER_RATIO)));
	};
	if (maxDiskBytes == null) return null;
	const raw = maintenance?.highWaterBytes;
	const normalized = normalizeStringifiedOptionalString(raw);
	if (!normalized) return computeDefault();
	try {
		const parsed = parseByteSize(normalized, { defaultUnit: "b" });
		return Math.min(parsed, maxDiskBytes);
	} catch {
		return computeDefault();
	}
}
/**
* Resolve maintenance settings from openclaw.json (`session.maintenance`).
* Falls back to built-in defaults when config is missing or unset.
*/
function resolveMaintenanceConfigFromInput(maintenance) {
	const pruneAfterMs = resolvePruneAfterMs(maintenance);
	const maxDiskBytes = resolveMaxDiskBytes(maintenance);
	return {
		mode: maintenance?.mode ?? DEFAULT_SESSION_MAINTENANCE_MODE,
		pruneAfterMs,
		maxEntries: maintenance?.maxEntries ?? DEFAULT_SESSION_MAX_ENTRIES,
		resetArchiveRetentionMs: resolveResetArchiveRetentionMs(maintenance, pruneAfterMs),
		maxDiskBytes,
		highWaterBytes: resolveHighWaterBytes(maintenance, maxDiskBytes)
	};
}
function resolveSessionEntryMaintenanceHighWater(maxEntries) {
	if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) return 1;
	if (maxEntries <= STRICT_ENTRY_MAINTENANCE_MAX_ENTRIES) return maxEntries + 1;
	return maxEntries + Math.max(MIN_BATCHED_ENTRY_MAINTENANCE_SLACK, Math.ceil(maxEntries * BATCHED_ENTRY_MAINTENANCE_SLACK_RATIO));
}
function shouldRunSessionEntryMaintenance(params) {
	if (params.force) return true;
	return params.entryCount >= resolveSessionEntryMaintenanceHighWater(params.maxEntries);
}
/**
* Remove entries whose `updatedAt` is older than the configured threshold.
* Entries without `updatedAt` are kept (cannot determine staleness).
* Mutates `store` in-place.
*/
function pruneStaleEntries(store, overrideMaxAgeMs, opts = {}) {
	const maxAgeMs = overrideMaxAgeMs ?? resolveMaintenanceConfigFromInput().pruneAfterMs;
	const cutoffMs = Date.now() - maxAgeMs;
	let pruned = 0;
	for (const [key, entry] of Object.entries(store)) {
		if (shouldPreserveMaintenanceEntry({
			key,
			entry,
			preserveKeys: opts.preserveKeys
		})) continue;
		if (entry?.updatedAt != null && entry.updatedAt < cutoffMs) {
			opts.onPruned?.({
				key,
				entry
			});
			delete store[key];
			pruned++;
		}
	}
	if (pruned > 0 && opts.log !== false) log$1.info("pruned stale session entries", {
		pruned,
		maxAgeMs
	});
	return pruned;
}
const QUOTA_SUSPENSION_CLEANUP_FACTOR = 2;
/**
* Two-stage TTL maintenance for `quotaSuspension` records:
*  1. After `ttlMs`, transition `state: "suspended" → "resuming"` so the next
*     attempt for that session sees the resume marker and injects a handoff.
*  2. After `2 * ttlMs`, drop the field entirely (the record has done its job).
*
* Mutates `store` in-place. The caller is responsible for translating the
* returned `resumed[]` into in-process lane-concurrency restoration calls,
* which keeps this module free of `process/*` dependencies.
*/
function pruneQuotaSuspensions(params) {
	const ttlMs = params.ttlMs ?? 18e5;
	const cleanupAfterResumeMs = ttlMs * (QUOTA_SUSPENSION_CLEANUP_FACTOR - 1);
	const resumed = [];
	let cleared = 0;
	for (const [sessionKey, entry] of Object.entries(params.store)) {
		const suspension = entry.quotaSuspension;
		if (!suspension) continue;
		const resumeAtMs = suspension.expectedResumeBy ?? suspension.suspendedAt + ttlMs;
		const cleanupAtMs = resumeAtMs + cleanupAfterResumeMs;
		if (params.now >= cleanupAtMs) {
			delete entry.quotaSuspension;
			cleared++;
			continue;
		}
		if (suspension.state === "suspended" && params.now >= resumeAtMs) {
			entry.quotaSuspension = {
				...suspension,
				state: "resuming"
			};
			resumed.push({
				sessionKey,
				laneId: suspension.laneId
			});
		}
	}
	if ((resumed.length > 0 || cleared > 0) && params.log !== false) log$1.info("processed quota-suspension TTLs", {
		resumed: resumed.length,
		cleared,
		ttlMs
	});
	return {
		resumed,
		cleared
	};
}
function getEntryUpdatedAt(entry) {
	return entry?.updatedAt ?? Number.NEGATIVE_INFINITY;
}
function isSyntheticSessionMaintenanceKey(sessionKey) {
	const rest = normalizeLowercaseStringOrEmpty(parseAgentSessionKey(sessionKey)?.rest ?? sessionKey);
	return isSubagentSessionKey(sessionKey) || isAcpSessionKey(sessionKey) || isCronSessionKey(sessionKey) || rest.startsWith("hook:") || rest.startsWith("node:") || rest === "heartbeat" || rest.endsWith(":heartbeat") || rest.includes(":heartbeat:");
}
function isTelegramTopicSessionKey(sessionKey) {
	const rest = normalizeLowercaseStringOrEmpty(parseAgentSessionKey(sessionKey)?.rest ?? sessionKey);
	return /^telegram:(?:group|channel|direct|dm):.+:topic:[^:]+$/.test(rest);
}
function isExternalGroupOrChannelSessionKey(sessionKey) {
	const rest = normalizeLowercaseStringOrEmpty(parseAgentSessionKey(sessionKey)?.rest ?? sessionKey);
	return /^[^:]+:(?:group|channel):.+$/.test(rest);
}
function isProtectedSessionMaintenanceEntry(sessionKey, entry) {
	if (isSyntheticSessionMaintenanceKey(sessionKey)) return false;
	if (parseSessionThreadInfoFast(sessionKey).threadId) return true;
	if (isTelegramTopicSessionKey(sessionKey)) return true;
	if (isExternalGroupOrChannelSessionKey(sessionKey)) return true;
	const chatType = normalizeLowercaseStringOrEmpty(entry?.chatType ?? entry?.origin?.chatType);
	return chatType === "group" || chatType === "channel" || chatType === "thread";
}
function shouldPreserveMaintenanceEntry(params) {
	return params.preserveKeys?.has(params.key) === true || isProtectedSessionMaintenanceEntry(params.key, params.entry);
}
function getActiveSessionMaintenanceWarning(params) {
	const activeSessionKey = params.activeSessionKey.trim();
	if (!activeSessionKey) return null;
	const activeEntry = params.store[activeSessionKey];
	if (!activeEntry) return null;
	if (isProtectedSessionMaintenanceEntry(activeSessionKey, activeEntry)) return null;
	const cutoffMs = (params.nowMs ?? Date.now()) - params.pruneAfterMs;
	const wouldPrune = activeEntry.updatedAt != null ? activeEntry.updatedAt < cutoffMs : false;
	const keys = Object.keys(params.store);
	const wouldCap = wouldCapActiveSession({
		store: params.store,
		keys,
		activeEntry,
		activeSessionKey,
		maxEntries: params.maxEntries
	});
	if (!wouldPrune && !wouldCap) return null;
	return {
		activeSessionKey,
		activeUpdatedAt: activeEntry.updatedAt,
		totalEntries: keys.length,
		pruneAfterMs: params.pruneAfterMs,
		maxEntries: params.maxEntries,
		wouldPrune,
		wouldCap
	};
}
function wouldCapActiveSession(params) {
	if (params.keys.length <= params.maxEntries) return false;
	if (params.maxEntries <= 0) return true;
	const protectedCount = params.keys.filter((key) => key !== params.activeSessionKey && isProtectedSessionMaintenanceEntry(key, params.store[key])).length;
	const maxRemovableEntries = Math.max(0, params.maxEntries - protectedCount);
	if (maxRemovableEntries <= 0) return true;
	const activeUpdatedAt = getEntryUpdatedAt(params.activeEntry);
	let newerOrTieBeforeActive = 0;
	let seenActive = false;
	for (const key of params.keys) {
		if (key === params.activeSessionKey) {
			seenActive = true;
			continue;
		}
		if (isProtectedSessionMaintenanceEntry(key, params.store[key])) continue;
		const entryUpdatedAt = getEntryUpdatedAt(params.store[key]);
		if (entryUpdatedAt > activeUpdatedAt || !seenActive && entryUpdatedAt === activeUpdatedAt) {
			newerOrTieBeforeActive++;
			if (newerOrTieBeforeActive >= maxRemovableEntries) return true;
		}
	}
	return false;
}
/**
* Cap the store to the N most recently updated entries.
* Entries without `updatedAt` are sorted last (removed first when over limit).
* Mutates `store` in-place.
*/
function capEntryCount(store, overrideMax, opts = {}) {
	const maxEntries = overrideMax ?? resolveMaintenanceConfigFromInput().maxEntries;
	const preservedCount = Object.entries(store).filter(([key, entry]) => shouldPreserveMaintenanceEntry({
		key,
		entry,
		preserveKeys: opts.preserveKeys
	})).length;
	const maxRemovableEntries = Math.max(0, maxEntries - preservedCount);
	const keys = Object.keys(store).filter((key) => !shouldPreserveMaintenanceEntry({
		key,
		entry: store[key],
		preserveKeys: opts.preserveKeys
	}));
	if (keys.length <= maxRemovableEntries) return 0;
	const toRemove = keys.toSorted((a, b) => {
		const aTime = getEntryUpdatedAt(store[a]);
		return getEntryUpdatedAt(store[b]) - aTime;
	}).slice(maxRemovableEntries);
	for (const key of toRemove) {
		const entry = store[key];
		if (entry) opts.onCapped?.({
			key,
			entry
		});
		delete store[key];
	}
	if (opts.log !== false) log$1.info("capped session entry count", {
		removed: toRemove.length,
		maxEntries
	});
	return toRemove.length;
}
//#endregion
//#region src/config/sessions/store-cache.ts
const DEFAULT_SESSION_STORE_TTL_MS = 45e3;
const DEFAULT_SESSION_STORE_SERIALIZED_CACHE_MAX_ENTRIES = 64;
const DEFAULT_SESSION_STORE_SERIALIZED_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const LARGE_SESSION_STORE_STRING_MIN_CHARS = 512;
const LARGE_SESSION_STORE_STRING_MAX_INTERNED = 256;
const SESSION_STORE_CACHE = createExpiringMapCache({ ttlMs: getSessionStoreTtl });
const SESSION_STORE_SNAPSHOT_CACHE = createExpiringMapCache({ ttlMs: getSessionStoreTtl });
const SESSION_STORE_SERIALIZED_CACHE = /* @__PURE__ */ new Map();
const SESSION_STORE_STRING_INTERN_POOL = /* @__PURE__ */ new Map();
const SESSION_STORE_STRING_INTERN_STATS = {
	stored: 0,
	reused: 0,
	skippedSmall: 0,
	skippedFull: 0
};
let sessionStoreSnapshotGeneration = 0;
let sessionStoreSerializedCacheBytes = 0;
function parseNonNegativeInteger(value) {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function getSerializedSessionStoreCacheMaxBytes() {
	return parseNonNegativeInteger(process.env.OPENCLAW_SESSION_SERIALIZED_CACHE_MAX_BYTES) ?? DEFAULT_SESSION_STORE_SERIALIZED_CACHE_MAX_BYTES;
}
function getSerializedSessionStoreCacheMaxEntries() {
	return DEFAULT_SESSION_STORE_SERIALIZED_CACHE_MAX_ENTRIES;
}
function resetSessionStoreStringInternStats() {
	SESSION_STORE_STRING_INTERN_STATS.stored = 0;
	SESSION_STORE_STRING_INTERN_STATS.reused = 0;
	SESSION_STORE_STRING_INTERN_STATS.skippedSmall = 0;
	SESSION_STORE_STRING_INTERN_STATS.skippedFull = 0;
}
function internLargeSessionStoreString(value) {
	if (value.length < LARGE_SESSION_STORE_STRING_MIN_CHARS) {
		SESSION_STORE_STRING_INTERN_STATS.skippedSmall += 1;
		return value;
	}
	const interned = SESSION_STORE_STRING_INTERN_POOL.get(value);
	if (interned !== void 0) {
		SESSION_STORE_STRING_INTERN_STATS.reused += 1;
		return interned;
	}
	if (SESSION_STORE_STRING_INTERN_POOL.size >= LARGE_SESSION_STORE_STRING_MAX_INTERNED) {
		SESSION_STORE_STRING_INTERN_STATS.skippedFull += 1;
		return value;
	}
	SESSION_STORE_STRING_INTERN_POOL.set(value, value);
	SESSION_STORE_STRING_INTERN_STATS.stored += 1;
	return value;
}
function internSessionEntryLargeStrings(entry) {
	const snapshot = entry.skillsSnapshot;
	if (!snapshot?.prompt) return;
	snapshot.prompt = internLargeSessionStoreString(snapshot.prompt);
}
function internSessionStoreLargeStrings(store) {
	for (const entry of Object.values(store)) internSessionEntryLargeStrings(entry);
}
function deepFreeze(value, seen = /* @__PURE__ */ new WeakSet()) {
	if (!value || typeof value !== "object") return value;
	const object = value;
	if (seen.has(object)) return value;
	seen.add(object);
	for (const child of Object.values(value)) deepFreeze(child, seen);
	return Object.freeze(value);
}
function cloneSessionStoreRecord(store, serialized) {
	const cloned = JSON.parse(serialized ?? JSON.stringify(store));
	internSessionStoreLargeStrings(cloned);
	return cloned;
}
function cloneJsonLikeValue(value) {
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => cloneJsonLikeValue(item));
	const cloned = {};
	for (const [key, child] of Object.entries(value)) cloned[key] = cloneJsonLikeValue(child);
	return cloned;
}
function cloneSessionStoreSnapshot(store, serialized) {
	const cloned = serialized === void 0 ? cloneJsonLikeValue(store) : cloneSessionStoreRecord(store, serialized);
	internSessionStoreLargeStrings(cloned);
	return deepFreeze(cloned);
}
function getSessionStoreTtl() {
	return resolveCacheTtlMs({
		envValue: process.env.OPENCLAW_SESSION_CACHE_TTL_MS,
		defaultTtlMs: DEFAULT_SESSION_STORE_TTL_MS
	});
}
function isSessionStoreCacheEnabled() {
	return isCacheEnabled(getSessionStoreTtl());
}
function clearSessionStoreCaches() {
	SESSION_STORE_CACHE.clear();
	SESSION_STORE_SNAPSHOT_CACHE.clear();
	SESSION_STORE_SERIALIZED_CACHE.clear();
	sessionStoreSerializedCacheBytes = 0;
	SESSION_STORE_STRING_INTERN_POOL.clear();
	resetSessionStoreStringInternStats();
}
function invalidateSessionStoreCache(storePath) {
	SESSION_STORE_CACHE.delete(storePath);
	SESSION_STORE_SNAPSHOT_CACHE.delete(storePath);
	deleteSerializedSessionStore(storePath);
}
function deleteSerializedSessionStore(storePath) {
	const cached = SESSION_STORE_SERIALIZED_CACHE.get(storePath);
	if (!cached) return;
	SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
	sessionStoreSerializedCacheBytes -= cached.sizeBytes;
}
function pruneSerializedSessionStoreCache() {
	const maxEntries = getSerializedSessionStoreCacheMaxEntries();
	const maxBytes = getSerializedSessionStoreCacheMaxBytes();
	while (SESSION_STORE_SERIALIZED_CACHE.size > 0 && (SESSION_STORE_SERIALIZED_CACHE.size > maxEntries || sessionStoreSerializedCacheBytes > maxBytes)) {
		const oldestKey = SESSION_STORE_SERIALIZED_CACHE.keys().next().value;
		if (typeof oldestKey !== "string") break;
		deleteSerializedSessionStore(oldestKey);
	}
}
function getSerializedSessionStore(storePath) {
	pruneSerializedSessionStoreCache();
	return SESSION_STORE_SERIALIZED_CACHE.get(storePath)?.serialized;
}
function setSerializedSessionStore(storePath, serialized) {
	deleteSerializedSessionStore(storePath);
	if (serialized === void 0) return;
	const sizeBytes = Buffer.byteLength(serialized, "utf8");
	const maxEntries = getSerializedSessionStoreCacheMaxEntries();
	const maxBytes = getSerializedSessionStoreCacheMaxBytes();
	if (maxEntries <= 0 || maxBytes <= 0 || sizeBytes > maxBytes) return;
	SESSION_STORE_SERIALIZED_CACHE.set(storePath, {
		serialized,
		sizeBytes
	});
	sessionStoreSerializedCacheBytes += sizeBytes;
	pruneSerializedSessionStoreCache();
}
function dropSessionStoreObjectCache(storePath) {
	SESSION_STORE_CACHE.delete(storePath);
}
function dropSessionStoreSnapshotCache(storePath) {
	SESSION_STORE_SNAPSHOT_CACHE.delete(storePath);
}
function readSessionStoreSnapshotCache(params) {
	const cached = SESSION_STORE_SNAPSHOT_CACHE.get(params.storePath);
	if (!cached) return null;
	if (params.mtimeMs !== cached.mtimeMs || params.sizeBytes !== cached.sizeBytes) {
		invalidateSessionStoreCache(params.storePath);
		return null;
	}
	return cached.snapshot;
}
function writeSessionStoreSnapshotCache(params) {
	const snapshot = cloneSessionStoreSnapshot(params.store, params.serialized);
	SESSION_STORE_SNAPSHOT_CACHE.set(params.storePath, {
		snapshot,
		mtimeMs: params.mtimeMs,
		sizeBytes: params.sizeBytes,
		generation: sessionStoreSnapshotGeneration += 1,
		createdAt: Date.now(),
		entryCount: Object.keys(snapshot).length
	});
	return snapshot;
}
function readSessionStoreCache(params) {
	const cached = SESSION_STORE_CACHE.get(params.storePath);
	if (!cached) return null;
	if (params.mtimeMs !== cached.mtimeMs || params.sizeBytes !== cached.sizeBytes) {
		invalidateSessionStoreCache(params.storePath);
		return null;
	}
	if (params.clone === false) return cached.store;
	return cloneSessionStoreRecord(cached.store, cached.serialized);
}
function takeMutableSessionStoreCache(params) {
	const cached = SESSION_STORE_CACHE.get(params.storePath);
	if (!cached) return null;
	if (params.mtimeMs !== cached.mtimeMs || params.sizeBytes !== cached.sizeBytes) {
		invalidateSessionStoreCache(params.storePath);
		return null;
	}
	SESSION_STORE_CACHE.delete(params.storePath);
	return cached.store;
}
function writeSessionStoreCache(params) {
	const store = params.serialized === void 0 ? cloneSessionStoreRecord(params.store) : params.store;
	if (params.serialized !== void 0) internSessionStoreLargeStrings(store);
	SESSION_STORE_CACHE.set(params.storePath, {
		store,
		mtimeMs: params.mtimeMs,
		sizeBytes: params.sizeBytes,
		serialized: params.serialized
	});
	setSerializedSessionStore(params.storePath, params.serialized);
}
//#endregion
//#region src/plugins/session-entry-slot-keys.ts
const SESSION_ENTRY_RESERVED_SLOT_KEYS = new Set([
	"__proto__",
	"constructor",
	"prototype",
	"lastHeartbeatText",
	"lastHeartbeatSentAt",
	"heartbeatIsolatedBaseSessionKey",
	"heartbeatTaskState",
	"pluginExtensions",
	"pluginExtensionSlotKeys",
	"pluginNextTurnInjections",
	"sessionId",
	"updatedAt",
	"sessionFile",
	"spawnedBy",
	"spawnedWorkspaceDir",
	"parentSessionKey",
	"forkedFromParent",
	"spawnDepth",
	"subagentRole",
	"subagentControlScope",
	"inheritedToolDeny",
	"inheritedToolAllow",
	"subagentRecovery",
	"pluginOwnerId",
	"systemSent",
	"abortedLastRun",
	"sessionStartedAt",
	"lastInteractionAt",
	"startedAt",
	"endedAt",
	"runtimeMs",
	"status",
	"abortCutoffMessageSid",
	"abortCutoffTimestamp",
	"chatType",
	"thinkingLevel",
	"fastMode",
	"verboseLevel",
	"traceLevel",
	"reasoningLevel",
	"elevatedLevel",
	"ttsAuto",
	"lastTtsReadLatestHash",
	"lastTtsReadLatestAt",
	"execHost",
	"execSecurity",
	"execAsk",
	"execNode",
	"responseUsage",
	"usageFamilyKey",
	"usageFamilySessionIds",
	"providerOverride",
	"modelOverride",
	"agentRuntimeOverride",
	"modelOverrideSource",
	"modelOverrideFallbackOriginProvider",
	"modelOverrideFallbackOriginModel",
	"authProfileOverride",
	"authProfileOverrideSource",
	"authProfileOverrideCompactionCount",
	"liveModelSwitchPending",
	"groupActivation",
	"groupActivationNeedsSystemIntro",
	"sendPolicy",
	"queueMode",
	"queueDebounceMs",
	"queueCap",
	"queueDrop",
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"pendingFinalDelivery",
	"pendingFinalDeliveryCreatedAt",
	"pendingFinalDeliveryLastAttemptAt",
	"pendingFinalDeliveryAttemptCount",
	"pendingFinalDeliveryLastError",
	"pendingFinalDeliveryText",
	"pendingFinalDeliveryContext",
	"pendingFinalDeliveryIntentId",
	"totalTokensFresh",
	"estimatedCostUsd",
	"cacheRead",
	"cacheWrite",
	"modelProvider",
	"model",
	"agentHarnessId",
	"fallbackNoticeSelectedModel",
	"fallbackNoticeActiveModel",
	"fallbackNoticeReason",
	"contextTokens",
	"compactionCount",
	"compactionCheckpoints",
	"memoryFlushAt",
	"memoryFlushCompactionCount",
	"memoryFlushContextHash",
	"cliSessionIds",
	"cliSessionBindings",
	"claudeCliSessionId",
	"label",
	"displayName",
	"channel",
	"groupId",
	"subject",
	"groupChannel",
	"space",
	"origin",
	"route",
	"deliveryContext",
	"lastChannel",
	"lastTo",
	"lastAccountId",
	"lastThreadId",
	"skillsSnapshot",
	"systemPromptReport",
	"pluginDebugEntries",
	"acp",
	"quotaSuspension"
]);
const OBJECT_PROTOTYPE_RESERVED_SLOT_KEYS = new Set(["prototype", ...Object.getOwnPropertyNames(Object.prototype)]);
const SESSION_ENTRY_SLOT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/u;
function normalizeSessionEntrySlotKey(value) {
	if (typeof value !== "string") return {
		ok: false,
		error: "sessionEntrySlotKey must be a string"
	};
	const key = value.trim();
	if (!key) return {
		ok: false,
		error: "sessionEntrySlotKey cannot be empty"
	};
	if (!SESSION_ENTRY_SLOT_KEY_RE.test(key)) return {
		ok: false,
		error: "sessionEntrySlotKey must be an identifier-style field name"
	};
	if (SESSION_ENTRY_RESERVED_SLOT_KEYS.has(key)) return {
		ok: false,
		error: `sessionEntrySlotKey is reserved by SessionEntry: ${key}`
	};
	if (OBJECT_PROTOTYPE_RESERVED_SLOT_KEYS.has(key)) return {
		ok: false,
		error: `sessionEntrySlotKey is reserved by Object: ${key}`
	};
	return {
		ok: true,
		key
	};
}
//#endregion
//#region src/config/sessions/store-maintenance-preserve.ts
const preserveKeysProviders = /* @__PURE__ */ new Set();
function registerSessionMaintenancePreserveKeysProvider(provider) {
	preserveKeysProviders.add(provider);
	return () => {
		preserveKeysProviders.delete(provider);
	};
}
function addSessionMaintenancePreserveKey(keys, value) {
	const normalized = normalizeStoreSessionKey(value ?? "");
	if (normalized) keys.add(normalized);
}
function addSessionMaintenancePreserveKeys(keys, values) {
	for (const value of values ?? []) addSessionMaintenancePreserveKey(keys, value);
}
function collectSessionMaintenancePreserveKeys(baseKeys) {
	const keys = /* @__PURE__ */ new Set();
	addSessionMaintenancePreserveKeys(keys, baseKeys);
	for (const provider of preserveKeysProviders) try {
		addSessionMaintenancePreserveKeys(keys, provider());
	} catch {}
	return keys.size > 0 ? keys : void 0;
}
//#endregion
//#region src/config/sessions/store-maintenance-runtime.ts
function resolveMaintenanceConfig() {
	let maintenance;
	try {
		maintenance = getRuntimeConfig().session?.maintenance;
	} catch {}
	return resolveMaintenanceConfigFromInput(maintenance);
}
//#endregion
//#region src/config/sessions/store-migrations.ts
function applySessionStoreMigrations(store) {
	let changed = false;
	for (const entry of Object.values(store)) {
		if (!entry || typeof entry !== "object") continue;
		const rec = entry;
		if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
			rec.channel = rec.provider;
			delete rec.provider;
			changed = true;
		}
		if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
			rec.lastChannel = rec.lastProvider;
			delete rec.lastProvider;
			changed = true;
		}
		if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
			rec.groupChannel = rec.room;
			delete rec.room;
			changed = true;
		} else if ("room" in rec) {
			delete rec.room;
			changed = true;
		}
	}
	return changed;
}
//#endregion
//#region src/config/sessions/store-load.ts
const log = createSubsystemLogger("sessions/store");
function isSessionStoreRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function isRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function normalizeOptionalFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function normalizeOptionalAttemptCount(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : void 0;
}
function normalizeOptionalStringOrNull(value) {
	if (value === null || typeof value === "string") return value;
}
function normalizeRecordKey(value) {
	const key = value.trim();
	return key.length > 0 ? key : void 0;
}
function normalizeOptionalDeliveryContext(value) {
	if (!isRecord(value)) return;
	const normalized = normalizeDeliveryContext({
		channel: typeof value.channel === "string" ? value.channel : void 0,
		to: typeof value.to === "string" ? value.to : void 0,
		accountId: typeof value.accountId === "string" ? value.accountId : void 0,
		threadId: typeof value.threadId === "string" || typeof value.threadId === "number" ? value.threadId : void 0
	});
	return normalized?.channel && normalized.to ? normalized : void 0;
}
function sameDeliveryContext(left, right) {
	return (left?.channel ?? void 0) === (right?.channel ?? void 0) && (left?.to ?? void 0) === (right?.to ?? void 0) && (left?.accountId ?? void 0) === (right?.accountId ?? void 0) && (left?.threadId ?? void 0) === (right?.threadId ?? void 0);
}
function normalizePendingFinalDeliveryFields(entry) {
	let next = entry;
	const assign = (key, value) => {
		if (entry[key] === value) return;
		if (next === entry) next = { ...entry };
		if (value === void 0) delete next[key];
		else next[key] = value;
	};
	assign("pendingFinalDelivery", entry.pendingFinalDelivery === true ? true : void 0);
	assign("pendingFinalDeliveryText", normalizeOptionalStringOrNull(entry.pendingFinalDeliveryText));
	assign("pendingFinalDeliveryCreatedAt", normalizeOptionalFiniteNumber(entry.pendingFinalDeliveryCreatedAt));
	assign("pendingFinalDeliveryLastAttemptAt", normalizeOptionalFiniteNumber(entry.pendingFinalDeliveryLastAttemptAt));
	assign("pendingFinalDeliveryAttemptCount", normalizeOptionalAttemptCount(entry.pendingFinalDeliveryAttemptCount));
	assign("pendingFinalDeliveryLastError", normalizeOptionalStringOrNull(entry.pendingFinalDeliveryLastError));
	const pendingFinalDeliveryContext = normalizeOptionalDeliveryContext(entry.pendingFinalDeliveryContext);
	if (!sameDeliveryContext(entry.pendingFinalDeliveryContext, pendingFinalDeliveryContext)) assign("pendingFinalDeliveryContext", pendingFinalDeliveryContext);
	assign("pendingFinalDeliveryIntentId", normalizeOptionalStringOrNull(entry.pendingFinalDeliveryIntentId));
	return next;
}
function normalizePluginExtensions(entry) {
	if (entry.pluginExtensions === void 0) return entry;
	if (!isRecord(entry.pluginExtensions)) {
		const next = { ...entry };
		delete next.pluginExtensions;
		return next;
	}
	let changed = false;
	const normalizedExtensions = {};
	for (const [rawPluginId, rawPluginState] of Object.entries(entry.pluginExtensions)) {
		const pluginId = normalizeRecordKey(rawPluginId);
		if (!pluginId || !isRecord(rawPluginState)) {
			changed = true;
			continue;
		}
		if (pluginId !== rawPluginId) changed = true;
		const normalizedPluginState = {};
		for (const [rawNamespace, rawValue] of Object.entries(rawPluginState)) {
			const namespace = normalizeRecordKey(rawNamespace);
			if (!namespace || !isPluginJsonValue(rawValue)) {
				changed = true;
				continue;
			}
			if (namespace !== rawNamespace) changed = true;
			normalizedPluginState[namespace] = rawValue;
		}
		if (Object.keys(normalizedPluginState).length === 0) {
			changed = true;
			continue;
		}
		normalizedExtensions[pluginId] = normalizedPluginState;
	}
	if (!changed) return entry;
	const next = { ...entry };
	if (Object.keys(normalizedExtensions).length > 0) next.pluginExtensions = normalizedExtensions;
	else delete next.pluginExtensions;
	return next;
}
function normalizePluginExtensionSlotKeys(entry) {
	if (entry.pluginExtensionSlotKeys === void 0) return entry;
	if (!isRecord(entry.pluginExtensionSlotKeys)) {
		const next = { ...entry };
		delete next.pluginExtensionSlotKeys;
		return next;
	}
	let changed = false;
	const normalizedSlotKeys = {};
	for (const [rawPluginId, rawPluginSlots] of Object.entries(entry.pluginExtensionSlotKeys)) {
		const pluginId = normalizeRecordKey(rawPluginId);
		if (!pluginId || !isRecord(rawPluginSlots)) {
			changed = true;
			continue;
		}
		if (pluginId !== rawPluginId) changed = true;
		const normalizedPluginSlots = {};
		for (const [rawNamespace, rawSlotKey] of Object.entries(rawPluginSlots)) {
			const namespace = normalizeRecordKey(rawNamespace);
			const slotKey = normalizeSessionEntrySlotKey(rawSlotKey);
			if (!namespace || !slotKey.ok) {
				changed = true;
				continue;
			}
			if (namespace !== rawNamespace || slotKey.key !== rawSlotKey) changed = true;
			normalizedPluginSlots[namespace] = slotKey.key;
		}
		if (Object.keys(normalizedPluginSlots).length === 0) {
			changed = true;
			continue;
		}
		normalizedSlotKeys[pluginId] = normalizedPluginSlots;
	}
	if (!changed) return entry;
	const next = { ...entry };
	if (Object.keys(normalizedSlotKeys).length > 0) next.pluginExtensionSlotKeys = normalizedSlotKeys;
	else delete next.pluginExtensionSlotKeys;
	return next;
}
function sameDeliveryChannelRoute(left, right) {
	return (left?.channel ?? void 0) === (right?.channel ?? void 0) && (left?.accountId ?? void 0) === (right?.accountId ?? void 0) && (left?.target?.to ?? void 0) === (right?.target?.to ?? void 0) && (left?.target?.rawTo ?? void 0) === (right?.target?.rawTo ?? void 0) && (left?.target?.chatType ?? void 0) === (right?.target?.chatType ?? void 0) && (left?.thread?.id ?? void 0) === (right?.thread?.id ?? void 0) && (left?.thread?.kind ?? void 0) === (right?.thread?.kind ?? void 0) && (left?.thread?.source ?? void 0) === (right?.thread?.source ?? void 0);
}
function normalizeSessionEntryDelivery(entry) {
	const entryRoute = normalizeDeliveryChannelRoute(entry.route);
	const normalized = normalizeSessionDeliveryFields({
		route: entryRoute,
		channel: entry.channel,
		lastChannel: entry.lastChannel,
		lastTo: entry.lastTo,
		lastAccountId: entry.lastAccountId,
		lastThreadId: entry.lastThreadId ?? entry.deliveryContext?.threadId ?? entry.origin?.threadId,
		deliveryContext: entry.deliveryContext
	});
	const nextDelivery = normalized.deliveryContext;
	const sameDelivery = (entry.deliveryContext?.channel ?? void 0) === nextDelivery?.channel && (entry.deliveryContext?.to ?? void 0) === nextDelivery?.to && (entry.deliveryContext?.accountId ?? void 0) === nextDelivery?.accountId && (entry.deliveryContext?.threadId ?? void 0) === nextDelivery?.threadId;
	const sameLast = sameDeliveryChannelRoute(entryRoute, normalized.route) && entry.lastChannel === normalized.lastChannel && entry.lastTo === normalized.lastTo && entry.lastAccountId === normalized.lastAccountId && entry.lastThreadId === normalized.lastThreadId;
	if (sameDelivery && sameLast) return entry;
	return {
		...entry,
		route: normalized.route,
		deliveryContext: nextDelivery,
		lastChannel: normalized.lastChannel,
		lastTo: normalized.lastTo,
		lastAccountId: normalized.lastAccountId,
		lastThreadId: normalized.lastThreadId
	};
}
function stripPersistedSkillsCache(entry) {
	const snapshot = entry.skillsSnapshot;
	if (!snapshot || snapshot.resolvedSkills === void 0) return entry;
	const { resolvedSkills: _drop, ...rest } = snapshot;
	return {
		...entry,
		skillsSnapshot: rest
	};
}
function normalizeSessionStore(store) {
	let changed = false;
	for (const [key, entry] of Object.entries(store)) {
		const shaped = normalizePersistedSessionEntryShape(entry);
		if (!shaped) {
			delete store[key];
			changed = true;
			continue;
		}
		const normalized = stripPersistedSkillsCache(normalizePluginExtensionSlotKeys(normalizePluginExtensions(normalizePendingFinalDeliveryFields(normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(shaped))))));
		internSessionEntryLargeStrings(normalized);
		if (normalized !== entry) {
			store[key] = normalized;
			changed = true;
		}
	}
	return changed;
}
function loadSessionStore(storePath, opts = {}) {
	if (!opts.skipCache && isSessionStoreCacheEnabled()) {
		const currentFileStat = getFileStatSnapshot(storePath);
		const cached = readSessionStoreCache({
			storePath,
			mtimeMs: currentFileStat?.mtimeMs,
			sizeBytes: currentFileStat?.sizeBytes,
			clone: opts.clone
		});
		if (cached) return cached;
	}
	let store = {};
	let fileStat = getFileStatSnapshot(storePath);
	let mtimeMs = fileStat?.mtimeMs;
	let serializedFromDisk;
	const maxReadAttempts = process.platform === "win32" ? 3 : 1;
	const retryBuf = maxReadAttempts > 1 ? new Int32Array(new SharedArrayBuffer(4)) : void 0;
	for (let attempt = 0; attempt < maxReadAttempts; attempt += 1) try {
		const raw = fs.readFileSync(storePath, "utf-8");
		if (raw.length === 0 && attempt < maxReadAttempts - 1) {
			Atomics.wait(retryBuf, 0, 0, 50);
			continue;
		}
		const parsed = JSON.parse(raw);
		if (isSessionStoreRecord(parsed)) {
			store = parsed;
			serializedFromDisk = raw;
		}
		break;
	} catch {
		if (attempt < maxReadAttempts - 1) {
			Atomics.wait(retryBuf, 0, 0, 50);
			continue;
		}
	}
	const migrated = applySessionStoreMigrations(store);
	const normalized = normalizeSessionStore(store);
	if (migrated || normalized) serializedFromDisk = void 0;
	if (opts.runMaintenance) {
		const maintenance = opts.maintenanceConfig ?? resolveMaintenanceConfig();
		const beforeCount = Object.keys(store).length;
		let pruned = 0;
		let capped = 0;
		if (maintenance.mode === "enforce" && beforeCount > maintenance.maxEntries) {
			const preserveSessionKeys = collectSessionMaintenancePreserveKeys();
			pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, {
				log: false,
				preserveKeys: preserveSessionKeys
			});
			const countAfterPrune = Object.keys(store).length;
			capped = shouldRunSessionEntryMaintenance({
				entryCount: countAfterPrune,
				maxEntries: maintenance.maxEntries
			}) ? capEntryCount(store, maintenance.maxEntries, {
				log: false,
				preserveKeys: preserveSessionKeys
			}) : 0;
		}
		const afterCount = Object.keys(store).length;
		if (pruned > 0 || capped > 0) {
			serializedFromDisk = void 0;
			log.info("applied load-time maintenance to session store", {
				storePath,
				before: beforeCount,
				after: afterCount,
				pruned,
				capped,
				maxEntries: maintenance.maxEntries
			});
		}
	}
	setSerializedSessionStore(storePath, serializedFromDisk);
	if (!opts.skipCache && isSessionStoreCacheEnabled()) writeSessionStoreCache({
		storePath,
		store,
		mtimeMs,
		sizeBytes: fileStat?.sizeBytes,
		serialized: serializedFromDisk
	});
	return opts.clone === false ? store : cloneSessionStoreRecord(store, serializedFromDisk);
}
function readSessionStoreSnapshot(storePath) {
	const currentFileStat = getFileStatSnapshot(storePath);
	if (isSessionStoreCacheEnabled()) {
		const cached = readSessionStoreSnapshotCache({
			storePath,
			mtimeMs: currentFileStat?.mtimeMs,
			sizeBytes: currentFileStat?.sizeBytes
		});
		if (cached) return cached;
	}
	const store = loadSessionStore(storePath);
	if (!isSessionStoreCacheEnabled()) return cloneSessionStoreSnapshot(store);
	return writeSessionStoreSnapshotCache({
		storePath,
		store,
		mtimeMs: currentFileStat?.mtimeMs,
		sizeBytes: currentFileStat?.sizeBytes
	});
}
function readSessionEntry(storePath, sessionKey) {
	return resolveSessionStoreEntry({
		store: readSessionStoreSnapshot(storePath),
		sessionKey
	}).existing;
}
function readSessionEntries(storePath) {
	return Object.entries(readSessionStoreSnapshot(storePath));
}
//#endregion
export { createExpiringMapCache as A, pruneStaleEntries as C, parseSessionThreadInfo as D, shouldRunSessionEntryMaintenance as E, resolveSessionStoreEntry as F, isCacheEnabled as M, resolveCacheTtlMs as N, parseSessionThreadInfoFast as O, normalizeStoreSessionKey as P, pruneQuotaSuspensions as S, shouldPreserveMaintenanceEntry as T, takeMutableSessionStoreCache as _, readSessionStoreSnapshot as a, capEntryCount as b, registerSessionMaintenancePreserveKeysProvider as c, cloneSessionStoreRecord as d, dropSessionStoreObjectCache as f, setSerializedSessionStore as g, isSessionStoreCacheEnabled as h, readSessionEntry as i, getFileStatSnapshot as j, resolveLoadedSessionThreadInfo as k, normalizeSessionEntrySlotKey as l, getSerializedSessionStore as m, normalizeSessionStore as n, resolveMaintenanceConfig as o, dropSessionStoreSnapshotCache as p, readSessionEntries as r, collectSessionMaintenancePreserveKeys as s, loadSessionStore as t, clearSessionStoreCaches as u, writeSessionStoreCache as v, resolveMaintenanceConfigFromInput as w, getActiveSessionMaintenanceWarning as x, writeSessionStoreSnapshotCache as y };
