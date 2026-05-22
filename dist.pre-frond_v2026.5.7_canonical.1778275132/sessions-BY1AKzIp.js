import { c as normalizeAgentId } from "./session-key-C0K0uhmG.js";
import { S as resolveDefaultAgentId } from "./agent-scope-CcybJBoN.js";
import { a as getLogger } from "./logger-CQ0p51p4.js";
import { i as getRuntimeConfig } from "./io-DOE5w-Qp.js";
import { i as resolveMainSessionKey } from "./main-session-C7L7pyed.js";
import { s as resolveStoredSessionOwnerAgentId } from "./combined-store-gateway-EcUZzq-s.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath, u as resolveStorePath } from "./paths-B_upRR9g.js";
import { t as deliveryContextFromSession } from "./delivery-context.shared-CsinahOz.js";
import { i as capEntryCount, m as cloneSessionStoreRecord, r as resolveMaintenanceConfig, s as pruneStaleEntries, t as loadSessionStore, u as parseSessionThreadInfo } from "./store-load-DgTW9N4P.js";
import { i as resolveSessionStoreTargets } from "./targets-B2zDJScW.js";
import { m as enforceSessionDiskBudget, o as updateSessionStore } from "./store-D-yqyA6X.js";
import "./reset-gBCpGv7M.js";
import "./session-key-Cv9A6bMj.js";
import "./session-file-Dn7icln0.js";
import "./transcript-27mL5y0R.js";
import fs from "node:fs";
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
//#region src/config/sessions/delivery-info.ts
function extractDeliveryInfo(sessionKey) {
	const hasRoutableDeliveryContext = (context) => Boolean(context?.channel && context?.to);
	const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
	if (!sessionKey || !baseSessionKey) return {
		deliveryContext: void 0,
		threadId
	};
	let deliveryContext;
	try {
		const store = loadSessionStore(resolveStorePath(getRuntimeConfig().session?.store));
		let entry = store[sessionKey];
		let storedDeliveryContext = deliveryContextFromSession(entry);
		if (!hasRoutableDeliveryContext(storedDeliveryContext) && baseSessionKey !== sessionKey) {
			entry = store[baseSessionKey];
			storedDeliveryContext = deliveryContextFromSession(entry);
		}
		if (hasRoutableDeliveryContext(storedDeliveryContext)) deliveryContext = {
			channel: storedDeliveryContext.channel,
			to: storedDeliveryContext.to,
			accountId: storedDeliveryContext.accountId,
			threadId: storedDeliveryContext.threadId != null ? String(storedDeliveryContext.threadId) : void 0
		};
	} catch {}
	return {
		deliveryContext,
		threadId
	};
}
//#endregion
//#region src/config/sessions/cleanup-service.ts
function resolveSessionCleanupAction(params) {
	if (params.missingKeys.has(params.key)) return "prune-missing";
	if (params.staleKeys.has(params.key)) return "prune-stale";
	if (params.cappedKeys.has(params.key)) return "cap-overflow";
	if (params.budgetEvictedKeys.has(params.key)) return "evict-budget";
	return "keep";
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
		if (!entry?.sessionId) continue;
		const transcriptPath = resolveSessionFilePath(entry.sessionId, entry, sessionPathOpts);
		if (!fs.existsSync(transcriptPath)) {
			delete params.store[key];
			removed += 1;
			params.onPruned?.(key);
		}
	}
	return removed;
}
async function previewStoreCleanup(params) {
	const maintenance = resolveMaintenanceConfig();
	const beforeStore = loadSessionStore(params.target.storePath, { skipCache: true });
	const previewStore = cloneSessionStoreRecord(beforeStore);
	const staleKeys = /* @__PURE__ */ new Set();
	const cappedKeys = /* @__PURE__ */ new Set();
	const missingKeys = /* @__PURE__ */ new Set();
	const missing = params.fixMissing === true ? pruneMissingTranscriptEntries({
		store: previewStore,
		storePath: params.target.storePath,
		onPruned: (key) => {
			missingKeys.add(key);
		}
	}) : 0;
	const pruned = pruneStaleEntries(previewStore, maintenance.pruneAfterMs, {
		log: false,
		onPruned: ({ key }) => {
			staleKeys.add(key);
		}
	});
	const capped = capEntryCount(previewStore, maintenance.maxEntries, {
		log: false,
		onCapped: ({ key }) => {
			cappedKeys.add(key);
		}
	});
	const beforeBudgetStore = cloneSessionStoreRecord(previewStore);
	const diskBudget = await enforceSessionDiskBudget({
		store: previewStore,
		storePath: params.target.storePath,
		activeSessionKey: params.activeKey,
		maintenance,
		warnOnly: false,
		dryRun: true
	});
	const budgetEvictedKeys = /* @__PURE__ */ new Set();
	for (const key of Object.keys(beforeBudgetStore)) if (!Object.hasOwn(previewStore, key)) budgetEvictedKeys.add(key);
	const beforeCount = Object.keys(beforeStore).length;
	const afterPreviewCount = Object.keys(previewStore).length;
	const wouldMutate = missing > 0 || pruned > 0 || capped > 0 || (diskBudget?.removedEntries ?? 0) > 0 || (diskBudget?.removedFiles ?? 0) > 0;
	return {
		summary: {
			agentId: params.target.agentId,
			storePath: params.target.storePath,
			mode: params.mode,
			dryRun: params.dryRun,
			beforeCount,
			afterCount: afterPreviewCount,
			missing,
			pruned,
			capped,
			diskBudget,
			wouldMutate
		},
		beforeStore,
		missingKeys,
		staleKeys,
		cappedKeys,
		budgetEvictedKeys
	};
}
async function runSessionsCleanup(params) {
	const { cfg, opts } = params;
	const mode = opts.enforce ? "enforce" : resolveMaintenanceConfig().mode;
	const targets = params.targets ?? resolveSessionStoreTargets(cfg, {
		store: opts.store,
		agent: opts.agent,
		allAgents: opts.allAgents
	});
	const previewResults = [];
	for (const target of targets) {
		const result = await previewStoreCleanup({
			target,
			mode,
			dryRun: Boolean(opts.dryRun),
			activeKey: opts.activeKey,
			fixMissing: Boolean(opts.fixMissing)
		});
		previewResults.push(result);
	}
	const appliedSummaries = [];
	if (!opts.dryRun) for (const target of targets) {
		const appliedReportRef = { current: null };
		const missingApplied = await updateSessionStore(target.storePath, async (store) => {
			if (!opts.fixMissing) return 0;
			return pruneMissingTranscriptEntries({
				store,
				storePath: target.storePath
			});
		}, {
			activeSessionKey: opts.activeKey,
			maintenanceOverride: { mode },
			onMaintenanceApplied: (report) => {
				appliedReportRef.current = report;
			}
		});
		const afterStore = loadSessionStore(target.storePath, { skipCache: true });
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
				pruned: 0,
				capped: 0,
				diskBudget: null,
				wouldMutate: false
			},
			dryRun: false,
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
			pruned: appliedReport.pruned,
			capped: appliedReport.capped,
			diskBudget: appliedReport.diskBudget,
			wouldMutate: missingApplied > 0 || appliedReport.pruned > 0 || appliedReport.capped > 0 || (appliedReport.diskBudget?.removedEntries ?? 0) > 0 || (appliedReport.diskBudget?.removedFiles ?? 0) > 0,
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
export { extractDeliveryInfo as a, resolveMainSessionKeyFromConfig as c, serializeSessionCleanupResult as i, resolveSessionCleanupAction as n, readSessionHeaderStartedAtMs as o, runSessionsCleanup as r, resolveSessionLifecycleTimestamps as s, purgeAgentSessionStoreEntries as t };
