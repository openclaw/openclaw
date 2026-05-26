import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./agent-scope-CtLXGcWm.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import { i as getLogger } from "./logger-Dg9dVaLI.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { i as resolveMainSessionKey } from "./main-session-D3q_5w0B.js";
import { a as resolveSessionStoreKey, i as resolveSessionStoreAgentId, s as resolveStoredSessionOwnerAgentId } from "./combined-store-gateway-NV2GSCR6.js";
import { n as deliveryContextFromSession } from "./delivery-context.shared-CBmB9dF7.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath, u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { C as pruneStaleEntries, D as parseSessionThreadInfo, P as normalizeStoreSessionKey, a as readSessionStoreSnapshot, b as capEntryCount, d as cloneSessionStoreRecord, o as resolveMaintenanceConfig, s as collectSessionMaintenancePreserveKeys, t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { C as resolveSessionArtifactCanonicalPathsForEntry, S as pruneUnreferencedSessionArtifacts, t as archiveRemovedSessionTranscripts, u as updateSessionStore, x as enforceSessionDiskBudget } from "./store-BmtchQvp.js";
import { a as resolveSessionStoreTargets, i as resolveAllAgentSessionStoreTargetsSync } from "./targets-B5o7Ubgb.js";
import "./reset-B0OJOtNI.js";
import "./session-key-B2pwhP3C.js";
import "./transcript-BA0Ngd-A.js";
import fs from "node:fs";
import path from "node:path";
//#region src/config/sessions/delivery-info.ts
function hasRoutableDeliveryContext(context) {
	return Boolean(context?.channel && context?.to);
}
function extractDeliveryInfo(sessionKey, options) {
	const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
	if (!sessionKey || !baseSessionKey) return {
		deliveryContext: void 0,
		threadId
	};
	let deliveryContext;
	try {
		const lookup = loadDeliverySessionEntry({
			cfg: options?.cfg ?? getRuntimeConfig(),
			sessionKey,
			baseSessionKey
		});
		let entry = lookup.entry;
		let storedDeliveryContext = deliveryContextFromSession(entry);
		if (!hasRoutableDeliveryContext(storedDeliveryContext) && baseSessionKey !== sessionKey) {
			entry = lookup.baseEntry;
			storedDeliveryContext = deliveryContextFromSession(entry);
		}
		if (hasRoutableDeliveryContext(storedDeliveryContext)) deliveryContext = {
			channel: storedDeliveryContext.channel,
			to: storedDeliveryContext.to,
			accountId: storedDeliveryContext.accountId,
			threadId: storedDeliveryContext.threadId
		};
	} catch {}
	return {
		deliveryContext,
		threadId
	};
}
function resolveDeliveryStorePaths(cfg, agentId) {
	const paths = /* @__PURE__ */ new Set();
	paths.add(resolveStorePath(cfg.session?.store, { agentId }));
	for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) if (target.agentId === agentId) paths.add(target.storePath);
	return [...paths];
}
function asSessionEntry(entry) {
	return entry;
}
function findSessionEntryInStore(store, keys) {
	let normalizedIndex;
	let bestEntry;
	let bestUpdatedAt = 0;
	let bestRoutable = false;
	const acceptCandidate = (candidate) => {
		if (!candidate) return;
		const entry = candidate;
		const candidateRoutable = hasRoutableDeliveryContext(deliveryContextFromSession(entry));
		const candidateUpdatedAt = entry.updatedAt ?? 0;
		if (!bestEntry || candidateRoutable && !bestRoutable || candidateRoutable === bestRoutable && candidateUpdatedAt > bestUpdatedAt) {
			bestEntry = entry;
			bestUpdatedAt = candidateUpdatedAt;
			bestRoutable = candidateRoutable;
		}
	};
	for (const key of keys) {
		const trimmed = key.trim();
		const normalized = normalizeStoreSessionKey(key);
		const foldedLegacyKey = normalizeLowercaseStringOrEmpty(normalized);
		let foundRoutableCandidate = false;
		if (Object.prototype.hasOwnProperty.call(store, normalized)) {
			foundRoutableCandidate ||= hasRoutableDeliveryContext(deliveryContextFromSession(asSessionEntry(store[normalized])));
			acceptCandidate(store[normalized]);
		}
		if (foldedLegacyKey !== normalized && Object.prototype.hasOwnProperty.call(store, foldedLegacyKey)) {
			foundRoutableCandidate ||= hasRoutableDeliveryContext(deliveryContextFromSession(asSessionEntry(store[foldedLegacyKey])));
			acceptCandidate(store[foldedLegacyKey]);
		}
		if (trimmed !== normalized && Object.prototype.hasOwnProperty.call(store, trimmed)) {
			foundRoutableCandidate ||= hasRoutableDeliveryContext(deliveryContextFromSession(asSessionEntry(store[trimmed])));
			acceptCandidate(store[trimmed]);
		}
		if (trimmed !== normalized || !foundRoutableCandidate) {
			normalizedIndex ??= buildFreshestSessionEntryIndex(store);
			acceptCandidate(normalizedIndex.get(normalized));
			if (foldedLegacyKey !== normalized) acceptCandidate(normalizedIndex.get(foldedLegacyKey));
		}
	}
	return bestEntry;
}
function buildFreshestSessionEntryIndex(store) {
	const index = /* @__PURE__ */ new Map();
	for (const [key, candidate] of Object.entries(store)) {
		const entry = asSessionEntry(candidate);
		if (!entry) continue;
		const normalized = normalizeStoreSessionKey(key);
		const existing = index.get(normalized);
		const entryRoutable = hasRoutableDeliveryContext(deliveryContextFromSession(entry));
		const existingRoutable = hasRoutableDeliveryContext(deliveryContextFromSession(existing));
		if (!existing || entryRoutable && !existingRoutable || entryRoutable === existingRoutable && (entry.updatedAt ?? 0) > (existing.updatedAt ?? 0)) index.set(normalized, entry);
		const foldedLegacyKey = normalizeLowercaseStringOrEmpty(normalized);
		if (foldedLegacyKey === normalized) continue;
		const foldedExisting = index.get(foldedLegacyKey);
		const foldedExistingRoutable = hasRoutableDeliveryContext(deliveryContextFromSession(foldedExisting));
		if (!foldedExisting || entryRoutable && !foldedExistingRoutable || entryRoutable === foldedExistingRoutable && (entry.updatedAt ?? 0) > (foldedExisting.updatedAt ?? 0)) index.set(foldedLegacyKey, entry);
	}
	return index;
}
function loadDeliverySessionEntry(params) {
	const canonicalKey = resolveSessionStoreKey({
		cfg: params.cfg,
		sessionKey: params.sessionKey
	});
	const canonicalBaseKey = resolveSessionStoreKey({
		cfg: params.cfg,
		sessionKey: params.baseSessionKey
	});
	const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
	const sessionKeys = [params.sessionKey, canonicalKey];
	const baseKeys = [params.baseSessionKey, canonicalBaseKey];
	let fallback;
	for (const storePath of resolveDeliveryStorePaths(params.cfg, agentId)) {
		const store = readSessionStoreSnapshot(storePath);
		const entry = findSessionEntryInStore(store, sessionKeys);
		const baseEntry = findSessionEntryInStore(store, baseKeys);
		if (!entry && !baseEntry) continue;
		fallback ??= {
			entry,
			baseEntry
		};
		if (hasRoutableDeliveryContext(deliveryContextFromSession(entry)) || hasRoutableDeliveryContext(deliveryContextFromSession(baseEntry))) return {
			entry,
			baseEntry
		};
	}
	return fallback ?? {
		entry: void 0,
		baseEntry: void 0
	};
}
//#endregion
//#region src/config/sessions/main-session.runtime.ts
function resolveMainSessionKeyFromConfig() {
	return resolveMainSessionKey(getRuntimeConfig());
}
//#endregion
//#region src/config/sessions/lifecycle.ts
function resolveTimestamp(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function parseTimestampMs(value) {
	if (typeof value === "number") return resolveTimestamp(value);
	if (typeof value !== "string" || !value.trim()) return;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : void 0;
}
function readFirstLine(filePath) {
	try {
		const fd = fs.openSync(filePath, "r");
		try {
			const buffer = Buffer.alloc(8192);
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
			if (bytesRead <= 0) return;
			const chunk = buffer.subarray(0, bytesRead).toString("utf8");
			const newline = chunk.indexOf("\n");
			return newline >= 0 ? chunk.slice(0, newline) : chunk;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return;
	}
}
function readSessionHeaderStartedAtMs(params) {
	const sessionId = params.entry?.sessionId?.trim();
	if (!sessionId) return;
	const pathOptions = params.pathOptions ?? resolveSessionFilePathOptions({
		agentId: params.agentId,
		storePath: params.storePath
	});
	let sessionFile;
	try {
		sessionFile = resolveSessionFilePath(sessionId, params.entry, pathOptions);
	} catch {
		return;
	}
	const firstLine = readFirstLine(sessionFile);
	if (!firstLine) return;
	try {
		const header = JSON.parse(firstLine);
		if (header.type !== "session") return;
		if (typeof header.id === "string" && header.id.trim() && header.id !== sessionId) return;
		return parseTimestampMs(header.timestamp);
	} catch {
		return;
	}
}
function resolveSessionLifecycleTimestamps(params) {
	const entry = params.entry;
	if (!entry) return {};
	return {
		sessionStartedAt: resolveTimestamp(entry.sessionStartedAt) ?? readSessionHeaderStartedAtMs({
			entry,
			agentId: params.agentId,
			storePath: params.storePath,
			pathOptions: params.pathOptions
		}),
		lastInteractionAt: resolveTimestamp(entry.lastInteractionAt)
	};
}
//#endregion
//#region src/config/sessions/session-file-rotation.ts
function rewriteSessionFileForNewSessionId(params) {
	const trimmed = normalizeOptionalString(params.sessionFile);
	if (!trimmed) return;
	const base = path.basename(trimmed);
	if (!base.endsWith(".jsonl")) return;
	const withoutExt = base.slice(0, -6);
	if (withoutExt === params.previousSessionId) return path.join(path.dirname(trimmed), `${params.nextSessionId}.jsonl`);
	if (withoutExt.startsWith(`${params.previousSessionId}-topic-`)) return path.join(path.dirname(trimmed), `${params.nextSessionId}${base.slice(params.previousSessionId.length)}`);
	const forkMatch = withoutExt.match(/^(\d{4}-\d{2}-\d{2}T[\w-]+(?:Z|[+-]\d{2}(?:-\d{2})?)?)_(.+)$/);
	if (forkMatch?.[2] === params.previousSessionId) return path.join(path.dirname(trimmed), `${forkMatch[1]}_${params.nextSessionId}.jsonl`);
}
function canonicalizeAbsoluteSessionFilePath(filePath) {
	const resolved = path.resolve(filePath);
	const missingSegments = [];
	let cursor = resolved;
	while (true) try {
		return path.join(fs.realpathSync(cursor), ...missingSegments.toReversed());
	} catch {
		const parent = path.dirname(cursor);
		if (parent === cursor) return resolved;
		missingSegments.push(path.basename(cursor));
		cursor = parent;
	}
}
//#endregion
//#region src/config/sessions/cleanup-service.ts
function resolveSessionCleanupAction(params) {
	if (params.dmScopeRetiredKeys.has(params.key)) return "retire-dm-scope";
	if (params.missingKeys.has(params.key)) return "prune-missing";
	if (params.staleKeys.has(params.key)) return "prune-stale";
	if (params.cappedKeys.has(params.key)) return "cap-overflow";
	if (params.budgetEvictedKeys.has(params.key)) return "evict-budget";
	return "keep";
}
function isMainScopeStaleDirectSessionKey(params) {
	if ((params.cfg.session?.dmScope ?? "main") !== "main") return false;
	if (params.activeKey && params.key === params.activeKey) return false;
	const parsed = parseAgentSessionKey(params.key);
	if (!parsed || normalizeAgentId(parsed.agentId) !== normalizeAgentId(params.targetAgentId)) return false;
	const parts = parsed.rest.split(":").filter(Boolean);
	return parts.length === 2 && parts[0] === "direct" || parts.length === 3 && parts[1] === "direct" || parts.length === 4 && parts[2] === "direct";
}
function rememberRemovedSessionFile(removedSessionFiles, entry) {
	if (entry?.sessionId) removedSessionFiles.set(entry.sessionId, entry.sessionFile);
}
function retireMainScopeDirectSessionEntries(params) {
	let retired = 0;
	for (const [key, entry] of Object.entries(params.store)) if (isMainScopeStaleDirectSessionKey({
		cfg: params.cfg,
		targetAgentId: params.targetAgentId,
		key,
		activeKey: params.activeKey
	})) {
		params.onRetired?.(key, entry);
		delete params.store[key];
		retired += 1;
	}
	return retired;
}
function serializeSessionCleanupResult(params) {
	if (params.summaries.length === 1) return params.summaries[0] ?? {};
	return {
		allAgents: true,
		mode: params.mode,
		dryRun: params.dryRun,
		stores: params.summaries
	};
}
function pruneMissingTranscriptEntries(params) {
	const sessionPathOpts = resolveSessionFilePathOptions({ storePath: params.storePath });
	let removed = 0;
	for (const [key, entry] of Object.entries(params.store)) {
		if (!entry?.sessionId) {
			if (parseAgentSessionKey(key)) continue;
			delete params.store[key];
			removed += 1;
			params.onPruned?.(key);
			continue;
		}
		let transcriptPath;
		try {
			transcriptPath = resolveSessionFilePath(entry.sessionId, entry, sessionPathOpts);
		} catch {}
		if (!transcriptPath || !fs.existsSync(transcriptPath)) {
			delete params.store[key];
			removed += 1;
			params.onPruned?.(key);
		}
	}
	return removed;
}
function addEntryArtifactPathsToSet(params) {
	const sessionsDir = path.dirname(params.storePath);
	for (const key of params.keys) {
		const entry = params.store[key];
		if (!entry) continue;
		for (const artifactPath of resolveSessionArtifactCanonicalPathsForEntry({
			sessionsDir,
			entry
		})) params.paths.add(artifactPath);
	}
}
async function previewStoreCleanup(params) {
	const beforeStore = loadSessionStore(params.target.storePath, { skipCache: true });
	const previewStore = cloneSessionStoreRecord(beforeStore);
	const staleKeys = /* @__PURE__ */ new Set();
	const cappedKeys = /* @__PURE__ */ new Set();
	const missingKeys = /* @__PURE__ */ new Set();
	const dmScopeRetiredKeys = /* @__PURE__ */ new Set();
	const missing = params.fixMissing === true ? pruneMissingTranscriptEntries({
		store: previewStore,
		storePath: params.target.storePath,
		onPruned: (key) => {
			missingKeys.add(key);
		}
	}) : 0;
	const dmScopeRetired = params.fixDmScope === true ? retireMainScopeDirectSessionEntries({
		cfg: params.cfg,
		store: previewStore,
		targetAgentId: params.target.agentId,
		activeKey: params.activeKey,
		onRetired: (key) => {
			dmScopeRetiredKeys.add(key);
		}
	}) : 0;
	const preserveSessionKeys = collectSessionMaintenancePreserveKeys([params.activeKey]);
	const pruned = pruneStaleEntries(previewStore, params.maintenance.pruneAfterMs, {
		log: false,
		preserveKeys: preserveSessionKeys,
		onPruned: ({ key }) => {
			staleKeys.add(key);
		}
	});
	const capped = capEntryCount(previewStore, params.maintenance.maxEntries, {
		log: false,
		preserveKeys: preserveSessionKeys,
		onCapped: ({ key }) => {
			cappedKeys.add(key);
		}
	});
	const entryCleanupArtifactPaths = /* @__PURE__ */ new Set();
	addEntryArtifactPathsToSet({
		paths: entryCleanupArtifactPaths,
		store: beforeStore,
		storePath: params.target.storePath,
		keys: staleKeys
	});
	addEntryArtifactPathsToSet({
		paths: entryCleanupArtifactPaths,
		store: beforeStore,
		storePath: params.target.storePath,
		keys: cappedKeys
	});
	addEntryArtifactPathsToSet({
		paths: entryCleanupArtifactPaths,
		store: beforeStore,
		storePath: params.target.storePath,
		keys: dmScopeRetiredKeys
	});
	const beforeBudgetStore = cloneSessionStoreRecord(previewStore);
	const budgetRemovedFilePaths = /* @__PURE__ */ new Set();
	const diskBudget = await enforceSessionDiskBudget({
		store: previewStore,
		storePath: params.target.storePath,
		activeSessionKey: params.activeKey,
		preserveKeys: preserveSessionKeys,
		maintenance: params.maintenance,
		warnOnly: false,
		dryRun: true,
		onRemoveFile: (canonicalPath) => {
			budgetRemovedFilePaths.add(canonicalPath);
		}
	});
	const unreferencedArtifacts = await pruneUnreferencedSessionArtifacts({
		store: previewStore,
		storePath: params.target.storePath,
		olderThanMs: params.maintenance.pruneAfterMs,
		dryRun: true,
		excludeCanonicalPaths: new Set([...budgetRemovedFilePaths, ...entryCleanupArtifactPaths])
	});
	const budgetEvictedKeys = /* @__PURE__ */ new Set();
	for (const key of Object.keys(beforeBudgetStore)) if (!Object.hasOwn(previewStore, key)) budgetEvictedKeys.add(key);
	const beforeCount = Object.keys(beforeStore).length;
	const afterPreviewCount = Object.keys(previewStore).length;
	const wouldMutate = missing > 0 || dmScopeRetired > 0 || pruned > 0 || capped > 0 || unreferencedArtifacts.removedFiles > 0 || (diskBudget?.removedEntries ?? 0) > 0 || (diskBudget?.removedFiles ?? 0) > 0;
	return {
		summary: {
			agentId: params.target.agentId,
			storePath: params.target.storePath,
			mode: params.mode,
			dryRun: params.dryRun,
			beforeCount,
			afterCount: afterPreviewCount,
			missing,
			dmScopeRetired,
			pruned,
			capped,
			unreferencedArtifacts,
			diskBudget,
			wouldMutate
		},
		beforeStore,
		missingKeys,
		staleKeys,
		cappedKeys,
		budgetEvictedKeys,
		dmScopeRetiredKeys
	};
}
async function runSessionsCleanup(params) {
	const { cfg, opts } = params;
	const maintenance = resolveMaintenanceConfig();
	const mode = opts.enforce ? "enforce" : maintenance.mode;
	const targets = params.targets ?? resolveSessionStoreTargets(cfg, {
		store: opts.store,
		agent: opts.agent,
		allAgents: opts.allAgents
	});
	const previewResults = [];
	for (const target of targets) {
		const result = await previewStoreCleanup({
			cfg,
			target,
			maintenance,
			mode,
			dryRun: Boolean(opts.dryRun),
			activeKey: opts.activeKey,
			fixMissing: Boolean(opts.fixMissing),
			fixDmScope: Boolean(opts.fixDmScope)
		});
		previewResults.push(result);
	}
	const appliedSummaries = [];
	if (!opts.dryRun) for (const target of targets) {
		const appliedReportRef = { current: null };
		const dmScopeRemovedSessionFiles = /* @__PURE__ */ new Map();
		let missingApplied = 0;
		let dmScopeRetiredApplied = 0;
		await updateSessionStore(target.storePath, async (store) => {
			let removed = 0;
			if (opts.fixMissing) {
				missingApplied = pruneMissingTranscriptEntries({
					store,
					storePath: target.storePath
				});
				removed += missingApplied;
			}
			if (opts.fixDmScope) {
				dmScopeRetiredApplied = retireMainScopeDirectSessionEntries({
					cfg,
					store,
					targetAgentId: target.agentId,
					activeKey: opts.activeKey,
					onRetired: (_key, entry) => {
						rememberRemovedSessionFile(dmScopeRemovedSessionFiles, entry);
					}
				});
				removed += dmScopeRetiredApplied;
			}
			return removed;
		}, {
			activeSessionKey: opts.activeKey,
			maintenanceOverride: { mode },
			onMaintenanceApplied: (report) => {
				appliedReportRef.current = report;
			}
		});
		if (dmScopeRemovedSessionFiles.size > 0) {
			const storeAfterDmScopeRetire = loadSessionStore(target.storePath, { skipCache: true });
			await archiveRemovedSessionTranscripts({
				removedSessionFiles: dmScopeRemovedSessionFiles,
				referencedSessionIds: new Set(Object.values(storeAfterDmScopeRetire).map((entry) => entry?.sessionId).filter((id) => Boolean(id))),
				storePath: target.storePath,
				reason: "deleted",
				restrictToStoreDir: true
			});
		}
		const afterStore = loadSessionStore(target.storePath, { skipCache: true });
		const unreferencedArtifacts = mode === "warn" ? {
			scannedFiles: 0,
			removedFiles: 0,
			freedBytes: 0,
			olderThanMs: maintenance.pruneAfterMs
		} : await pruneUnreferencedSessionArtifacts({
			store: afterStore,
			storePath: target.storePath,
			olderThanMs: maintenance.pruneAfterMs,
			dryRun: false
		});
		const preview = previewResults.find((result) => result.summary.storePath === target.storePath);
		const appliedReport = appliedReportRef.current;
		const summary = appliedReport === null ? {
			...preview?.summary ?? {
				agentId: target.agentId,
				storePath: target.storePath,
				mode,
				dryRun: false,
				beforeCount: 0,
				afterCount: 0,
				missing: 0,
				dmScopeRetired: 0,
				pruned: 0,
				capped: 0,
				unreferencedArtifacts,
				diskBudget: null,
				wouldMutate: false
			},
			dryRun: false,
			unreferencedArtifacts,
			wouldMutate: (preview?.summary.wouldMutate ?? false) || unreferencedArtifacts.removedFiles > 0,
			applied: true,
			appliedCount: Object.keys(afterStore).length
		} : {
			agentId: target.agentId,
			storePath: target.storePath,
			mode: appliedReport.mode,
			dryRun: false,
			beforeCount: appliedReport.beforeCount,
			afterCount: appliedReport.afterCount,
			missing: missingApplied,
			dmScopeRetired: dmScopeRetiredApplied,
			pruned: appliedReport.pruned,
			capped: appliedReport.capped,
			unreferencedArtifacts,
			diskBudget: appliedReport.diskBudget,
			wouldMutate: missingApplied > 0 || dmScopeRetiredApplied > 0 || appliedReport.pruned > 0 || appliedReport.capped > 0 || unreferencedArtifacts.removedFiles > 0 || (appliedReport.diskBudget?.removedEntries ?? 0) > 0 || (appliedReport.diskBudget?.removedFiles ?? 0) > 0,
			applied: true,
			appliedCount: Object.keys(afterStore).length
		};
		appliedSummaries.push(summary);
	}
	return {
		mode,
		previewResults,
		appliedSummaries
	};
}
/** Purge session store entries for a deleted agent (#65524). Best-effort. */
async function purgeAgentSessionStoreEntries(cfg, agentId) {
	try {
		const normalizedAgentId = normalizeAgentId(agentId);
		const storeConfig = cfg.session?.store;
		const storeAgentId = typeof storeConfig === "string" && storeConfig.includes("{agentId}") ? normalizedAgentId : normalizeAgentId(resolveDefaultAgentId(cfg));
		await updateSessionStore(resolveStorePath(cfg.session?.store, { agentId: normalizedAgentId }), (store) => {
			for (const key of Object.keys(store)) if (resolveStoredSessionOwnerAgentId({
				cfg,
				agentId: storeAgentId,
				sessionKey: key
			}) === normalizedAgentId) delete store[key];
		});
	} catch (err) {
		getLogger().debug("session store purge skipped during agent delete", err);
	}
}
//#endregion
export { canonicalizeAbsoluteSessionFilePath as a, resolveSessionLifecycleTimestamps as c, serializeSessionCleanupResult as i, resolveMainSessionKeyFromConfig as l, resolveSessionCleanupAction as n, rewriteSessionFileForNewSessionId as o, runSessionsCleanup as r, readSessionHeaderStartedAtMs as s, purgeAgentSessionStoreEntries as t, extractDeliveryInfo as u };
