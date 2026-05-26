import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { _ as resolveSessionAgentId, v as resolveSessionAgentIds } from "./agent-scope-CtLXGcWm.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { G as resolveMemoryDreamingConfig, U as resolveMemoryCorePluginConfig, W as resolveMemoryDeepDreamingConfig } from "./dreaming-CxCxWYoC.js";
import { l as listMemoryCorpusSupplements } from "./memory-state-DKjCVvl8.js";
import { t as loadCombinedSessionStoreForGateway } from "./combined-store-gateway-NV2GSCR6.js";
import { i as stringEnum } from "./typebox-CjEaoMel.js";
import { c as jsonResult, f as readNumberParam, g as readStringParam, r as asToolParamsRecord } from "./common-E9YpX7pB.js";
import { o as resolveEffectiveSessionToolsVisibility, r as createSessionVisibilityGuard, t as createAgentToAgentPolicy } from "./session-visibility-DWz6M2DP.js";
import { t as resolveMemorySearchConfig } from "./memory-search-BEQRq9yG.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./channel-actions-DMN7G5RZ.js";
import { r as resolveTranscriptStemToSessionKeys, t as extractTranscriptIdentityFromSessionsMemoryHit } from "./session-transcript-hit-nEFaYUz6.js";
import "./memory-core-host-runtime-core-CkZUvQ_1.js";
import "./memory-host-core-BsjFNwCJ.js";
import "./memory-core-host-status-CceUImkn.js";
import { l as recordShortTermRecalls } from "./short-term-promotion-BpCbM_k1.js";
import { Type } from "typebox";
//#region extensions/memory-core/src/session-search-visibility.ts
function normalizeAgentIdForCompare(value) {
	return value?.trim().toLowerCase() || void 0;
}
function isGlobalSessionKeyForSharedScope(cfg, key) {
	return cfg.session?.scope === "global" && key.trim().toLowerCase() === "global";
}
function filterSessionKeysByScopedAgent(params) {
	const scopedAgentId = normalizeAgentIdForCompare(params.scopedAgentId);
	if (!scopedAgentId) return params.keys;
	return params.keys.filter((key) => {
		if (isGlobalSessionKeyForSharedScope(params.cfg, key)) return true;
		return normalizeAgentIdForCompare(resolveSessionAgentId({
			sessionKey: key,
			config: params.cfg
		})) === scopedAgentId;
	});
}
async function filterMemorySearchHitsBySessionVisibility(params) {
	const visibility = resolveEffectiveSessionToolsVisibility({
		cfg: params.cfg,
		sandboxed: params.sandboxed
	});
	const a2aPolicy = createAgentToAgentPolicy(params.cfg);
	const requesterAgentId = params.requesterSessionKey ? resolveSessionAgentId({
		sessionKey: params.requesterSessionKey,
		config: params.cfg
	}) : void 0;
	const scopedAgentId = params.agentId?.trim() || requesterAgentId;
	const guard = params.requesterSessionKey ? await createSessionVisibilityGuard({
		action: "history",
		requesterSessionKey: params.requesterSessionKey,
		visibility,
		a2aPolicy
	}) : null;
	const { store: combinedSessionStore } = loadCombinedSessionStoreForGateway(params.cfg, scopedAgentId ? { agentId: scopedAgentId } : {});
	const next = [];
	for (const hit of params.hits) {
		if (hit.source !== "sessions") {
			next.push(hit);
			continue;
		}
		if (!params.requesterSessionKey || !guard) continue;
		const identity = extractTranscriptIdentityFromSessionsMemoryHit(hit.path);
		if (!identity) continue;
		const isQmdSessionHit = hit.path.replace(/\\/g, "/").startsWith("qmd/");
		const normalizedScopedAgentId = normalizeAgentIdForCompare(scopedAgentId);
		const normalizedOwnerAgentId = normalizeAgentIdForCompare(identity.ownerAgentId);
		if (normalizedScopedAgentId && normalizedOwnerAgentId && normalizedOwnerAgentId !== normalizedScopedAgentId) continue;
		const archivedOwnerAgentId = Boolean(identity.archived && (identity.ownerAgentId && (!scopedAgentId || normalizeAgentIdForCompare(identity.ownerAgentId) === normalizeAgentIdForCompare(scopedAgentId)) || isQmdSessionHit && scopedAgentId)) ? identity.ownerAgentId ?? scopedAgentId : void 0;
		const liveKeys = identity.liveStem ? resolveTranscriptStemToSessionKeys({
			store: combinedSessionStore,
			stem: identity.liveStem,
			allowQmdSlugFallback: false
		}) : [];
		const keys = filterSessionKeysByScopedAgent({
			cfg: params.cfg,
			scopedAgentId,
			keys: liveKeys.length > 0 ? liveKeys : resolveTranscriptStemToSessionKeys({
				store: combinedSessionStore,
				stem: identity.stem,
				allowQmdSlugFallback: isQmdSessionHit && !identity.archived,
				...archivedOwnerAgentId ? { archivedOwnerAgentId } : {}
			})
		});
		if (keys.length === 0) continue;
		if (!keys.some((key) => guard.check(key).allowed)) continue;
		next.push(hit);
	}
	return next;
}
//#endregion
//#region extensions/memory-core/src/tools.citations.ts
function resolveMemoryCitationsMode(cfg) {
	const mode = cfg.memory?.citations;
	if (mode === "on" || mode === "off" || mode === "auto") return mode;
	return "auto";
}
function decorateCitations(results, include) {
	if (!include) return results.map((entry) => ({
		...entry,
		citation: void 0
	}));
	return results.map((entry) => {
		const citation = formatCitation(entry);
		const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
		return {
			...entry,
			citation,
			snippet
		};
	});
}
function formatCitation(entry) {
	const lineRange = entry.startLine === entry.endLine ? `#L${entry.startLine}` : `#L${entry.startLine}-L${entry.endLine}`;
	return `${entry.path}${lineRange}`;
}
function clampResultsByInjectedChars(results, budget) {
	if (!budget || budget <= 0) return results;
	let remaining = budget;
	const clamped = [];
	for (const entry of results) {
		if (remaining <= 0) break;
		const snippet = entry.snippet ?? "";
		if (snippet.length <= remaining) {
			clamped.push(entry);
			remaining -= snippet.length;
		} else {
			const trimmed = snippet.slice(0, Math.max(0, remaining));
			clamped.push({
				...entry,
				snippet: trimmed
			});
			break;
		}
	}
	return clamped;
}
function shouldIncludeCitations(params) {
	if (params.mode === "on") return true;
	if (params.mode === "off") return false;
	return deriveChatTypeFromSessionKey(params.sessionKey) === "direct";
}
function deriveChatTypeFromSessionKey(sessionKey) {
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed?.rest) return "direct";
	const tokens = new Set(normalizeLowercaseStringOrEmpty(parsed.rest).split(":").filter(Boolean));
	if (tokens.has("channel")) return "channel";
	if (tokens.has("group")) return "group";
	return "direct";
}
//#endregion
//#region extensions/memory-core/src/tools.shared.ts
let memoryToolRuntimePromise = null;
async function loadMemoryToolRuntime() {
	memoryToolRuntimePromise ??= import("./tools.runtime.js");
	return await memoryToolRuntimePromise;
}
const MemorySearchSchema = Type.Object({
	query: Type.String(),
	maxResults: Type.Optional(Type.Number()),
	minScore: Type.Optional(Type.Number()),
	corpus: Type.Optional(stringEnum([
		"memory",
		"wiki",
		"all",
		"sessions"
	]))
});
const MemoryGetSchema = Type.Object({
	path: Type.String(),
	from: Type.Optional(Type.Number()),
	lines: Type.Optional(Type.Number()),
	corpus: Type.Optional(stringEnum([
		"memory",
		"wiki",
		"all"
	]))
});
function resolveMemoryToolContext(options) {
	const cfg = options.getConfig?.() ?? options.config;
	if (!cfg) return null;
	const { sessionAgentId: agentId } = resolveSessionAgentIds({
		sessionKey: options.agentSessionKey,
		config: cfg,
		agentId: options.agentId
	});
	if (!resolveMemorySearchConfig(cfg, agentId)) return null;
	return {
		cfg,
		agentId
	};
}
async function getMemoryManagerContext(params) {
	return await getMemoryManagerContextWithPurpose({
		...params,
		purpose: void 0
	});
}
async function getMemoryManagerContextWithPurpose(params) {
	const { getMemorySearchManager } = await loadMemoryToolRuntime();
	const { manager, error } = await getMemorySearchManager({
		cfg: params.cfg,
		agentId: params.agentId,
		purpose: params.purpose
	});
	return manager ? { manager } : { error };
}
function createMemoryTool(params) {
	const ctx = resolveMemoryToolContext(params.options);
	if (!ctx) return null;
	return {
		label: params.label,
		name: params.name,
		description: params.description,
		parameters: params.parameters,
		execute: async (toolCallId, toolParams) => {
			const latestCtx = resolveMemoryToolContext(params.options) ?? ctx;
			return await params.execute(latestCtx)(toolCallId, toolParams);
		}
	};
}
function buildMemorySearchUnavailableResult(error) {
	const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
	const isQuotaError = /insufficient_quota|quota|429/.test(normalizeLowercaseStringOrEmpty(reason));
	const warning = isQuotaError ? "Memory search is unavailable because the embedding provider quota is exhausted." : "Memory search is unavailable due to an embedding/provider error.";
	const action = isQuotaError ? "Top up or switch embedding provider, then retry memory_search." : "Check embedding provider configuration and retry memory_search.";
	return {
		results: [],
		disabled: true,
		unavailable: true,
		error: reason,
		warning,
		action,
		debug: {
			warning,
			action,
			error: reason
		}
	};
}
async function searchMemoryCorpusSupplements(params) {
	if (params.corpus === "memory" || params.corpus === "sessions") return [];
	const supplements = listMemoryCorpusSupplements();
	if (supplements.length === 0) return [];
	return (await Promise.all(supplements.map(async (registration) => await registration.supplement.search(params)))).flat().toSorted((left, right) => {
		if (left.score !== right.score) return right.score - left.score;
		return left.path.localeCompare(right.path);
	}).slice(0, Math.max(1, params.maxResults ?? 10));
}
async function getMemoryCorpusSupplementResult(params) {
	if (params.corpus === "memory" || params.corpus === "sessions") return null;
	for (const registration of listMemoryCorpusSupplements()) {
		const result = await registration.supplement.get(params);
		if (result) return result;
	}
	return null;
}
//#endregion
//#region extensions/memory-core/src/tools.ts
function sortMemorySearchToolResults(results) {
	return results.toSorted((left, right) => {
		if (left.score !== right.score) return right.score - left.score;
		return left.path.localeCompare(right.path);
	});
}
function mergeMemorySearchCorpusResults(params) {
	const memoryResults = sortMemorySearchToolResults(params.memoryResults);
	const supplementResults = sortMemorySearchToolResults(params.supplementResults);
	if (!params.balanceCorpora || memoryResults.length === 0 || supplementResults.length === 0) return sortMemorySearchToolResults([...memoryResults, ...supplementResults]).slice(0, params.maxResults);
	const perCorpusCap = Math.ceil(params.maxResults / 2);
	const selectedMemory = memoryResults.slice(0, perCorpusCap);
	const selectedSupplements = supplementResults.slice(0, perCorpusCap);
	const selected = [...selectedMemory, ...selectedSupplements];
	if (selected.length < params.maxResults) selected.push(...sortMemorySearchToolResults([...memoryResults.slice(selectedMemory.length), ...supplementResults.slice(selectedSupplements.length)]).slice(0, params.maxResults - selected.length));
	return sortMemorySearchToolResults(selected).slice(0, params.maxResults);
}
function buildRecallKey(result) {
	return `${result.source}:${result.path}:${result.startLine}:${result.endLine}`;
}
function resolveRecallTrackingResults(rawResults, surfacedResults) {
	if (surfacedResults.length === 0 || rawResults.length === 0) return surfacedResults;
	const rawByKey = /* @__PURE__ */ new Map();
	for (const raw of rawResults) {
		const key = buildRecallKey(raw);
		if (!rawByKey.has(key)) rawByKey.set(key, raw);
	}
	return surfacedResults.map((surfaced) => rawByKey.get(buildRecallKey(surfaced)) ?? surfaced);
}
function queueShortTermRecallTracking(params) {
	const trackingResults = resolveRecallTrackingResults(params.rawResults, params.surfacedResults);
	recordShortTermRecalls({
		workspaceDir: params.workspaceDir,
		query: params.query,
		results: trackingResults,
		timezone: params.timezone
	}).catch(() => {});
}
function normalizeActiveMemoryQmdSearchMode(value) {
	return value === "inherit" || value === "search" || value === "vsearch" || value === "query" ? value : "search";
}
function isActiveMemorySessionKey(sessionKey) {
	return typeof sessionKey === "string" && sessionKey.includes(":active-memory:");
}
function resolveActiveMemoryQmdSearchModeOverride(cfg, sessionKey) {
	if (!isActiveMemorySessionKey(sessionKey)) return;
	const entry = cfg.plugins?.entries?.["active-memory"];
	const entryRecord = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : void 0;
	const searchMode = normalizeActiveMemoryQmdSearchMode((entryRecord?.config && typeof entryRecord.config === "object" && !Array.isArray(entryRecord.config) ? entryRecord.config : void 0)?.qmd?.searchMode);
	return searchMode === "inherit" ? void 0 : searchMode;
}
async function getSupplementMemoryReadResult(params) {
	const supplement = await getMemoryCorpusSupplementResult({
		lookup: params.relPath,
		fromLine: params.from,
		lineCount: params.lines,
		agentSessionKey: params.agentSessionKey,
		corpus: params.corpus
	});
	if (!supplement) return null;
	const { content, ...rest } = supplement;
	return {
		...rest,
		text: content
	};
}
async function resolveMemoryReadFailureResult(params) {
	if (params.requestedCorpus === "all") {
		const supplement = await getSupplementMemoryReadResult({
			relPath: params.relPath,
			from: params.from,
			lines: params.lines,
			agentSessionKey: params.agentSessionKey,
			corpus: params.requestedCorpus
		});
		if (supplement) return jsonResult(supplement);
	}
	const message = formatErrorMessage(params.error);
	return jsonResult({
		path: params.relPath,
		text: "",
		disabled: true,
		error: message
	});
}
async function executeMemoryReadResult(params) {
	try {
		return jsonResult(await params.read());
	} catch (error) {
		return await resolveMemoryReadFailureResult({
			error,
			requestedCorpus: params.requestedCorpus,
			relPath: params.relPath,
			from: params.from,
			lines: params.lines,
			agentSessionKey: params.agentSessionKey
		});
	}
}
function createMemorySearchTool(options) {
	return createMemoryTool({
		options,
		label: "Memory Search",
		name: "memory_search",
		description: "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos. Optional `corpus=wiki` or `corpus=all` also searches registered compiled-wiki supplements. `corpus=memory` restricts hits to indexed memory files (excludes session transcript chunks from ranking). `corpus=sessions` restricts hits to indexed session transcripts (same visibility rules as session history tools). If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
		parameters: MemorySearchSchema,
		execute: ({ cfg, agentId }) => async (_toolCallId, params) => {
			const rawParams = asToolParamsRecord(params);
			const query = readStringParam(rawParams, "query", { required: true });
			const maxResults = readNumberParam(rawParams, "maxResults");
			const minScore = readNumberParam(rawParams, "minScore");
			const requestedCorpus = readStringParam(rawParams, "corpus");
			const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
			const shouldQueryMemory = requestedCorpus !== "wiki";
			const shouldQuerySupplements = requestedCorpus === "wiki" || requestedCorpus === "all";
			const memory = shouldQueryMemory ? await getMemoryManagerContext({
				cfg,
				agentId
			}) : null;
			if (shouldQueryMemory && memory && "error" in memory && !shouldQuerySupplements) return jsonResult(buildMemorySearchUnavailableResult(memory.error));
			try {
				const citationsMode = resolveMemoryCitationsMode(cfg);
				const includeCitations = shouldIncludeCitations({
					mode: citationsMode,
					sessionKey: options.agentSessionKey
				});
				const pluginConfig = resolveMemoryCorePluginConfig(cfg);
				const dreamingEnabled = resolveMemoryDreamingConfig({
					pluginConfig,
					cfg
				}).enabled;
				const dreaming = resolveMemoryDeepDreamingConfig({
					pluginConfig,
					cfg
				});
				const searchStartedAt = Date.now();
				let rawResults = [];
				let surfacedMemoryResults = [];
				let provider;
				let model;
				let fallback;
				let searchMode;
				let searchDebug;
				if (shouldQueryMemory && memory && !("error" in memory)) {
					const runtimeDebug = [];
					const qmdSearchModeOverride = resolveActiveMemoryQmdSearchModeOverride(cfg, options.agentSessionKey);
					const searchSources = requestedCorpus === "sessions" ? ["sessions"] : requestedCorpus === "memory" ? ["memory"] : void 0;
					rawResults = await memory.manager.search(query, {
						maxResults,
						minScore,
						sessionKey: options.agentSessionKey,
						qmdSearchModeOverride,
						onDebug: (debug) => {
							runtimeDebug.push(debug);
						},
						...searchSources ? { sources: searchSources } : {}
					});
					rawResults = await filterMemorySearchHitsBySessionVisibility({
						cfg,
						agentId,
						requesterSessionKey: options.agentSessionKey,
						sandboxed: options.sandboxed === true,
						hits: rawResults
					});
					if (requestedCorpus === "sessions") rawResults = rawResults.filter((hit) => hit.source === "sessions");
					else if (requestedCorpus === "memory") rawResults = rawResults.filter((hit) => hit.source === "memory");
					const status = memory.manager.status();
					const decorated = decorateCitations(rawResults, includeCitations);
					const resolved = resolveMemoryBackendConfig({
						cfg,
						agentId
					});
					const memoryResults = status.backend === "qmd" ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars) : decorated;
					surfacedMemoryResults = memoryResults.map((result) => ({
						...result,
						corpus: result.source
					}));
					if (dreamingEnabled) queueShortTermRecallTracking({
						workspaceDir: status.workspaceDir,
						query,
						rawResults,
						surfacedResults: memoryResults,
						timezone: dreaming.timezone
					});
					provider = status.provider;
					model = status.model;
					fallback = status.fallback;
					const latestDebug = runtimeDebug.at(-1);
					searchMode = latestDebug?.effectiveMode;
					searchDebug = {
						backend: status.backend,
						configuredMode: latestDebug?.configuredMode,
						effectiveMode: status.backend === "qmd" ? latestDebug?.effectiveMode ?? latestDebug?.configuredMode : "n/a",
						fallback: latestDebug?.fallback,
						searchMs: Math.max(0, Date.now() - searchStartedAt),
						hits: rawResults.length
					};
				}
				const supplementResults = shouldQuerySupplements ? await searchMemoryCorpusSupplements({
					query,
					maxResults,
					agentSessionKey: options.agentSessionKey,
					corpus: requestedCorpus
				}) : [];
				return jsonResult({
					results: mergeMemorySearchCorpusResults({
						memoryResults: surfacedMemoryResults,
						supplementResults,
						maxResults: Math.max(1, maxResults ?? 10),
						balanceCorpora: requestedCorpus === "all"
					}),
					provider,
					model,
					fallback,
					citations: citationsMode,
					mode: searchMode,
					debug: searchDebug
				});
			} catch (err) {
				return jsonResult(buildMemorySearchUnavailableResult(formatErrorMessage(err)));
			}
		}
	});
}
function createMemoryGetTool(options) {
	return createMemoryTool({
		options,
		label: "Memory Get",
		name: "memory_get",
		description: "Safe exact excerpt read from MEMORY.md or memory/*.md. Defaults to a bounded excerpt when lines are omitted, includes truncation/continuation info when more content exists, and `corpus=wiki` reads from registered compiled-wiki supplements.",
		parameters: MemoryGetSchema,
		execute: ({ cfg, agentId }) => async (_toolCallId, params) => {
			const rawParams = asToolParamsRecord(params);
			const relPath = readStringParam(rawParams, "path", { required: true });
			const from = readNumberParam(rawParams, "from", { integer: true });
			const lines = readNumberParam(rawParams, "lines", { integer: true });
			const requestedCorpus = readStringParam(rawParams, "corpus");
			const { readAgentMemoryFile, resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
			if (requestedCorpus === "wiki") return jsonResult(await getSupplementMemoryReadResult({
				relPath,
				from: from ?? void 0,
				lines: lines ?? void 0,
				agentSessionKey: options.agentSessionKey,
				corpus: requestedCorpus
			}) ?? {
				path: relPath,
				text: "",
				disabled: true,
				error: "wiki corpus result not found"
			});
			if (resolveMemoryBackendConfig({
				cfg,
				agentId
			}).backend === "builtin") return await executeMemoryReadResult({
				read: async () => await readAgentMemoryFile({
					cfg,
					agentId,
					relPath,
					from: from ?? void 0,
					lines: lines ?? void 0
				}),
				requestedCorpus,
				relPath,
				from: from ?? void 0,
				lines: lines ?? void 0,
				agentSessionKey: options.agentSessionKey
			});
			const memory = await getMemoryManagerContextWithPurpose({
				cfg,
				agentId,
				purpose: "status"
			});
			if ("error" in memory) return jsonResult({
				path: relPath,
				text: "",
				disabled: true,
				error: memory.error
			});
			return await executeMemoryReadResult({
				read: async () => await memory.manager.readFile({
					relPath,
					from: from ?? void 0,
					lines: lines ?? void 0
				}),
				requestedCorpus,
				relPath,
				from: from ?? void 0,
				lines: lines ?? void 0,
				agentSessionKey: options.agentSessionKey
			});
		}
	});
}
//#endregion
export { createMemoryGetTool, createMemorySearchTool };
