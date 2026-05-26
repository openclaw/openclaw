import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { s as normalizeSessionPeerId } from "./session-key-utils-Ce_xWkNq.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { i as normalizeHyphenSlug } from "./string-normalization-DiPHgdft.js";
import { s as writeTextAtomic } from "./json-files-C2hqjU--.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { l as listDeliverableMessageChannels, u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { i as mergeDeliveryContext, n as deliveryContextFromSession, o as normalizeDeliveryContext, s as normalizeSessionDeliveryFields, t as deliveryContextFromChannelRoute } from "./delivery-context.shared-CBmB9dF7.js";
import { i as isSessionArchiveArtifactName, n as isCompactionCheckpointTranscriptFileName, r as isPrimarySessionTranscriptFileName, s as isTrajectorySessionArtifactName } from "./artifacts-BZhcmsUl.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { C as pruneStaleEntries, E as shouldRunSessionEntryMaintenance, F as resolveSessionStoreEntry, P as normalizeStoreSessionKey, S as pruneQuotaSuspensions, T as shouldPreserveMaintenanceEntry, _ as takeMutableSessionStoreCache, b as capEntryCount, d as cloneSessionStoreRecord, f as dropSessionStoreObjectCache, g as setSerializedSessionStore, h as isSessionStoreCacheEnabled, i as readSessionEntry, j as getFileStatSnapshot, m as getSerializedSessionStore, n as normalizeSessionStore, o as resolveMaintenanceConfig, p as dropSessionStoreSnapshotCache, r as readSessionEntries, s as collectSessionMaintenancePreserveKeys, t as loadSessionStore, u as clearSessionStoreCaches, v as writeSessionStoreCache, x as getActiveSessionMaintenanceWarning, y as writeSessionStoreSnapshotCache } from "./store-load-z4thf6ld.js";
import { a as resolveTrajectoryPointerFilePath, i as resolveTrajectoryFilePath } from "./paths-CzW2SUx5.js";
import { a as normalizeChannelId, i as listChannelPlugins, n as getLoadedChannelPlugin } from "./registry-Bf5TpUad.js";
import { t as normalizeChatType } from "./chat-type-D_QPUzR1.js";
import { t as resolveConversationLabel } from "./conversation-label-CQhOGKqx.js";
import "./plugins-DYTHbmt7.js";
import { n as mergeSessionEntry, r as mergeSessionEntryPreserveActivity } from "./types-BgvyBC-3.js";
import fs from "node:fs";
import path from "node:path";
//#region src/config/sessions/disk-budget.ts
const NOOP_LOGGER = {
	warn: () => {},
	info: () => {}
};
function canonicalizePathForComparison(filePath) {
	const resolved = path.resolve(filePath);
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}
function measureStoreBytes(store) {
	return Buffer.byteLength(JSON.stringify(store, null, 2), "utf-8");
}
function measureStoreEntryChunkBytes(key, entry) {
	const singleEntryStore = JSON.stringify({ [key]: entry }, null, 2);
	if (!singleEntryStore.startsWith("{\n") || !singleEntryStore.endsWith("\n}")) return measureStoreBytes({ [key]: entry }) - 4;
	const chunk = singleEntryStore.slice(2, -2);
	return Buffer.byteLength(chunk, "utf-8");
}
function buildStoreEntryChunkSizeMap(store) {
	const out = /* @__PURE__ */ new Map();
	for (const [key, entry] of Object.entries(store)) out.set(key, measureStoreEntryChunkBytes(key, entry));
	return out;
}
function getEntryUpdatedAt(entry) {
	if (!entry) return 0;
	const updatedAt = entry.updatedAt;
	return Number.isFinite(updatedAt) ? updatedAt : 0;
}
function buildSessionIdRefCounts(store) {
	const counts = /* @__PURE__ */ new Map();
	for (const entry of Object.values(store)) {
		const sessionId = entry?.sessionId;
		if (!sessionId) continue;
		counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
	}
	return counts;
}
function resolveSessionTranscriptPathForEntry(params) {
	if (!params.entry.sessionId) return null;
	try {
		const resolved = resolveSessionFilePath(params.entry.sessionId, params.entry, { sessionsDir: params.sessionsDir });
		const resolvedSessionsDir = canonicalizePathForComparison(params.sessionsDir);
		const resolvedPath = canonicalizePathForComparison(resolved);
		const relative = path.relative(resolvedSessionsDir, resolvedPath);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
		return resolvedPath;
	} catch {
		return null;
	}
}
function resolveSessionArtifactPathsForEntry(params) {
	const transcriptPath = resolveSessionTranscriptPathForEntry(params);
	if (!transcriptPath) return [];
	const paths = [transcriptPath];
	if (params.entry.sessionId) {
		paths.push(resolveTrajectoryPointerFilePath(transcriptPath));
		paths.push(resolveTrajectoryFilePath({
			env: {},
			sessionFile: transcriptPath,
			sessionId: params.entry.sessionId
		}));
	}
	return paths;
}
function resolveSessionArtifactCanonicalPathsForEntry(params) {
	return resolveSessionArtifactPathsForEntry(params).map(canonicalizePathForComparison);
}
function resolveReferencedSessionArtifactPaths(params) {
	const referenced = /* @__PURE__ */ new Set();
	const resolvedSessionsDir = canonicalizePathForComparison(params.sessionsDir);
	for (const entry of Object.values(params.store)) {
		for (const resolved of resolveSessionArtifactCanonicalPathsForEntry({
			sessionsDir: params.sessionsDir,
			entry
		})) referenced.add(resolved);
		for (const checkpoint of entry.compactionCheckpoints ?? []) {
			const checkpointFile = checkpoint.preCompaction.sessionFile?.trim();
			if (!checkpointFile) continue;
			const resolvedCheckpointPath = canonicalizePathForComparison(checkpointFile);
			const relative = path.relative(resolvedSessionsDir, resolvedCheckpointPath);
			if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) referenced.add(resolvedCheckpointPath);
		}
	}
	return referenced;
}
async function readSessionsDirFiles(sessionsDir) {
	const dirEntries = await fs.promises.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
	const files = [];
	for (const dirent of dirEntries) {
		if (!dirent.isFile()) continue;
		const filePath = path.join(sessionsDir, dirent.name);
		const stat = await fs.promises.stat(filePath).catch(() => null);
		if (!stat?.isFile()) continue;
		files.push({
			path: filePath,
			canonicalPath: canonicalizePathForComparison(filePath),
			name: dirent.name,
			size: stat.size,
			mtimeMs: stat.mtimeMs
		});
	}
	return files;
}
function isUnreferencedSessionArtifactFile(file, referencedPaths) {
	if (referencedPaths.has(file.canonicalPath)) return false;
	return isCompactionCheckpointTranscriptFileName(file.name) || isTrajectorySessionArtifactName(file.name) || isPrimarySessionTranscriptFileName(file.name);
}
function isDiskBudgetRemovableSessionFile(file, referencedPaths) {
	return isSessionArchiveArtifactName(file.name) || isUnreferencedSessionArtifactFile(file, referencedPaths);
}
async function removeFileIfExists(filePath) {
	const stat = await fs.promises.stat(filePath).catch(() => null);
	if (!stat?.isFile()) return 0;
	await fs.promises.rm(filePath, { force: true }).catch(() => void 0);
	return stat.size;
}
async function removeFileForBudget(params) {
	const resolvedPath = path.resolve(params.filePath);
	const canonicalPath = params.canonicalPath ?? canonicalizePathForComparison(resolvedPath);
	if (params.dryRun) {
		if (params.simulatedRemovedPaths.has(canonicalPath)) return 0;
		const size = params.fileSizesByPath.get(canonicalPath) ?? 0;
		if (size <= 0) return 0;
		params.simulatedRemovedPaths.add(canonicalPath);
		params.onRemovedPath?.(canonicalPath);
		return size;
	}
	const size = await removeFileIfExists(resolvedPath);
	if (size > 0) params.onRemovedPath?.(canonicalPath);
	return size;
}
async function pruneUnreferencedSessionArtifacts(params) {
	const olderThanMs = Number.isFinite(params.olderThanMs) && params.olderThanMs > 0 ? params.olderThanMs : 0;
	const sessionsDir = path.dirname(params.storePath);
	const files = await readSessionsDirFiles(sessionsDir);
	const fileSizesByPath = new Map(files.map((file) => [file.canonicalPath, file.size]));
	const simulatedRemovedPaths = /* @__PURE__ */ new Set();
	const referencedPaths = resolveReferencedSessionArtifactPaths({
		sessionsDir,
		store: params.store
	});
	const cutoffMs = Date.now() - olderThanMs;
	const removableFiles = files.filter((file) => !params.excludeCanonicalPaths?.has(file.canonicalPath) && file.mtimeMs <= cutoffMs && isUnreferencedSessionArtifactFile(file, referencedPaths)).toSorted((a, b) => a.mtimeMs - b.mtimeMs);
	let removedFiles = 0;
	let freedBytes = 0;
	for (const file of removableFiles) {
		const deletedBytes = await removeFileForBudget({
			filePath: file.path,
			canonicalPath: file.canonicalPath,
			dryRun: params.dryRun === true,
			fileSizesByPath,
			simulatedRemovedPaths
		});
		if (deletedBytes <= 0) continue;
		removedFiles += 1;
		freedBytes += deletedBytes;
	}
	return {
		scannedFiles: files.length,
		removedFiles,
		freedBytes,
		olderThanMs
	};
}
async function enforceSessionDiskBudget(params) {
	const maxBytes = params.maintenance.maxDiskBytes;
	const highWaterBytes = params.maintenance.highWaterBytes;
	if (maxBytes == null || highWaterBytes == null) return null;
	const log = params.log ?? NOOP_LOGGER;
	const dryRun = params.dryRun === true;
	const sessionsDir = path.dirname(params.storePath);
	const files = await readSessionsDirFiles(sessionsDir);
	const fileSizesByPath = new Map(files.map((file) => [file.canonicalPath, file.size]));
	const simulatedRemovedPaths = /* @__PURE__ */ new Set();
	const resolvedStorePath = canonicalizePathForComparison(params.storePath);
	const storeFile = files.find((file) => file.canonicalPath === resolvedStorePath);
	let projectedStoreBytes = measureStoreBytes(params.store);
	let total = files.reduce((sum, file) => sum + file.size, 0) - (storeFile?.size ?? 0) + projectedStoreBytes;
	const totalBefore = total;
	if (total <= maxBytes) return {
		totalBytesBefore: totalBefore,
		totalBytesAfter: total,
		removedFiles: 0,
		removedEntries: 0,
		freedBytes: 0,
		maxBytes,
		highWaterBytes,
		overBudget: false
	};
	if (params.warnOnly) {
		log.warn("session disk budget exceeded (warn-only mode)", {
			sessionsDir,
			totalBytes: total,
			maxBytes,
			highWaterBytes
		});
		return {
			totalBytesBefore: totalBefore,
			totalBytesAfter: total,
			removedFiles: 0,
			removedEntries: 0,
			freedBytes: 0,
			maxBytes,
			highWaterBytes,
			overBudget: true
		};
	}
	let removedFiles = 0;
	let removedEntries = 0;
	let freedBytes = 0;
	const referencedPaths = resolveReferencedSessionArtifactPaths({
		sessionsDir,
		store: params.store
	});
	const removableFileQueue = files.filter((file) => isDiskBudgetRemovableSessionFile(file, referencedPaths)).toSorted((a, b) => a.mtimeMs - b.mtimeMs);
	for (const file of removableFileQueue) {
		if (total <= highWaterBytes) break;
		const deletedBytes = await removeFileForBudget({
			filePath: file.path,
			canonicalPath: file.canonicalPath,
			dryRun,
			fileSizesByPath,
			simulatedRemovedPaths,
			onRemovedPath: params.onRemoveFile
		});
		if (deletedBytes <= 0) continue;
		total -= deletedBytes;
		freedBytes += deletedBytes;
		removedFiles += 1;
	}
	if (total > highWaterBytes) {
		const activeSessionKey = normalizeOptionalLowercaseString(params.activeSessionKey);
		const sessionIdRefCounts = buildSessionIdRefCounts(params.store);
		const entryChunkBytesByKey = buildStoreEntryChunkSizeMap(params.store);
		const keys = Object.keys(params.store).toSorted((a, b) => {
			return getEntryUpdatedAt(params.store[a]) - getEntryUpdatedAt(params.store[b]);
		});
		for (const key of keys) {
			if (total <= highWaterBytes) break;
			if (activeSessionKey && normalizeLowercaseStringOrEmpty(key) === activeSessionKey) continue;
			const entry = params.store[key];
			if (!entry) continue;
			if (shouldPreserveMaintenanceEntry({
				key,
				entry,
				preserveKeys: params.preserveKeys
			})) continue;
			const previousProjectedBytes = projectedStoreBytes;
			delete params.store[key];
			const chunkBytes = entryChunkBytesByKey.get(key);
			entryChunkBytesByKey.delete(key);
			if (typeof chunkBytes === "number" && Number.isFinite(chunkBytes) && chunkBytes >= 0) projectedStoreBytes = Math.max(2, projectedStoreBytes - (chunkBytes + 2));
			else projectedStoreBytes = measureStoreBytes(params.store);
			total += projectedStoreBytes - previousProjectedBytes;
			removedEntries += 1;
			const sessionId = entry.sessionId;
			if (!sessionId) continue;
			const nextRefCount = (sessionIdRefCounts.get(sessionId) ?? 1) - 1;
			if (nextRefCount > 0) {
				sessionIdRefCounts.set(sessionId, nextRefCount);
				continue;
			}
			sessionIdRefCounts.delete(sessionId);
			for (const artifactPath of resolveSessionArtifactPathsForEntry({
				sessionsDir,
				entry
			})) {
				const deletedBytes = await removeFileForBudget({
					filePath: artifactPath,
					dryRun,
					fileSizesByPath,
					simulatedRemovedPaths,
					onRemovedPath: params.onRemoveFile
				});
				if (deletedBytes <= 0) continue;
				total -= deletedBytes;
				freedBytes += deletedBytes;
				removedFiles += 1;
			}
		}
	}
	if (!dryRun) {
		if (total > highWaterBytes) log.warn("session disk budget still above high-water target after cleanup", {
			sessionsDir,
			totalBytes: total,
			maxBytes,
			highWaterBytes,
			removedFiles,
			removedEntries
		});
		else if (removedFiles > 0 || removedEntries > 0) log.info("applied session disk budget cleanup", {
			sessionsDir,
			totalBytesBefore: totalBefore,
			totalBytesAfter: total,
			maxBytes,
			highWaterBytes,
			removedFiles,
			removedEntries
		});
	}
	return {
		totalBytesBefore: totalBefore,
		totalBytesAfter: total,
		removedFiles,
		removedEntries,
		freedBytes,
		maxBytes,
		highWaterBytes,
		overBudget: true
	};
}
//#endregion
//#region src/config/sessions/group.ts
const getGroupSurfaces = () => new Set([...listDeliverableMessageChannels(), "webchat"]);
function resolveLegacyGroupSessionKey(ctx) {
	for (const plugin of listChannelPlugins()) {
		const resolved = plugin.messaging?.resolveLegacyGroupSessionKey?.(ctx);
		if (resolved) return resolved;
	}
	return null;
}
function normalizeGroupLabel(raw) {
	return normalizeHyphenSlug(raw);
}
function resolveOriginatingGroupTargetId(params) {
	const target = normalizeOptionalString(params.ctx.OriginatingTo ?? params.ctx.To) ?? "";
	if (!target) return null;
	const parts = target.split(":").filter(Boolean);
	if (parts.length < 2) return null;
	const head = normalizeLowercaseStringOrEmpty(parts[0]);
	const second = normalizeOptionalLowercaseString(parts[1]);
	if ((second === "group" || second === "channel") && (head === params.provider || getGroupSurfaces().has(head))) return parts.slice(2).join(":") || null;
	if (head === params.provider || head === "chat" || head === "room" || head === "group") return parts.slice(1).join(":") || null;
	if (head === "channel") return parts.slice(1).join(":") || null;
	return null;
}
function shortenGroupId(value) {
	const trimmed = normalizeOptionalString(value) ?? "";
	if (!trimmed) return "";
	if (trimmed.length <= 14) return trimmed;
	return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}
function buildGroupDisplayName(params) {
	const providerKey = normalizeOptionalLowercaseString(params.provider) ?? "group";
	const groupChannel = normalizeOptionalString(params.groupChannel);
	const space = normalizeOptionalString(params.space);
	const subject = normalizeOptionalString(params.subject);
	const detail = (groupChannel && space ? `${space}${groupChannel.startsWith("#") ? "" : "#"}${groupChannel}` : groupChannel || subject || space || "") || "";
	const fallbackId = normalizeOptionalString(params.id) ?? params.key;
	const rawLabel = detail || fallbackId;
	let token = normalizeGroupLabel(rawLabel);
	if (!token) token = normalizeGroupLabel(shortenGroupId(rawLabel));
	if (!params.groupChannel && token.startsWith("#")) token = token.replace(/^#+/, "");
	if (token && !/^[@#]/.test(token) && !token.startsWith("g-") && !token.includes("#")) token = `g-${token}`;
	return token ? `${providerKey}:${token}` : providerKey;
}
function resolveGroupSessionKey(ctx) {
	const from = normalizeOptionalString(ctx.From) ?? "";
	const chatType = normalizeOptionalLowercaseString(ctx.ChatType);
	const normalizedChatType = chatType === "channel" ? "channel" : chatType === "group" ? "group" : void 0;
	const legacyResolution = resolveLegacyGroupSessionKey(ctx);
	if (!(normalizedChatType === "group" || normalizedChatType === "channel" || from.includes(":group:") || from.includes(":channel:") || legacyResolution !== null)) return null;
	const providerHint = normalizeOptionalLowercaseString(ctx.Provider);
	const parts = from.split(":").filter(Boolean);
	const head = normalizeLowercaseStringOrEmpty(parts[0]);
	const headIsSurface = head ? getGroupSurfaces().has(head) : false;
	if (!headIsSurface && !providerHint && legacyResolution) return legacyResolution;
	const provider = headIsSurface ? head : providerHint ?? legacyResolution?.channel;
	if (!provider) return null;
	const second = normalizeOptionalLowercaseString(parts[1]);
	const secondIsKind = second === "group" || second === "channel";
	const kind = secondIsKind ? second : from.includes(":channel:") || normalizedChatType === "channel" ? "channel" : "group";
	const originatingGroupTargetId = !secondIsKind && normalizedChatType ? resolveOriginatingGroupTargetId({
		ctx,
		provider
	}) : null;
	const finalId = normalizeSessionPeerId({
		channel: provider,
		peerKind: kind,
		peerId: originatingGroupTargetId ? originatingGroupTargetId : headIsSurface ? secondIsKind ? parts.slice(2).join(":") : parts.slice(1).join(":") : from
	});
	if (!finalId) return null;
	return {
		key: `${provider}:${kind}:${finalId}`,
		channel: provider,
		id: finalId,
		chatType: kind === "channel" ? "channel" : "group"
	};
}
//#endregion
//#region src/config/sessions/metadata.ts
const mergeOrigin = (existing, next) => {
	if (!existing && !next) return;
	const merged = existing ? { ...existing } : {};
	if (next?.label) merged.label = next.label;
	if (next?.provider) merged.provider = next.provider;
	if (next?.surface) merged.surface = next.surface;
	if (next?.chatType) merged.chatType = next.chatType;
	if (next?.from) merged.from = next.from;
	if (next?.to) merged.to = next.to;
	if (next?.nativeChannelId) merged.nativeChannelId = next.nativeChannelId;
	if (next?.nativeDirectUserId) merged.nativeDirectUserId = next.nativeDirectUserId;
	if (next?.accountId) merged.accountId = next.accountId;
	if (next?.threadId != null && next.threadId !== "") merged.threadId = next.threadId;
	return Object.keys(merged).length > 0 ? merged : void 0;
};
function deriveSessionOrigin(ctx, opts) {
	const isSystemEventProvider = ctx.Provider === "heartbeat" || ctx.Provider === "cron-event" || ctx.Provider === "exec-event";
	if (opts?.skipSystemEventOrigin && isSystemEventProvider) return;
	const label = normalizeOptionalString(resolveConversationLabel(ctx));
	const provider = normalizeMessageChannel(typeof ctx.OriginatingChannel === "string" && ctx.OriginatingChannel || ctx.Surface || ctx.Provider);
	const surface = normalizeOptionalLowercaseString(ctx.Surface);
	const chatType = normalizeChatType(ctx.ChatType) ?? void 0;
	const from = normalizeOptionalString(ctx.From);
	const to = normalizeOptionalString(typeof ctx.OriginatingTo === "string" ? ctx.OriginatingTo : ctx.To);
	const nativeChannelId = normalizeOptionalString(ctx.NativeChannelId);
	const nativeDirectUserId = normalizeOptionalString(ctx.NativeDirectUserId);
	const accountId = normalizeOptionalString(ctx.AccountId);
	const threadId = ctx.MessageThreadId ?? void 0;
	const origin = {};
	if (label) origin.label = label;
	if (provider) origin.provider = provider;
	if (surface) origin.surface = surface;
	if (chatType) origin.chatType = chatType;
	if (from) origin.from = from;
	if (to) origin.to = to;
	if (nativeChannelId) origin.nativeChannelId = nativeChannelId;
	if (nativeDirectUserId) origin.nativeDirectUserId = nativeDirectUserId;
	if (accountId) origin.accountId = accountId;
	if (threadId != null && threadId !== "") origin.threadId = threadId;
	return Object.keys(origin).length > 0 ? origin : void 0;
}
function snapshotSessionOrigin(entry) {
	if (!entry?.origin) return;
	return { ...entry.origin };
}
function deriveGroupSessionPatch(params) {
	const resolution = params.groupResolution ?? resolveGroupSessionKey(params.ctx);
	if (!resolution?.channel) return null;
	const channel = resolution.channel;
	const subject = params.ctx.GroupSubject?.trim();
	const space = params.ctx.GroupSpace?.trim();
	const explicitChannel = params.ctx.GroupChannel?.trim();
	const subjectLooksChannel = Boolean(subject?.startsWith("#"));
	const normalizedChannel = subjectLooksChannel && resolution.chatType !== "channel" ? normalizeChannelId(channel) : null;
	const isChannelProvider = Boolean(normalizedChannel && getLoadedChannelPlugin(normalizedChannel)?.capabilities.chatTypes.includes("channel"));
	const nextGroupChannel = explicitChannel ?? (subjectLooksChannel && subject && (resolution.chatType === "channel" || isChannelProvider) ? subject : void 0);
	const nextSubject = nextGroupChannel ? void 0 : subject;
	const patch = {
		chatType: resolution.chatType ?? "group",
		channel,
		groupId: resolution.id
	};
	if (nextSubject) patch.subject = nextSubject;
	if (nextGroupChannel) patch.groupChannel = nextGroupChannel;
	if (space) patch.space = space;
	const displayName = buildGroupDisplayName({
		provider: channel,
		subject: nextSubject ?? params.existing?.subject,
		groupChannel: nextGroupChannel ?? params.existing?.groupChannel,
		space: space ?? params.existing?.space,
		id: resolution.id,
		key: params.sessionKey
	});
	if (displayName) patch.displayName = displayName;
	return patch;
}
function deriveSessionMetaPatch(params) {
	const groupPatch = deriveGroupSessionPatch(params);
	const origin = deriveSessionOrigin(params.ctx, { skipSystemEventOrigin: params.skipSystemEventOrigin });
	if (!groupPatch && !origin) return null;
	const patch = groupPatch ? { ...groupPatch } : {};
	const mergedOrigin = mergeOrigin(params.existing?.origin, origin);
	if (mergedOrigin) patch.origin = mergedOrigin;
	return Object.keys(patch).length > 0 ? patch : null;
}
//#endregion
//#region src/config/sessions/store-writer-state.ts
const WRITER_QUEUES = /* @__PURE__ */ new Map();
function clearSessionStoreCacheForTest() {
	clearSessionStoreCaches();
	for (const queue of WRITER_QUEUES.values()) for (const task of queue.pending) task.reject(/* @__PURE__ */ new Error("session store queue cleared for test"));
	WRITER_QUEUES.clear();
}
async function drainSessionStoreWriterQueuesForTest() {
	while (WRITER_QUEUES.size > 0) {
		const queues = [...WRITER_QUEUES.values()];
		for (const queue of queues) {
			for (const task of queue.pending) task.reject(/* @__PURE__ */ new Error("session store queue cleared for test"));
			queue.pending.length = 0;
		}
		const activeDrains = queues.flatMap((queue) => queue.drainPromise ? [queue.drainPromise] : []);
		if (activeDrains.length === 0) {
			WRITER_QUEUES.clear();
			return;
		}
		await Promise.allSettled(activeDrains);
	}
}
//#endregion
//#region src/config/sessions/store-writer.ts
function getOrCreateWriterQueue(storePath) {
	const existing = WRITER_QUEUES.get(storePath);
	if (existing) return existing;
	const created = {
		running: false,
		pending: [],
		drainPromise: null
	};
	WRITER_QUEUES.set(storePath, created);
	return created;
}
async function drainSessionStoreWriterQueue(storePath) {
	const queue = WRITER_QUEUES.get(storePath);
	if (!queue) return;
	if (queue.drainPromise) {
		await queue.drainPromise;
		return;
	}
	queue.running = true;
	queue.drainPromise = (async () => {
		try {
			while (queue.pending.length > 0) {
				const task = queue.pending.shift();
				if (!task) continue;
				let result;
				let failed;
				let hasFailure = false;
				try {
					result = await task.fn();
				} catch (err) {
					hasFailure = true;
					failed = err;
				}
				if (hasFailure) {
					task.reject(failed);
					continue;
				}
				task.resolve(result);
			}
		} finally {
			queue.running = false;
			queue.drainPromise = null;
			if (queue.pending.length === 0) WRITER_QUEUES.delete(storePath);
			else queueMicrotask(() => {
				drainSessionStoreWriterQueue(storePath);
			});
		}
	})();
	await queue.drainPromise;
}
async function runExclusiveSessionStoreWrite(storePath, fn) {
	if (!storePath || typeof storePath !== "string") throw new Error(`runExclusiveSessionStoreWrite: storePath must be a non-empty string, got ${JSON.stringify(storePath)}`);
	const queue = getOrCreateWriterQueue(storePath);
	return await new Promise((resolve, reject) => {
		const task = {
			fn: async () => await fn(),
			resolve: (value) => resolve(value),
			reject
		};
		queue.pending.push(task);
		drainSessionStoreWriterQueue(storePath);
	});
}
//#endregion
//#region src/config/sessions/store.ts
const log = createSubsystemLogger("sessions/store");
let sessionArchiveRuntimePromise = null;
let trajectoryCleanupRuntimePromise = null;
function loadSessionArchiveRuntime() {
	sessionArchiveRuntimePromise ??= import("./session-archive.runtime.js");
	return sessionArchiveRuntimePromise;
}
function loadTrajectoryCleanupRuntime() {
	trajectoryCleanupRuntimePromise ??= import("./cleanup-i9QIMqva.js");
	return trajectoryCleanupRuntimePromise;
}
function removeThreadFromDeliveryContext(context) {
	if (!context || context.threadId == null) return context;
	const next = { ...context };
	delete next.threadId;
	return next;
}
function readSessionUpdatedAt(params) {
	try {
		return readSessionEntry(params.storePath, params.sessionKey)?.updatedAt;
	} catch {
		return;
	}
}
function cloneSessionEntry(entry) {
	return cloneSessionStoreRecord({ entry }).entry;
}
function resolveSessionWorkflowStorePath(options) {
	if (options.storePath) return options.storePath;
	const agentId = options.agentId ?? resolveAgentIdFromSessionKey(options.sessionKey);
	return resolveStorePath(getRuntimeConfig().session?.store, {
		agentId,
		env: options.env
	});
}
function getSessionEntry(options) {
	const entry = readSessionEntry(resolveSessionWorkflowStorePath(options), options.sessionKey);
	return entry ? cloneSessionEntry(entry) : void 0;
}
function listSessionEntries(options = {}) {
	return readSessionEntries(resolveSessionWorkflowStorePath(options)).map(([sessionKey, entry]) => ({
		sessionKey,
		entry: cloneSessionEntry(entry)
	}));
}
function updateSessionStoreWriteCaches(params) {
	const fileStat = getFileStatSnapshot(params.storePath);
	setSerializedSessionStore(params.storePath, params.serialized);
	if (!isSessionStoreCacheEnabled()) {
		dropSessionStoreObjectCache(params.storePath);
		dropSessionStoreSnapshotCache(params.storePath);
		return;
	}
	writeSessionStoreCache({
		storePath: params.storePath,
		store: params.store,
		mtimeMs: fileStat?.mtimeMs,
		sizeBytes: fileStat?.sizeBytes,
		serialized: params.serialized
	});
	writeSessionStoreSnapshotCache({
		storePath: params.storePath,
		store: params.store,
		mtimeMs: fileStat?.mtimeMs,
		sizeBytes: fileStat?.sizeBytes
	});
}
function loadMutableSessionStoreForWriter(storePath) {
	if (isSessionStoreCacheEnabled()) {
		const currentFileStat = getFileStatSnapshot(storePath);
		const cached = takeMutableSessionStoreCache({
			storePath,
			mtimeMs: currentFileStat?.mtimeMs,
			sizeBytes: currentFileStat?.sizeBytes
		});
		if (cached) return cached;
	}
	return loadSessionStore(storePath, {
		skipCache: true,
		clone: false
	});
}
function resolveMutableSessionStoreKey(store, sessionKey) {
	const trimmed = sessionKey.trim();
	if (!trimmed) return;
	if (Object.prototype.hasOwnProperty.call(store, trimmed)) return trimmed;
	const normalized = normalizeStoreSessionKey(trimmed);
	if (Object.prototype.hasOwnProperty.call(store, normalized)) return normalized;
	return Object.keys(store).find((key) => normalizeStoreSessionKey(key) === normalized);
}
function collectAcpMetadataSnapshot(store) {
	const snapshot = /* @__PURE__ */ new Map();
	for (const [sessionKey, entry] of Object.entries(store)) if (entry?.acp) snapshot.set(sessionKey, entry.acp);
	return snapshot;
}
function preserveExistingAcpMetadata(params) {
	const allowDrop = new Set((params.allowDropSessionKeys ?? []).map((key) => normalizeStoreSessionKey(key)));
	for (const [previousKey, previousAcp] of params.previousAcpByKey.entries()) {
		const normalizedKey = normalizeStoreSessionKey(previousKey);
		if (allowDrop.has(normalizedKey)) continue;
		const nextKey = resolveMutableSessionStoreKey(params.nextStore, previousKey);
		if (!nextKey) continue;
		const nextEntry = params.nextStore[nextKey];
		if (!nextEntry || nextEntry.acp) continue;
		params.nextStore[nextKey] = {
			...nextEntry,
			acp: previousAcp
		};
	}
}
async function saveSessionStoreUnlocked(storePath, store, opts) {
	normalizeSessionStore(store);
	if (!opts?.skipMaintenance) {
		const maintenance = opts?.maintenanceConfig ? {
			...opts.maintenanceConfig,
			...opts?.maintenanceOverride
		} : {
			...resolveMaintenanceConfig(),
			...opts?.maintenanceOverride
		};
		const shouldWarnOnly = maintenance.mode === "warn";
		const beforeCount = Object.keys(store).length;
		const forceMaintenance = opts?.maintenanceOverride !== void 0;
		const shouldRunEntryMaintenance = shouldRunSessionEntryMaintenance({
			entryCount: beforeCount,
			maxEntries: maintenance.maxEntries,
			force: forceMaintenance
		});
		if (shouldWarnOnly) {
			const activeSessionKey = opts?.activeSessionKey?.trim();
			if (activeSessionKey && shouldRunEntryMaintenance) {
				const warning = getActiveSessionMaintenanceWarning({
					store,
					activeSessionKey,
					pruneAfterMs: maintenance.pruneAfterMs,
					maxEntries: maintenance.maxEntries
				});
				if (warning) {
					log.warn("session maintenance would evict active session; skipping enforcement", {
						activeSessionKey: warning.activeSessionKey,
						wouldPrune: warning.wouldPrune,
						wouldCap: warning.wouldCap,
						pruneAfterMs: warning.pruneAfterMs,
						maxEntries: warning.maxEntries
					});
					await opts?.onWarn?.(warning);
				}
			}
			const diskBudget = await enforceSessionDiskBudget({
				store,
				storePath,
				activeSessionKey: opts?.activeSessionKey,
				maintenance,
				warnOnly: true,
				log
			});
			await opts?.onMaintenanceApplied?.({
				mode: maintenance.mode,
				beforeCount,
				afterCount: Object.keys(store).length,
				pruned: 0,
				capped: 0,
				diskBudget
			});
		} else {
			const preserveSessionKeys = collectSessionMaintenancePreserveKeys([opts?.activeSessionKey]);
			const removedSessionFiles = /* @__PURE__ */ new Map();
			const pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, {
				onPruned: ({ entry }) => {
					rememberRemovedSessionFile(removedSessionFiles, entry);
				},
				preserveKeys: preserveSessionKeys
			});
			const countAfterPrune = Object.keys(store).length;
			const capped = forceMaintenance || shouldRunSessionEntryMaintenance({
				entryCount: countAfterPrune,
				maxEntries: maintenance.maxEntries
			}) ? capEntryCount(store, maintenance.maxEntries, {
				onCapped: ({ entry }) => {
					rememberRemovedSessionFile(removedSessionFiles, entry);
				},
				preserveKeys: preserveSessionKeys
			}) : 0;
			const archivedDirs = /* @__PURE__ */ new Set();
			const referencedSessionIds = new Set(Object.values(store).map((entry) => entry?.sessionId).filter((id) => Boolean(id)));
			const archivedForDeletedSessions = await archiveRemovedSessionTranscripts({
				removedSessionFiles,
				referencedSessionIds,
				storePath,
				reason: "deleted",
				restrictToStoreDir: true
			});
			if (removedSessionFiles.size > 0) {
				const { removeRemovedSessionTrajectoryArtifacts } = await loadTrajectoryCleanupRuntime();
				await removeRemovedSessionTrajectoryArtifacts({
					removedSessionFiles,
					referencedSessionIds,
					storePath,
					restrictToStoreDir: true
				});
			}
			for (const archivedDir of archivedForDeletedSessions) archivedDirs.add(archivedDir);
			if (archivedDirs.size > 0 || maintenance.resetArchiveRetentionMs != null) {
				const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
				const targetDirs = archivedDirs.size > 0 ? [...archivedDirs] : [path.dirname(path.resolve(storePath))];
				await cleanupArchivedSessionTranscripts({
					directories: targetDirs,
					olderThanMs: maintenance.pruneAfterMs,
					reason: "deleted"
				});
				if (maintenance.resetArchiveRetentionMs != null) await cleanupArchivedSessionTranscripts({
					directories: targetDirs,
					olderThanMs: maintenance.resetArchiveRetentionMs,
					reason: "reset"
				});
			}
			const diskBudget = await enforceSessionDiskBudget({
				store,
				storePath,
				activeSessionKey: opts?.activeSessionKey,
				preserveKeys: preserveSessionKeys,
				maintenance,
				warnOnly: false,
				log
			});
			await opts?.onMaintenanceApplied?.({
				mode: maintenance.mode,
				beforeCount,
				afterCount: Object.keys(store).length,
				pruned,
				capped,
				diskBudget
			});
		}
	}
	await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
	const json = JSON.stringify(store, null, 2);
	if (getSerializedSessionStore(storePath) === json) {
		updateSessionStoreWriteCaches({
			storePath,
			store,
			serialized: json
		});
		return;
	}
	if (process.platform === "win32") {
		for (let i = 0; i < 5; i++) try {
			await writeSessionStoreAtomic({
				storePath,
				store,
				serialized: json
			});
			return;
		} catch (err) {
			if (getErrorCode(err) === "ENOENT") return;
			if (i < 4) {
				await new Promise((r) => setTimeout(r, 50 * (i + 1)));
				continue;
			}
			log.warn(`atomic write failed after 5 attempts: ${storePath}`);
		}
		return;
	}
	try {
		await writeSessionStoreAtomic({
			storePath,
			store,
			serialized: json
		});
	} catch (err) {
		if (getErrorCode(err) === "ENOENT") {
			try {
				await writeSessionStoreAtomic({
					storePath,
					store,
					serialized: json
				});
			} catch (err2) {
				if (getErrorCode(err2) === "ENOENT") return;
				throw err2;
			}
			return;
		}
		throw err;
	}
}
async function saveSessionStore(storePath, store, opts) {
	await runExclusiveSessionStoreWrite(storePath, async () => {
		await saveSessionStoreUnlocked(storePath, store, opts);
	});
}
async function updateSessionStore(storePath, mutator, opts) {
	return await runExclusiveSessionStoreWrite(storePath, async () => {
		const store = loadMutableSessionStoreForWriter(storePath);
		const previousAcpByKey = collectAcpMetadataSnapshot(store);
		const result = await mutator(store);
		preserveExistingAcpMetadata({
			previousAcpByKey,
			nextStore: store,
			allowDropSessionKeys: opts?.allowDropAcpMetaSessionKeys
		});
		await saveSessionStoreUnlocked(storePath, store, opts);
		return result;
	});
}
async function runQuotaSuspensionMaintenance(params) {
	if (!fs.existsSync(params.storePath)) return {
		resumed: [],
		cleared: 0
	};
	return await updateSessionStore(params.storePath, (store) => pruneQuotaSuspensions({
		store,
		now: params.now ?? Date.now(),
		ttlMs: params.ttlMs,
		log: params.log
	}), { skipMaintenance: true });
}
function getErrorCode(error) {
	if (!error || typeof error !== "object" || !("code" in error)) return null;
	return String(error.code);
}
function rememberRemovedSessionFile(removedSessionFiles, entry) {
	if (!removedSessionFiles.has(entry.sessionId) || entry.sessionFile) removedSessionFiles.set(entry.sessionId, entry.sessionFile);
}
async function archiveRemovedSessionTranscripts(params) {
	const { archiveSessionTranscripts } = await loadSessionArchiveRuntime();
	const archivedDirs = /* @__PURE__ */ new Set();
	for (const [sessionId, sessionFile] of params.removedSessionFiles) {
		if (params.referencedSessionIds.has(sessionId)) continue;
		const archived = archiveSessionTranscripts({
			sessionId,
			storePath: params.storePath,
			sessionFile,
			reason: params.reason,
			restrictToStoreDir: params.restrictToStoreDir
		});
		for (const archivedPath of archived) archivedDirs.add(path.dirname(archivedPath));
	}
	return archivedDirs;
}
async function writeSessionStoreAtomic(params) {
	await writeTextAtomic(params.storePath, params.serialized, {
		durable: false,
		mode: 384
	});
	updateSessionStoreWriteCaches({
		storePath: params.storePath,
		store: params.store,
		serialized: params.serialized
	});
}
async function persistResolvedSessionEntry(params) {
	params.store[params.resolved.normalizedKey] = params.next;
	for (const legacyKey of params.resolved.legacyKeys) delete params.store[legacyKey];
	await saveSessionStoreUnlocked(params.storePath, params.store, { activeSessionKey: params.resolved.normalizedKey });
	return params.next;
}
async function updateSessionStoreEntry(params) {
	const { storePath, sessionKey, update } = params;
	return await runExclusiveSessionStoreWrite(storePath, async () => {
		const store = loadMutableSessionStoreForWriter(storePath);
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey
		});
		const existing = resolved.existing;
		if (!existing) return null;
		const patch = await update(existing);
		if (!patch) return existing;
		return await persistResolvedSessionEntry({
			storePath,
			store,
			resolved,
			next: mergeSessionEntry(existing, patch)
		});
	});
}
async function patchSessionEntry(params) {
	const storePath = resolveSessionWorkflowStorePath(params);
	return await runExclusiveSessionStoreWrite(storePath, async () => {
		const store = loadMutableSessionStoreForWriter(storePath);
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey: params.sessionKey
		});
		const existing = resolved.existing ?? params.fallbackEntry;
		if (!existing) return null;
		const patch = await params.update(cloneSessionEntry(existing));
		if (!patch) return existing;
		return await persistResolvedSessionEntry({
			storePath,
			store,
			resolved,
			next: params.replaceEntry ? cloneSessionEntry(patch) : params.preserveActivity ? mergeSessionEntryPreserveActivity(existing, patch) : mergeSessionEntry(existing, patch)
		});
	});
}
async function upsertSessionEntry(params) {
	const storePath = resolveSessionWorkflowStorePath(params);
	await runExclusiveSessionStoreWrite(storePath, async () => {
		const store = loadMutableSessionStoreForWriter(storePath);
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey: params.sessionKey
		});
		const next = cloneSessionEntry(params.entry);
		if (!params.allowDropAcpMeta && resolved.existing?.acp && !next.acp) next.acp = resolved.existing.acp;
		await persistResolvedSessionEntry({
			storePath,
			store,
			resolved,
			next
		});
	});
}
async function recordSessionMetaFromInbound(params) {
	const { storePath, sessionKey, ctx } = params;
	const createIfMissing = params.createIfMissing ?? true;
	return await updateSessionStore(storePath, (store) => {
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey
		});
		const existing = resolved.existing;
		const patch = deriveSessionMetaPatch({
			ctx,
			sessionKey: resolved.normalizedKey,
			existing,
			groupResolution: params.groupResolution
		});
		if (!patch) {
			if (existing && resolved.legacyKeys.length > 0) {
				store[resolved.normalizedKey] = existing;
				for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
			}
			return existing ?? null;
		}
		if (!existing && !createIfMissing) return null;
		const next = existing ? mergeSessionEntryPreserveActivity(existing, patch) : mergeSessionEntry(existing, patch);
		store[resolved.normalizedKey] = next;
		for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
		return next;
	}, { activeSessionKey: normalizeStoreSessionKey(sessionKey) });
}
async function updateLastRoute(params) {
	const { storePath, sessionKey, channel, to, accountId, threadId, ctx } = params;
	const createIfMissing = params.createIfMissing ?? true;
	return await runExclusiveSessionStoreWrite(storePath, async () => {
		const store = loadMutableSessionStoreForWriter(storePath);
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey
		});
		const existing = resolved.existing;
		if (!existing && !createIfMissing) return null;
		const explicitContext = normalizeDeliveryContext(params.deliveryContext);
		const inlineContext = normalizeDeliveryContext({
			channel,
			to,
			accountId,
			threadId
		});
		const routeContext = deliveryContextFromChannelRoute(params.route);
		const mergedInput = mergeDeliveryContext(routeContext, mergeDeliveryContext(explicitContext, inlineContext));
		const explicitDeliveryContext = params.deliveryContext;
		const explicitThreadValue = (explicitDeliveryContext != null && Object.prototype.hasOwnProperty.call(explicitDeliveryContext, "threadId") ? explicitDeliveryContext.threadId : void 0) ?? (threadId != null && threadId !== "" ? threadId : void 0);
		const merged = mergeDeliveryContext(mergedInput, Boolean(routeContext?.channel || routeContext?.to || explicitContext?.channel || explicitContext?.to || inlineContext?.channel || inlineContext?.to) && explicitThreadValue == null ? removeThreadFromDeliveryContext(deliveryContextFromSession(existing)) : deliveryContextFromSession(existing));
		const normalized = normalizeSessionDeliveryFields({
			route: params.route,
			deliveryContext: {
				channel: merged?.channel,
				to: merged?.to,
				accountId: merged?.accountId,
				threadId: merged?.threadId
			}
		});
		const metaPatch = ctx ? deriveSessionMetaPatch({
			ctx,
			sessionKey: resolved.normalizedKey,
			existing,
			groupResolution: params.groupResolution
		}) : null;
		const basePatch = {
			route: normalized.route,
			deliveryContext: normalized.deliveryContext,
			lastChannel: normalized.lastChannel,
			lastTo: normalized.lastTo,
			lastAccountId: normalized.lastAccountId,
			lastThreadId: normalized.lastThreadId
		};
		return await persistResolvedSessionEntry({
			storePath,
			store,
			resolved,
			next: mergeSessionEntryPreserveActivity(existing, metaPatch ? {
				...basePatch,
				...metaPatch
			} : basePatch)
		});
	});
}
//#endregion
export { resolveSessionArtifactCanonicalPathsForEntry as C, pruneUnreferencedSessionArtifacts as S, deriveSessionOrigin as _, readSessionUpdatedAt as a, resolveGroupSessionKey as b, saveSessionStore as c, updateSessionStoreEntry as d, upsertSessionEntry as f, deriveSessionMetaPatch as g, deriveGroupSessionPatch as h, patchSessionEntry as i, updateLastRoute as l, drainSessionStoreWriterQueuesForTest as m, getSessionEntry as n, recordSessionMetaFromInbound as o, clearSessionStoreCacheForTest as p, listSessionEntries as r, runQuotaSuspensionMaintenance as s, archiveRemovedSessionTranscripts as t, updateSessionStore as u, snapshotSessionOrigin as v, enforceSessionDiskBudget as x, buildGroupDisplayName as y };
