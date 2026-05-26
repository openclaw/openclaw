import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as openRootFileSync } from "./root-file-jRMCpJW4.js";
import { r as resolveAgentModelFallbackValues } from "./model-input-ChW9XXsQ.js";
import { a as resolveAgentEffectiveModelPrimary, u as resolveAgentModelFallbacksOverride } from "./agent-scope-CtLXGcWm.js";
import { c as parseAgentSessionKey, r as isCronRunSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { l as normalizeAgentId, u as normalizeMainKey } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId, n as listAgentIds, o as resolveAgentWorkspaceDir, r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import "./boundary-file-read-CBe_wA_B.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { i as listThinkingLevelOptions } from "./thinking-DNSlsULp.js";
import { d as resolveAvatarMime, i as isAvatarHttpUrl, l as isWorkspaceRelativeAvatarPath, o as isPathWithinRoot, r as isAvatarDataUrl, t as AVATAR_MAX_BYTES } from "./avatar-policy-BSD55fx7.js";
import { y as projectPluginSessionExtensionsSync } from "./loader-DKK7Ita0.js";
import { n as resolveAgentMainSessionKey } from "./main-session-D3q_5w0B.js";
import { a as resolveSessionStoreKey, i as resolveSessionStoreAgentId, o as resolveStoredSessionKeyForAgentStore } from "./combined-store-gateway-NV2GSCR6.js";
import { s as normalizeSessionDeliveryFields } from "./delivery-context.shared-CBmB9dF7.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { y as buildGroupDisplayName } from "./store-BmtchQvp.js";
import { o as resolveFreshSessionTotalTokens } from "./types-BgvyBC-3.js";
import { i as resolveAllAgentSessionStoreTargetsSync } from "./targets-B5o7Ubgb.js";
import "./sessions-CQHHcgC_.js";
import { S as findModelCatalogEntry, l as inferUniqueProviderFromConfiguredModels, v as resolveConfiguredModelRef, w as modelSupportsInput } from "./model-selection-shared-ClxdEp4X.js";
import { i as parseModelRef } from "./model-selection-normalize-CBfQo-Fd.js";
import { t as isCliProvider } from "./model-selection-cli-DS-HhXIv.js";
import { i as normalizeStoredOverrideModel, m as resolveThinkingDefault, s as resolveDefaultModelForAgent, u as resolvePersistedSelectedModelRef } from "./model-selection-P-81eBKx.js";
import "./model-catalog-DhWpNp70.js";
import { d as readSessionTitleFieldsFromTranscript, f as readSessionTitleFieldsFromTranscriptAsync, s as readRecentSessionUsageFromTranscript } from "./session-utils.fs-CsnHXIqH.js";
import { t as resolveModelAgentRuntimeMetadata } from "./agent-runtime-metadata-DOglN8Yf.js";
import { a as lookupContextTokens, o as resolveContextTokensForModel } from "./context-L0xQd5wI.js";
import { C as getSubagentSessionStartedAt, S as getSubagentSessionRuntimeMs, w as resolveSubagentSessionStatus, x as shouldKeepSubagentRunChildLink } from "./subagent-registry-state-DbOPrqYx.js";
import { a as isSubagentRunLive, i as getSessionDisplaySubagentRunByChildSessionKey, n as countActiveDescendantRuns, s as listSubagentRunsForController, t as buildSubagentRunReadIndex } from "./subagent-registry-read-0y5BjaUV.js";
import { a as resolveModelCostConfig, t as estimateUsageCost } from "./usage-format-BEywPhmZ.js";
import fs from "node:fs";
import path from "node:path";
//#region src/gateway/session-utils.ts
const DERIVED_TITLE_MAX_LEN = 60;
function tryResolveExistingPath(value) {
	try {
		return fs.realpathSync(value);
	} catch {
		return null;
	}
}
function resolveIdentityAvatarUrl(cfg, agentId, avatar) {
	if (!avatar) return;
	const trimmed = normalizeOptionalString(avatar) ?? "";
	if (!trimmed) return;
	if (isAvatarDataUrl(trimmed) || isAvatarHttpUrl(trimmed)) return trimmed;
	if (!isWorkspaceRelativeAvatarPath(trimmed)) return;
	const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
	const workspaceRoot = tryResolveExistingPath(workspaceDir) ?? path.resolve(workspaceDir);
	const resolvedCandidate = path.resolve(workspaceRoot, trimmed);
	if (!isPathWithinRoot(workspaceRoot, resolvedCandidate)) return;
	try {
		const opened = openRootFileSync({
			absolutePath: resolvedCandidate,
			rootPath: workspaceRoot,
			rootRealPath: workspaceRoot,
			boundaryLabel: "workspace root",
			maxBytes: AVATAR_MAX_BYTES,
			skipLexicalRootCheck: true
		});
		if (!opened.ok) return;
		try {
			const buffer = fs.readFileSync(opened.fd);
			return `data:${resolveAvatarMime(resolvedCandidate)};base64,${buffer.toString("base64")}`;
		} finally {
			fs.closeSync(opened.fd);
		}
	} catch {
		return;
	}
}
function formatSessionIdPrefix(sessionId, updatedAt) {
	const prefix = sessionId.slice(0, 8);
	if (updatedAt && updatedAt > 0) return `${prefix} (${new Date(updatedAt).toISOString().slice(0, 10)})`;
	return prefix;
}
function truncateTitle(text, maxLen) {
	if (text.length <= maxLen) return text;
	const cut = text.slice(0, maxLen - 1);
	const lastSpace = cut.lastIndexOf(" ");
	if (lastSpace > maxLen * .6) return cut.slice(0, lastSpace) + "…";
	return cut + "…";
}
function deriveSessionTitle(entry, firstUserMessage) {
	if (!entry) return;
	if (normalizeOptionalString(entry.displayName)) return normalizeOptionalString(entry.displayName);
	if (normalizeOptionalString(entry.subject)) return normalizeOptionalString(entry.subject);
	if (firstUserMessage?.trim()) return truncateTitle(firstUserMessage.replace(/\s+/g, " ").trim(), DERIVED_TITLE_MAX_LEN);
	if (entry.sessionId) return formatSessionIdPrefix(entry.sessionId, entry.updatedAt);
}
function resolveSessionRuntimeMs(run, now) {
	return getSubagentSessionRuntimeMs(run, now);
}
function resolvePositiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function resolveNonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function isProjectableCompactionCheckpoint(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const checkpoint = value;
	return Boolean(normalizeOptionalString(checkpoint.checkpointId)) && typeof checkpoint.createdAt === "number" && Number.isFinite(checkpoint.createdAt) && (checkpoint.reason === "manual" || checkpoint.reason === "auto-threshold" || checkpoint.reason === "overflow-retry" || checkpoint.reason === "timeout-retry");
}
function resolveProjectableCompactionCheckpoints(entry) {
	const checkpoints = entry?.compactionCheckpoints;
	if (!Array.isArray(checkpoints) || checkpoints.length === 0) return [];
	return checkpoints.filter(isProjectableCompactionCheckpoint);
}
function resolveLatestCompactionCheckpoint(checkpoints) {
	return checkpoints.reduce((latest, checkpoint) => !latest || checkpoint.createdAt > latest.createdAt ? checkpoint : latest, void 0);
}
function buildCompactionCheckpointPreview(checkpoint) {
	if (!checkpoint) return;
	const checkpointId = normalizeOptionalString(checkpoint.checkpointId);
	const createdAt = checkpoint.createdAt;
	const reason = checkpoint.reason;
	if (!checkpointId || typeof createdAt !== "number" || !Number.isFinite(createdAt)) return;
	if (reason !== "manual" && reason !== "auto-threshold" && reason !== "overflow-retry" && reason !== "timeout-retry") return;
	return {
		checkpointId,
		createdAt,
		reason
	};
}
function resolveModelCostConfigCached(provider, model, cfg, rowContext) {
	if (!rowContext) return resolveModelCostConfig({
		provider,
		model,
		config: cfg
	});
	const key = createSessionRowModelCacheKey(provider, model);
	if (rowContext.modelCostConfigByModelRef.has(key)) return rowContext.modelCostConfigByModelRef.get(key);
	const value = resolveModelCostConfig({
		provider,
		model,
		config: cfg
	});
	rowContext.modelCostConfigByModelRef.set(key, value);
	return value;
}
function resolveEstimatedSessionCostUsd(params) {
	const explicitCostUsd = resolveNonNegativeNumber(params.explicitCostUsd ?? params.entry?.estimatedCostUsd);
	if (explicitCostUsd !== void 0) return explicitCostUsd;
	const input = resolvePositiveNumber(params.entry?.inputTokens);
	const output = resolvePositiveNumber(params.entry?.outputTokens);
	const cacheRead = resolvePositiveNumber(params.entry?.cacheRead);
	const cacheWrite = resolvePositiveNumber(params.entry?.cacheWrite);
	if (input === void 0 && output === void 0 && cacheRead === void 0 && cacheWrite === void 0) return;
	const cost = resolveModelCostConfigCached(params.provider, params.model, params.cfg, params.rowContext);
	if (!cost) return;
	return resolveNonNegativeNumber(estimateUsageCost({
		usage: {
			...input !== void 0 ? { input } : {},
			...output !== void 0 ? { output } : {},
			...cacheRead !== void 0 ? { cacheRead } : {},
			...cacheWrite !== void 0 ? { cacheWrite } : {}
		},
		cost
	}));
}
const STALE_STORE_ONLY_CHILD_LINK_MS = 3600 * 1e3;
function isFinitePositiveTimestamp(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function isTerminalSessionStatus(status) {
	return status === "done" || status === "failed" || status === "killed" || status === "timeout";
}
function shouldKeepStoreOnlyChildLink(entry, now) {
	if (isTerminalSessionStatus(entry.status) || isFinitePositiveTimestamp(entry.endedAt)) {
		const endedAt = isFinitePositiveTimestamp(entry.endedAt) ? entry.endedAt : entry.updatedAt;
		return isFinitePositiveTimestamp(endedAt) && now - endedAt <= 18e5;
	}
	if (entry.status === "running" || isFinitePositiveTimestamp(entry.startedAt)) return true;
	return isFinitePositiveTimestamp(entry.updatedAt) && now - entry.updatedAt <= STALE_STORE_ONLY_CHILD_LINK_MS;
}
function resolveRuntimeChildSessionKeys(controllerSessionKey, now = Date.now(), subagentRuns) {
	const childSessionKeys = /* @__PURE__ */ new Set();
	const controllerKey = controllerSessionKey.trim();
	const runs = subagentRuns ? subagentRuns.runsByControllerSessionKey.get(controllerKey) ?? [] : listSubagentRunsForController(controllerSessionKey);
	for (const entry of runs) {
		const childSessionKey = normalizeOptionalString(entry.childSessionKey);
		if (!childSessionKey) continue;
		const latest = subagentRuns ? subagentRuns.getDisplaySubagentRun(childSessionKey) : getSessionDisplaySubagentRunByChildSessionKey(childSessionKey);
		if (!latest) continue;
		if ((normalizeOptionalString(latest?.controllerSessionKey) || normalizeOptionalString(latest?.requesterSessionKey)) !== controllerSessionKey) continue;
		if (!shouldKeepSubagentRunChildLink(latest, {
			activeDescendants: subagentRuns ? subagentRuns.countActiveDescendantRuns(childSessionKey) : countActiveDescendantRuns(childSessionKey),
			now
		})) continue;
		childSessionKeys.add(childSessionKey);
	}
	const childSessions = Array.from(childSessionKeys);
	return childSessions.length > 0 ? childSessions : void 0;
}
function addChildSessionKey(childSessionsByKey, parentKey, childKey) {
	const current = childSessionsByKey.get(parentKey);
	if (current) {
		if (!current.includes(childKey)) current.push(childKey);
		return;
	}
	childSessionsByKey.set(parentKey, [childKey]);
}
function buildStoreChildSessionIndex(store, now = Date.now(), subagentRuns) {
	const childSessionsByKey = /* @__PURE__ */ new Map();
	for (const [key, entry] of Object.entries(store)) {
		if (!entry) continue;
		const parentKeys = [normalizeOptionalString(entry.spawnedBy), normalizeOptionalString(entry.parentSessionKey)].filter((value) => Boolean(value) && value !== key);
		if (parentKeys.length === 0) continue;
		const latest = subagentRuns ? subagentRuns.getDisplaySubagentRun(key) : getSessionDisplaySubagentRunByChildSessionKey(key);
		let latestControllerSessionKey;
		if (latest) {
			latestControllerSessionKey = normalizeOptionalString(latest.controllerSessionKey) || normalizeOptionalString(latest.requesterSessionKey);
			if (!shouldKeepSubagentRunChildLink(latest, {
				activeDescendants: subagentRuns ? subagentRuns.countActiveDescendantRuns(key) : countActiveDescendantRuns(key),
				now
			})) continue;
		} else if (!shouldKeepStoreOnlyChildLink(entry, now)) continue;
		for (const parentKey of parentKeys) {
			if (latestControllerSessionKey && latestControllerSessionKey !== parentKey) continue;
			addChildSessionKey(childSessionsByKey, parentKey, key);
		}
	}
	return childSessionsByKey;
}
function buildSessionListRowContext(params) {
	const subagentRuns = buildSubagentRunReadIndex(params.now);
	return {
		subagentRuns,
		storeChildSessionsByKey: buildStoreChildSessionIndex(params.store, params.now, subagentRuns),
		selectedModelByOverrideRef: /* @__PURE__ */ new Map(),
		thinkingMetadataByModelRef: /* @__PURE__ */ new Map(),
		displayModelIdentityByKey: /* @__PURE__ */ new Map(),
		modelCostConfigByModelRef: /* @__PURE__ */ new Map()
	};
}
function createSessionRowModelCacheKey(provider, model) {
	return `${normalizeLowercaseStringOrEmpty(provider)}\0${normalizeOptionalString(model) ?? ""}`;
}
function resolveSessionSelectedModelRef(params) {
	const override = normalizeStoredOverrideModel({
		providerOverride: params.entry?.providerOverride,
		modelOverride: params.entry?.modelOverride
	});
	if (!override.modelOverride) return null;
	if (!params.rowContext) return resolveSessionModelRef(params.cfg, params.entry, params.agentId, { allowPluginNormalization: params.allowPluginNormalization });
	const key = [
		normalizeAgentId(params.agentId),
		override.providerOverride ?? "",
		override.modelOverride
	].join("\0");
	const cached = params.rowContext.selectedModelByOverrideRef.get(key);
	if (cached) return cached;
	const selected = resolveSessionModelRef(params.cfg, params.entry, params.agentId, { allowPluginNormalization: params.allowPluginNormalization });
	params.rowContext.selectedModelByOverrideRef.set(key, selected);
	return selected;
}
function resolveSessionRowThinkingMetadata(params) {
	if (!params.rowContext) return {
		levels: listThinkingLevelOptions(params.provider, params.model, params.modelCatalog),
		defaultLevel: resolveGatewaySessionThinkingDefault({
			cfg: params.cfg,
			provider: params.provider,
			model: params.model,
			agentId: params.agentId,
			modelCatalog: params.modelCatalog
		})
	};
	const key = `${normalizeAgentId(params.agentId)}\0${createSessionRowModelCacheKey(params.provider, params.model)}`;
	const cached = params.rowContext.thinkingMetadataByModelRef.get(key);
	if (cached) return cached;
	const metadata = {
		levels: listThinkingLevelOptions(params.provider, params.model, params.modelCatalog),
		defaultLevel: resolveGatewaySessionThinkingDefault({
			cfg: params.cfg,
			provider: params.provider,
			model: params.model,
			agentId: params.agentId,
			modelCatalog: params.modelCatalog
		})
	};
	params.rowContext.thinkingMetadataByModelRef.set(key, metadata);
	return metadata;
}
function mergeChildSessionKeys(runtimeChildSessions, storeChildSessions) {
	if (!runtimeChildSessions?.length) return storeChildSessions?.length ? storeChildSessions : void 0;
	if (!storeChildSessions?.length) return runtimeChildSessions;
	return Array.from(new Set([...runtimeChildSessions, ...storeChildSessions]));
}
function resolveChildSessionKeys(controllerSessionKey, store, now = Date.now(), subagentRuns) {
	return mergeChildSessionKeys(resolveRuntimeChildSessionKeys(controllerSessionKey, now, subagentRuns), buildStoreChildSessionIndex(store, now, subagentRuns).get(controllerSessionKey));
}
function resolveTranscriptUsageFallback(params) {
	const entry = params.entry;
	if (!entry?.sessionId) return null;
	const parsed = parseAgentSessionKey(params.key);
	const agentId = parsed?.agentId ? normalizeAgentId(parsed.agentId) : resolveDefaultAgentId(params.cfg);
	const snapshot = readRecentSessionUsageFromTranscript(entry.sessionId, params.storePath, entry.sessionFile, agentId, typeof params.maxTranscriptBytes === "number" ? params.maxTranscriptBytes : 256 * 1024);
	if (!snapshot) return null;
	const modelProvider = snapshot.modelProvider ?? params.fallbackProvider;
	const model = snapshot.model ?? params.fallbackModel;
	const contextTokens = resolveContextTokensForModel({
		cfg: params.cfg,
		provider: modelProvider,
		model,
		allowAsyncLoad: false
	});
	const estimatedCostUsd = resolveEstimatedSessionCostUsd({
		cfg: params.cfg,
		provider: modelProvider,
		model,
		explicitCostUsd: snapshot.costUsd,
		entry: {
			inputTokens: snapshot.inputTokens,
			outputTokens: snapshot.outputTokens,
			cacheRead: snapshot.cacheRead,
			cacheWrite: snapshot.cacheWrite
		},
		rowContext: params.rowContext
	});
	return {
		modelProvider,
		model,
		totalTokens: resolvePositiveNumber(snapshot.totalTokens),
		totalTokensFresh: snapshot.totalTokensFresh === true,
		contextTokens: resolvePositiveNumber(contextTokens),
		estimatedCostUsd
	};
}
/**
* Returns the owning agent id if the session key belongs to an agent that is no
* longer present in config (deleted). Returns null for non-agent legacy/global
* keys, or when the owning agent still exists (#65524).
*/
function resolveDeletedAgentIdFromSessionKey(cfg, sessionKey) {
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed) return null;
	const agentId = normalizeAgentId(parsed.agentId);
	if (listAgentIds(cfg).includes(agentId)) return null;
	return agentId;
}
function loadSessionEntry(sessionKey, opts) {
	const cfg = getRuntimeConfig();
	const target = resolveGatewaySessionStoreTarget({
		cfg,
		key: normalizeOptionalString(sessionKey) ?? "",
		...opts?.agentId ? { agentId: opts.agentId } : {}
	});
	const storePath = target.storePath;
	const store = loadSessionStore(storePath);
	const freshestMatch = resolveFreshestSessionStoreMatchFromStoreKeys(store, target.storeKeys);
	const legacyKey = freshestMatch?.key !== target.canonicalKey ? freshestMatch?.key : void 0;
	return {
		cfg,
		storePath,
		store,
		entry: freshestMatch?.entry,
		canonicalKey: target.canonicalKey,
		legacyKey
	};
}
function resolveFreshestSessionStoreMatchFromStoreKeys(store, storeKeys) {
	let freshest;
	for (const key of storeKeys) {
		const entry = store[key];
		if (!entry) continue;
		const match = {
			key,
			entry
		};
		if (!freshest || (match.entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0)) freshest = match;
	}
	return freshest;
}
function resolveFreshestSessionEntryFromStoreKeys(store, storeKeys) {
	return resolveFreshestSessionStoreMatchFromStoreKeys(store, storeKeys)?.entry;
}
function findFreshestStoreMatch(store, ...candidates) {
	const matches = /* @__PURE__ */ new Map();
	for (const candidate of candidates) {
		const trimmed = normalizeOptionalString(candidate) ?? "";
		if (!trimmed) continue;
		const exact = store[trimmed];
		if (exact) matches.set(trimmed, {
			entry: exact,
			key: trimmed
		});
		for (const key of findStoreKeysIgnoreCase(store, trimmed)) {
			const entry = store[key];
			if (entry) matches.set(key, {
				entry,
				key
			});
		}
	}
	if (matches.size === 0) return;
	let freshest;
	for (const match of matches.values()) if (!freshest || (match.entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0)) freshest = match;
	return freshest;
}
/**
* Find all on-disk store keys that match the given key case-insensitively.
* Returns every key from the store whose lowercased form equals the target's lowercased form.
*/
function findStoreKeysIgnoreCase(store, targetKey) {
	const lowered = normalizeLowercaseStringOrEmpty(targetKey);
	const matches = [];
	for (const key of Object.keys(store)) if (normalizeLowercaseStringOrEmpty(key) === lowered) matches.push(key);
	return matches;
}
/**
* Remove legacy key variants for one canonical session key.
* Candidates can include aliases (for example, "agent:ops:main" when canonical is "agent:ops:work").
*/
function pruneLegacyStoreKeys(params) {
	const keysToDelete = /* @__PURE__ */ new Set();
	for (const candidate of params.candidates) {
		const trimmed = normalizeOptionalString(candidate ?? "") ?? "";
		if (!trimmed) continue;
		if (trimmed !== params.canonicalKey) keysToDelete.add(trimmed);
		for (const match of findStoreKeysIgnoreCase(params.store, trimmed)) if (match !== params.canonicalKey) keysToDelete.add(match);
	}
	for (const key of keysToDelete) delete params.store[key];
}
function migrateAndPruneGatewaySessionStoreKey(params) {
	const target = resolveGatewaySessionStoreTarget({
		cfg: params.cfg,
		key: params.key,
		store: params.store
	});
	const primaryKey = target.canonicalKey;
	const freshestMatch = resolveFreshestSessionStoreMatchFromStoreKeys(params.store, target.storeKeys);
	if (freshestMatch) {
		const currentPrimary = params.store[primaryKey];
		if (!currentPrimary || (freshestMatch.entry.updatedAt ?? 0) > (currentPrimary.updatedAt ?? 0)) params.store[primaryKey] = freshestMatch.entry;
	}
	pruneLegacyStoreKeys({
		store: params.store,
		canonicalKey: primaryKey,
		candidates: target.storeKeys
	});
	return {
		target,
		primaryKey,
		entry: params.store[primaryKey]
	};
}
function classifySessionKey(key, entry) {
	if (key === "global") return "global";
	if (key === "unknown") return "unknown";
	if (entry?.chatType === "group" || entry?.chatType === "channel") return "group";
	if (key.includes(":group:") || key.includes(":channel:")) return "group";
	return "direct";
}
function parseGroupKey(key) {
	const parts = (parseAgentSessionKey(key)?.rest ?? key).split(":").filter(Boolean);
	if (parts.length >= 3) {
		const [channel, kind, ...rest] = parts;
		if (kind === "group" || kind === "channel") return {
			channel,
			kind,
			id: rest.join(":")
		};
	}
	return null;
}
function isStorePathTemplate(store) {
	return typeof store === "string" && store.includes("{agentId}");
}
function listExistingAgentIdsFromDisk() {
	const root = resolveStateDir();
	const agentsDir = path.join(root, "agents");
	try {
		return fs.readdirSync(agentsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => normalizeAgentId(entry.name)).filter(Boolean);
	} catch {
		return [];
	}
}
function listConfiguredAgentIds(cfg) {
	const ids = /* @__PURE__ */ new Set();
	const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
	ids.add(defaultId);
	for (const entry of cfg.agents?.list ?? []) if (entry?.id) ids.add(normalizeAgentId(entry.id));
	for (const id of listExistingAgentIdsFromDisk()) ids.add(id);
	const sorted = Array.from(ids).filter(Boolean);
	sorted.sort((a, b) => a.localeCompare(b));
	return sorted.includes(defaultId) ? [defaultId, ...sorted.filter((id) => id !== defaultId)] : sorted;
}
function normalizeFallbackList(values) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) continue;
		const key = normalizeLowercaseStringOrEmpty(trimmed);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}
function resolveGatewayAgentModel(cfg, agentId) {
	const primary = resolveAgentEffectiveModelPrimary(cfg, agentId)?.trim();
	const fallbackOverride = resolveAgentModelFallbacksOverride(cfg, agentId);
	const defaultFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
	const fallbacks = normalizeFallbackList(fallbackOverride ?? defaultFallbacks);
	if (!primary && fallbacks.length === 0) return;
	return {
		...primary ? { primary } : {},
		...fallbacks.length > 0 ? { fallbacks } : {}
	};
}
function listAgentsForGateway(cfg) {
	const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
	const mainKey = normalizeMainKey(cfg.session?.mainKey);
	const scope = cfg.session?.scope ?? "per-sender";
	const configuredById = /* @__PURE__ */ new Map();
	for (const entry of cfg.agents?.list ?? []) {
		if (!entry?.id) continue;
		const configuredName = normalizeOptionalString(entry.name);
		const identity = entry.identity ? {
			name: normalizeOptionalString(entry.identity.name),
			theme: normalizeOptionalString(entry.identity.theme),
			emoji: normalizeOptionalString(entry.identity.emoji),
			avatar: normalizeOptionalString(entry.identity.avatar),
			avatarUrl: resolveIdentityAvatarUrl(cfg, normalizeAgentId(entry.id), normalizeOptionalString(entry.identity.avatar))
		} : void 0;
		configuredById.set(normalizeAgentId(entry.id), {
			name: configuredName ?? identity?.name,
			identity
		});
	}
	const explicitIds = new Set((cfg.agents?.list ?? []).map((entry) => entry?.id ? normalizeAgentId(entry.id) : "").filter(Boolean));
	const allowedIds = explicitIds.size > 0 ? new Set([...explicitIds, defaultId]) : null;
	let agentIds = listConfiguredAgentIds(cfg).filter((id) => allowedIds ? allowedIds.has(id) : true);
	if (mainKey && !agentIds.includes(mainKey) && (!allowedIds || allowedIds.has(mainKey))) agentIds = [...agentIds, mainKey];
	return {
		defaultId,
		mainKey,
		scope,
		agents: agentIds.map((id) => {
			const meta = configuredById.get(id);
			const model = resolveGatewayAgentModel(cfg, id);
			const resolvedModel = resolveDefaultModelForAgent({
				cfg,
				agentId: id
			});
			return Object.assign({
				id,
				name: meta?.name,
				identity: meta?.identity,
				workspace: resolveAgentWorkspaceDir(cfg, id),
				agentRuntime: resolveModelAgentRuntimeMetadata({
					cfg,
					agentId: id,
					provider: resolvedModel.provider,
					model: resolvedModel.model,
					sessionKey: resolveAgentMainSessionKey({
						cfg,
						agentId: id
					}),
					acpRuntime: false
				})
			}, model ? { model } : {});
		})
	};
}
function buildGatewaySessionStoreScanTargets(params) {
	const targets = /* @__PURE__ */ new Set();
	if (params.canonicalKey) targets.add(params.canonicalKey);
	if (params.key && params.key !== params.canonicalKey) targets.add(params.key);
	if (params.canonicalKey === "global" || params.canonicalKey === "unknown") return [...targets];
	const agentMainKey = resolveAgentMainSessionKey({
		cfg: params.cfg,
		agentId: params.agentId
	});
	if (params.canonicalKey === agentMainKey) targets.add(`agent:${params.agentId}:main`);
	return [...targets];
}
function resolveGatewaySessionStoreCandidates(cfg, agentId) {
	const storeConfig = cfg.session?.store;
	const defaultTarget = {
		agentId,
		storePath: resolveStorePath(storeConfig, { agentId })
	};
	if (!isStorePathTemplate(storeConfig)) return [defaultTarget];
	const targets = /* @__PURE__ */ new Map();
	targets.set(defaultTarget.storePath, defaultTarget);
	for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) if (target.agentId === agentId) targets.set(target.storePath, target);
	return [...targets.values()];
}
function resolveGatewaySessionStoreLookup(params) {
	const scanTargets = buildGatewaySessionStoreScanTargets(params);
	const candidates = resolveGatewaySessionStoreCandidates(params.cfg, params.agentId);
	const fallback = candidates[0] ?? {
		agentId: params.agentId,
		storePath: resolveStorePath(params.cfg.session?.store, { agentId: params.agentId })
	};
	let selectedStorePath = fallback.storePath;
	let selectedStore = params.initialStore ?? loadSessionStore(fallback.storePath);
	let selectedMatch = findFreshestStoreMatch(selectedStore, ...scanTargets);
	let selectedUpdatedAt = selectedMatch?.entry.updatedAt ?? Number.NEGATIVE_INFINITY;
	for (let index = 1; index < candidates.length; index += 1) {
		const candidate = candidates[index];
		if (!candidate) continue;
		const store = loadSessionStore(candidate.storePath);
		const match = findFreshestStoreMatch(store, ...scanTargets);
		if (!match) continue;
		const updatedAt = match.entry.updatedAt ?? 0;
		if (!selectedMatch || updatedAt >= selectedUpdatedAt) {
			selectedStorePath = candidate.storePath;
			selectedStore = store;
			selectedMatch = match;
			selectedUpdatedAt = updatedAt;
		}
	}
	return {
		storePath: selectedStorePath,
		store: selectedStore,
		match: selectedMatch
	};
}
function resolveExplicitDeletedLegacyMainStoreTarget(params) {
	const parsed = parseAgentSessionKey(params.key);
	const legacyAgentId = normalizeAgentId(parsed?.agentId);
	if (!parsed || legacyAgentId !== "main" || listAgentIds(params.cfg).includes(legacyAgentId)) return null;
	const canonicalKey = resolveStoredSessionKeyForAgentStore({
		cfg: params.cfg,
		agentId: legacyAgentId,
		sessionKey: params.key
	});
	const agentMainKey = resolveAgentMainSessionKey({
		cfg: params.cfg,
		agentId: legacyAgentId
	});
	const legacyAgentMainKey = `agent:${legacyAgentId}:main`;
	const lookupSeeds = Array.from(new Set([
		params.key,
		canonicalKey,
		agentMainKey,
		legacyAgentMainKey
	]));
	let best;
	for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg)) {
		if (target.agentId !== legacyAgentId) continue;
		const store = loadSessionStore(target.storePath);
		const match = findFreshestStoreMatch(store, ...lookupSeeds);
		if (!match) continue;
		if (!best || (match.entry.updatedAt ?? 0) >= (best.match.entry.updatedAt ?? 0)) best = {
			storePath: target.storePath,
			store,
			match
		};
	}
	if (!best) return null;
	const storeKeys = new Set([canonicalKey]);
	if (params.key !== canonicalKey) storeKeys.add(params.key);
	storeKeys.add(best.match.key);
	if (params.scanLegacyKeys !== false) for (const seed of lookupSeeds) {
		storeKeys.add(seed);
		for (const legacyKey of findStoreKeysIgnoreCase(best.store, seed)) storeKeys.add(legacyKey);
	}
	return {
		agentId: legacyAgentId,
		storePath: best.storePath,
		canonicalKey,
		storeKeys: Array.from(storeKeys)
	};
}
function resolveGatewaySessionStoreTarget(params) {
	const key = normalizeOptionalString(params.key) ?? "";
	const explicitDeletedMainTarget = resolveExplicitDeletedLegacyMainStoreTarget({
		cfg: params.cfg,
		key,
		scanLegacyKeys: params.scanLegacyKeys
	});
	if (explicitDeletedMainTarget) return explicitDeletedMainTarget;
	const canonicalKey = resolveSessionStoreKey({
		cfg: params.cfg,
		sessionKey: key
	});
	const requestedAgentId = normalizeOptionalString(params.agentId);
	const agentId = canonicalKey === "global" && requestedAgentId ? normalizeAgentId(requestedAgentId) : resolveSessionStoreAgentId(params.cfg, canonicalKey);
	const { storePath, store } = resolveGatewaySessionStoreLookup({
		cfg: params.cfg,
		key,
		canonicalKey,
		agentId,
		initialStore: params.store
	});
	if (canonicalKey === "global" || canonicalKey === "unknown") return {
		agentId,
		storePath,
		canonicalKey,
		storeKeys: key && key !== canonicalKey ? [canonicalKey, key] : [key]
	};
	const storeKeys = /* @__PURE__ */ new Set();
	storeKeys.add(canonicalKey);
	if (key && key !== canonicalKey) storeKeys.add(key);
	if (params.scanLegacyKeys !== false) {
		const scanTargets = buildGatewaySessionStoreScanTargets({
			cfg: params.cfg,
			key,
			canonicalKey,
			agentId
		});
		for (const seed of scanTargets) for (const legacyKey of findStoreKeysIgnoreCase(store, seed)) storeKeys.add(legacyKey);
	}
	return {
		agentId,
		storePath,
		canonicalKey,
		storeKeys: Array.from(storeKeys)
	};
}
function resolveGatewaySessionThinkingDefault(params) {
	return (params.agentId ? resolveAgentConfig(params.cfg, params.agentId)?.thinkingDefault : void 0) ?? resolveThinkingDefault({
		cfg: params.cfg,
		provider: params.provider,
		model: params.model,
		catalog: params.modelCatalog
	});
}
function getSessionDefaults(cfg, modelCatalog, options) {
	const resolved = resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL,
		allowPluginNormalization: options?.allowPluginNormalization
	});
	const contextTokens = cfg.agents?.defaults?.contextTokens ?? lookupContextTokens(resolved.model, { allowAsyncLoad: false }) ?? 2e5;
	const thinkingLevels = listThinkingLevelOptions(resolved.provider, resolved.model, modelCatalog);
	return {
		modelProvider: resolved.provider ?? null,
		model: resolved.model ?? null,
		contextTokens: contextTokens ?? null,
		thinkingLevels,
		thinkingOptions: thinkingLevels.map((level) => level.label),
		thinkingDefault: resolveGatewaySessionThinkingDefault({
			cfg,
			provider: resolved.provider,
			model: resolved.model,
			modelCatalog
		})
	};
}
function resolveSessionModelRef(cfg, entry, agentId, options) {
	const normalizedOverride = normalizeStoredOverrideModel({
		providerOverride: entry?.providerOverride,
		modelOverride: entry?.modelOverride
	});
	if (normalizedOverride.providerOverride && normalizedOverride.modelOverride) return resolvePersistedSelectedModelRef({
		defaultProvider: normalizedOverride.providerOverride,
		overrideProvider: normalizedOverride.providerOverride,
		overrideModel: normalizedOverride.modelOverride,
		allowPluginNormalization: options?.allowPluginNormalization
	});
	const runtimeProvider = normalizeOptionalString(entry?.modelProvider);
	const runtimeModel = normalizeOptionalString(entry?.model);
	if (runtimeProvider && runtimeModel) return {
		provider: runtimeProvider,
		model: runtimeModel
	};
	const resolved = agentId ? resolveDefaultModelForAgent({
		cfg,
		agentId,
		allowPluginNormalization: options?.allowPluginNormalization
	}) : resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL,
		allowPluginNormalization: options?.allowPluginNormalization
	});
	const persisted = resolvePersistedSelectedModelRef({
		defaultProvider: resolved.provider || "openai",
		runtimeProvider,
		runtimeModel,
		overrideProvider: normalizedOverride.providerOverride,
		overrideModel: normalizedOverride.modelOverride,
		allowPluginNormalization: options?.allowPluginNormalization
	});
	if (persisted) return persisted;
	return resolved;
}
async function resolveGatewayModelSupportsImages(params) {
	if (!params.model) return true;
	try {
		const modelEntry = findModelCatalogEntry(await params.loadGatewayModelCatalog({ readOnly: false }), {
			provider: params.provider,
			modelId: params.model
		});
		const normalizedProvider = normalizeOptionalLowercaseString(params.provider ?? modelEntry?.provider);
		const normalizedCandidates = [normalizeLowercaseStringOrEmpty(params.model), normalizeLowercaseStringOrEmpty(modelEntry?.name)].filter(Boolean);
		if (modelEntry) {
			if (modelSupportsInput(modelEntry, "image")) return true;
			if (normalizedProvider === "microsoft-foundry" && normalizedCandidates.some((candidate) => candidate.startsWith("gpt-") || candidate.startsWith("o1") || candidate.startsWith("o3") || candidate.startsWith("o4") || candidate === "computer-use-preview")) return true;
			if (normalizedProvider === "claude-cli" && normalizedCandidates.some((candidate) => candidate === "opus" || candidate === "sonnet" || candidate === "haiku" || candidate.startsWith("claude-"))) return true;
			return false;
		}
		if (normalizedProvider === "claude-cli" && normalizedCandidates.some((candidate) => candidate === "opus" || candidate === "sonnet" || candidate === "haiku" || candidate.startsWith("claude-"))) return true;
		return false;
	} catch {
		return false;
	}
}
function resolveSessionModelIdentityRef(cfg, entry, agentId, fallbackModelRef, options) {
	const runtimeModel = entry?.model?.trim();
	const runtimeProvider = entry?.modelProvider?.trim();
	if (runtimeModel) {
		if (runtimeProvider) return {
			provider: runtimeProvider,
			model: runtimeModel
		};
		const inferredProvider = inferUniqueProviderFromConfiguredModels({
			cfg,
			model: runtimeModel
		});
		if (inferredProvider) return {
			provider: inferredProvider,
			model: runtimeModel
		};
		if (runtimeModel.includes("/")) {
			const parsedRuntime = parseModelRef(runtimeModel, DEFAULT_PROVIDER, { allowPluginNormalization: options?.allowPluginNormalization });
			if (parsedRuntime) return {
				provider: parsedRuntime.provider,
				model: parsedRuntime.model
			};
			return { model: runtimeModel };
		}
		return { model: runtimeModel };
	}
	const fallbackRef = fallbackModelRef?.trim();
	if (fallbackRef) {
		const parsedFallback = parseModelRef(fallbackRef, DEFAULT_PROVIDER, { allowPluginNormalization: options?.allowPluginNormalization });
		if (parsedFallback) return {
			provider: parsedFallback.provider,
			model: parsedFallback.model
		};
		const inferredProvider = inferUniqueProviderFromConfiguredModels({
			cfg,
			model: fallbackRef
		});
		if (inferredProvider) return {
			provider: inferredProvider,
			model: fallbackRef
		};
		return { model: fallbackRef };
	}
	const resolved = resolveSessionModelRef(cfg, entry, agentId, { allowPluginNormalization: options?.allowPluginNormalization });
	return {
		provider: resolved.provider,
		model: resolved.model
	};
}
function resolveSessionDisplayModelIdentityRefCached(params) {
	const ctx = params.rowContext;
	if (!ctx) return resolveSessionDisplayModelIdentityRef(params);
	const key = `${params.agentId}\u0000${createSessionRowModelCacheKey(params.provider, params.model)}`;
	const cached = ctx.displayModelIdentityByKey.get(key);
	if (cached) return cached;
	const value = resolveSessionDisplayModelIdentityRef(params);
	ctx.displayModelIdentityByKey.set(key, value);
	return value;
}
function resolveSessionDisplayModelIdentityRef(params) {
	const provider = normalizeOptionalString(params.provider);
	const model = normalizeOptionalString(params.model);
	if (!provider || !model || !isCliProvider(provider, params.cfg)) return {
		provider,
		model
	};
	const defaultRef = resolveDefaultModelForAgent({
		cfg: params.cfg,
		agentId: params.agentId
	});
	if (model.includes("/")) {
		const parsedModel = parseModelRef(model, defaultRef.provider);
		if (parsedModel && !isCliProvider(parsedModel.provider, params.cfg)) return parsedModel;
	}
	const inferredProvider = inferUniqueProviderFromConfiguredModels({
		cfg: params.cfg,
		model
	});
	if (inferredProvider && !isCliProvider(inferredProvider, params.cfg)) return {
		provider: inferredProvider,
		model
	};
	const parsedModel = parseModelRef(model, defaultRef.provider);
	if (parsedModel && !isCliProvider(parsedModel.provider, params.cfg)) return parsedModel;
	return {
		provider: defaultRef.provider || provider,
		model
	};
}
function buildGatewaySessionRow(params) {
	const { cfg, storePath, store, key, entry } = params;
	const lightweight = params.lightweightListRow === true;
	const skipTranscriptUsage = params.skipTranscriptUsageFallback === true;
	const now = params.now ?? Date.now();
	const updatedAt = entry?.updatedAt ?? null;
	const parsed = parseGroupKey(key);
	const channel = entry?.channel ?? parsed?.channel;
	const subject = entry?.subject;
	const groupChannel = entry?.groupChannel;
	const space = entry?.space;
	const id = parsed?.id;
	const origin = entry?.origin;
	const originLabel = origin?.label;
	const displayName = entry?.displayName ?? (channel ? buildGroupDisplayName({
		provider: channel,
		subject,
		groupChannel,
		space,
		id,
		key
	}) : void 0) ?? entry?.label ?? originLabel;
	const deliveryFields = normalizeSessionDeliveryFields(entry);
	const sessionAgentId = normalizeAgentId(parseAgentSessionKey(key)?.agentId ?? resolveDefaultAgentId(cfg));
	const rowContext = params.rowContext;
	const subagentRun = rowContext ? rowContext.subagentRuns.getDisplaySubagentRun(key) : getSessionDisplaySubagentRunByChildSessionKey(key);
	const subagentOwner = normalizeOptionalString(subagentRun?.controllerSessionKey) || normalizeOptionalString(subagentRun?.requesterSessionKey);
	const liveSubagentRunActive = isSubagentRunLive(subagentRun);
	const persistedSessionStatus = entry?.status;
	const persistedSessionEndedAt = entry?.endedAt;
	const persistedSessionStartedAt = entry?.startedAt;
	const persistedSessionRuntimeMs = entry?.runtimeMs;
	const subagentRunState = subagentRun ? liveSubagentRunActive ? "active" : typeof subagentRun.endedAt === "number" || persistedSessionStatus === "done" || persistedSessionStatus === "failed" || persistedSessionStatus === "killed" || persistedSessionStatus === "timeout" || typeof persistedSessionEndedAt === "number" ? "historical" : "interrupted" : void 0;
	const subagentStatus = subagentRun ? liveSubagentRunActive ? resolveSubagentSessionStatus(subagentRun) : persistedSessionStatus === "running" ? void 0 : persistedSessionStatus ?? (typeof subagentRun.endedAt === "number" ? resolveSubagentSessionStatus(subagentRun) : void 0) : void 0;
	const subagentStartedAt = subagentRun ? liveSubagentRunActive ? getSubagentSessionStartedAt(subagentRun) : persistedSessionStartedAt ?? getSubagentSessionStartedAt(subagentRun) : void 0;
	const subagentEndedAt = subagentRun ? liveSubagentRunActive ? subagentRun.endedAt : persistedSessionEndedAt ?? subagentRun.endedAt : void 0;
	const subagentRuntimeMs = subagentRun ? liveSubagentRunActive ? resolveSessionRuntimeMs(subagentRun, now) : persistedSessionRuntimeMs ?? (typeof subagentRun.endedAt === "number" ? resolveSessionRuntimeMs(subagentRun, now) : void 0) : void 0;
	const selectedModel = resolveSessionSelectedModelRef({
		cfg,
		entry,
		agentId: sessionAgentId,
		rowContext,
		allowPluginNormalization: !lightweight
	});
	const resolvedModel = resolveSessionModelIdentityRef(cfg, entry, sessionAgentId, subagentRun?.model, { allowPluginNormalization: !lightweight });
	const runtimeModelPresent = Boolean(entry?.model?.trim()) || Boolean(entry?.modelProvider?.trim());
	const needsTranscriptTotalTokens = resolvePositiveNumber(resolveFreshSessionTotalTokens(entry)) === void 0;
	const needsTranscriptContextTokens = resolvePositiveNumber(entry?.contextTokens) === void 0;
	const needsTranscriptEstimatedCostUsd = !skipTranscriptUsage && resolveEstimatedSessionCostUsd({
		cfg,
		provider: resolvedModel.provider,
		model: resolvedModel.model ?? "gpt-5.5",
		entry,
		rowContext
	}) === void 0;
	const transcriptUsage = !skipTranscriptUsage && (needsTranscriptTotalTokens || needsTranscriptContextTokens || needsTranscriptEstimatedCostUsd) ? resolveTranscriptUsageFallback({
		cfg,
		key,
		entry,
		storePath,
		fallbackProvider: resolvedModel.provider,
		fallbackModel: resolvedModel.model ?? "gpt-5.5",
		maxTranscriptBytes: params.transcriptUsageMaxBytes,
		rowContext: params.rowContext
	}) : null;
	const preferLiveSubagentModelIdentity = Boolean(subagentRun?.model?.trim()) && subagentStatus === "running";
	const shouldUseTranscriptModelIdentity = runtimeModelPresent && !preferLiveSubagentModelIdentity && (needsTranscriptTotalTokens || needsTranscriptContextTokens);
	const resolvedModelIdentity = {
		provider: resolvedModel.provider,
		model: resolvedModel.model ?? "gpt-5.5"
	};
	const { provider: modelProvider, model } = shouldUseTranscriptModelIdentity ? {
		provider: transcriptUsage?.modelProvider ?? resolvedModelIdentity.provider,
		model: transcriptUsage?.model ?? resolvedModelIdentity.model
	} : resolvedModelIdentity;
	const totalTokens = resolvePositiveNumber(resolveFreshSessionTotalTokens(entry)) ?? resolvePositiveNumber(transcriptUsage?.totalTokens);
	const totalTokensFresh = typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0 ? true : transcriptUsage?.totalTokensFresh === true;
	const childSessions = params.storeChildSessionsByKey ? mergeChildSessionKeys(resolveRuntimeChildSessionKeys(key, now, rowContext?.subagentRuns), params.storeChildSessionsByKey.get(key)) : resolveChildSessionKeys(key, store, now, rowContext?.subagentRuns);
	const compactionCheckpoints = resolveProjectableCompactionCheckpoints(entry);
	const compactionCheckpointCount = Array.isArray(entry?.compactionCheckpoints) ? compactionCheckpoints.length : void 0;
	const latestCompactionCheckpoint = buildCompactionCheckpointPreview(resolveLatestCompactionCheckpoint(compactionCheckpoints));
	const selectedOrRuntimeModelProvider = selectedModel?.provider ?? modelProvider;
	const selectedOrRuntimeModel = selectedModel?.model ?? model;
	const rowModelIdentity = lightweight ? {
		provider: selectedOrRuntimeModelProvider,
		model: selectedOrRuntimeModel
	} : resolveSessionDisplayModelIdentityRefCached({
		cfg,
		agentId: sessionAgentId,
		provider: selectedOrRuntimeModelProvider,
		model: selectedOrRuntimeModel,
		rowContext: params.rowContext
	});
	const rowModelProvider = rowModelIdentity.provider;
	const rowModel = rowModelIdentity.model;
	const agentRuntime = resolveModelAgentRuntimeMetadata({
		cfg,
		agentId: sessionAgentId,
		provider: rowModelProvider,
		model: rowModel,
		sessionKey: key,
		acpRuntime: entry?.acp != null,
		acpBackend: entry?.acp?.backend
	});
	const estimatedCostUsd = lightweight ? resolveNonNegativeNumber(entry?.estimatedCostUsd) : resolveEstimatedSessionCostUsd({
		cfg,
		provider: rowModelProvider,
		model: rowModel,
		entry,
		rowContext: params.rowContext
	}) ?? resolveNonNegativeNumber(transcriptUsage?.estimatedCostUsd);
	const contextTokens = lightweight ? resolvePositiveNumber(entry?.contextTokens) : resolvePositiveNumber(entry?.contextTokens) ?? resolvePositiveNumber(transcriptUsage?.contextTokens) ?? resolvePositiveNumber(resolveContextTokensForModel({
		cfg,
		provider: rowModelProvider,
		model: rowModel,
		allowAsyncLoad: false
	}));
	let derivedTitle;
	let lastMessagePreview;
	if (entry?.sessionId && (params.includeDerivedTitles || params.includeLastMessage)) {
		const fields = readSessionTitleFieldsFromTranscript(entry.sessionId, storePath, entry.sessionFile, sessionAgentId);
		if (params.includeDerivedTitles) derivedTitle = deriveSessionTitle(entry, fields.firstUserMessage);
		if (params.includeLastMessage && fields.lastMessagePreview) lastMessagePreview = fields.lastMessagePreview;
	}
	const thinkingMetadata = resolveSessionRowThinkingMetadata({
		cfg,
		agentId: sessionAgentId,
		provider: rowModelProvider ?? "openai",
		model: rowModel ?? "gpt-5.5",
		modelCatalog: params.modelCatalog,
		rowContext
	});
	const thinkingLevels = thinkingMetadata.levels;
	const thinkingDefault = thinkingMetadata.defaultLevel;
	const pluginExtensions = !lightweight && entry ? projectPluginSessionExtensionsSync({
		sessionKey: key,
		entry
	}) : [];
	return {
		key,
		spawnedBy: subagentOwner || entry?.spawnedBy,
		spawnedWorkspaceDir: entry?.spawnedWorkspaceDir,
		forkedFromParent: entry?.forkedFromParent,
		spawnDepth: entry?.spawnDepth,
		subagentRole: entry?.subagentRole,
		subagentControlScope: entry?.subagentControlScope,
		kind: classifySessionKey(key, entry),
		label: entry?.label,
		displayName,
		derivedTitle,
		lastMessagePreview,
		channel,
		subject,
		groupChannel,
		space,
		chatType: entry?.chatType,
		origin,
		updatedAt,
		sessionId: entry?.sessionId,
		systemSent: entry?.systemSent,
		abortedLastRun: entry?.abortedLastRun,
		thinkingLevel: entry?.thinkingLevel,
		thinkingLevels,
		thinkingOptions: thinkingLevels.map((level) => level.label),
		thinkingDefault,
		fastMode: entry?.fastMode,
		verboseLevel: entry?.verboseLevel,
		traceLevel: entry?.traceLevel,
		reasoningLevel: entry?.reasoningLevel,
		elevatedLevel: entry?.elevatedLevel,
		sendPolicy: entry?.sendPolicy,
		inputTokens: entry?.inputTokens,
		outputTokens: entry?.outputTokens,
		totalTokens,
		totalTokensFresh,
		estimatedCostUsd,
		status: subagentRun ? subagentStatus : entry?.status,
		subagentRunState,
		hasActiveSubagentRun: subagentRun ? liveSubagentRunActive : void 0,
		startedAt: subagentRun ? subagentStartedAt : entry?.startedAt,
		endedAt: subagentRun ? subagentEndedAt : entry?.endedAt,
		runtimeMs: subagentRun ? subagentRuntimeMs : entry?.runtimeMs,
		parentSessionKey: subagentOwner || entry?.parentSessionKey,
		childSessions,
		responseUsage: entry?.responseUsage,
		modelProvider: rowModelProvider,
		model: rowModel,
		agentRuntime,
		contextTokens,
		deliveryContext: deliveryFields.deliveryContext,
		lastChannel: deliveryFields.lastChannel ?? entry?.lastChannel,
		lastTo: deliveryFields.lastTo ?? entry?.lastTo,
		lastAccountId: deliveryFields.lastAccountId ?? entry?.lastAccountId,
		lastThreadId: deliveryFields.lastThreadId ?? entry?.lastThreadId,
		compactionCheckpointCount,
		latestCompactionCheckpoint,
		pluginExtensions: pluginExtensions.length > 0 ? pluginExtensions : void 0
	};
}
function resolveSessionListSearchDisplayName(key, entry) {
	if (entry?.displayName) return entry.displayName;
	const parsed = parseGroupKey(key);
	const channel = entry?.channel ?? parsed?.channel;
	if (!channel) return;
	return buildGroupDisplayName({
		provider: channel,
		subject: entry?.subject,
		groupChannel: entry?.groupChannel,
		space: entry?.space,
		id: parsed?.id,
		key
	});
}
function addSessionListSearchModelFields(fields, identity) {
	const provider = normalizeOptionalString(identity.provider);
	const model = normalizeOptionalString(identity.model);
	fields.push(provider, model);
	if (provider && model) fields.push(`${provider}/${model}`);
}
function resolveSessionListSearchModelFields(params) {
	const agentId = normalizeAgentId(parseAgentSessionKey(params.key)?.agentId ?? resolveDefaultAgentId(params.cfg));
	const subagentRun = params.rowContext ? params.rowContext.subagentRuns.getDisplaySubagentRun(params.key) : getSessionDisplaySubagentRunByChildSessionKey(params.key);
	const selectedModel = resolveSessionSelectedModelRef({
		cfg: params.cfg,
		entry: params.entry,
		agentId,
		rowContext: params.rowContext,
		allowPluginNormalization: false
	});
	const resolvedModel = resolveSessionModelIdentityRef(params.cfg, params.entry, agentId, subagentRun?.model, { allowPluginNormalization: false });
	const modelIdentity = {
		provider: resolvedModel.provider,
		model: resolvedModel.model ?? "gpt-5.5"
	};
	const selectedOrRuntimeModelProvider = selectedModel?.provider ?? modelIdentity.provider;
	const selectedOrRuntimeModel = selectedModel?.model ?? modelIdentity.model;
	const displayModelIdentity = resolveSessionDisplayModelIdentityRefCached({
		cfg: params.cfg,
		agentId,
		provider: selectedOrRuntimeModelProvider,
		model: selectedOrRuntimeModel,
		rowContext: params.rowContext
	});
	const fields = [];
	addSessionListSearchModelFields(fields, {
		provider: params.entry?.modelProvider,
		model: params.entry?.model
	});
	addSessionListSearchModelFields(fields, resolvedModel);
	if (selectedModel) addSessionListSearchModelFields(fields, selectedModel);
	addSessionListSearchModelFields(fields, displayModelIdentity);
	return fields;
}
function loadGatewaySessionRow(sessionKey, options) {
	const { cfg, storePath, store, entry, canonicalKey } = loadSessionEntry(sessionKey);
	if (!entry) return null;
	return buildGatewaySessionRow({
		cfg,
		storePath,
		store,
		key: canonicalKey,
		entry,
		now: options?.now,
		includeDerivedTitles: options?.includeDerivedTitles,
		includeLastMessage: options?.includeLastMessage,
		transcriptUsageMaxBytes: options?.transcriptUsageMaxBytes
	});
}
/**
* Number of session rows to build per batch before yielding to the event loop.
* Keeps the main thread responsive during large session list operations while
* avoiding excessive yielding overhead for small stores.
*/
const SESSIONS_LIST_YIELD_BATCH_SIZE = 10;
const SESSIONS_LIST_TOP_N_LIMIT = 200;
const SESSIONS_LIST_DEFAULT_LIMIT = 100;
function compareSessionEntryPairsByUpdatedAt(a, b) {
	return (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0);
}
function resolveSessionsListLimit(opts, defaultLimit) {
	if (typeof opts.limit !== "number" || !Number.isFinite(opts.limit)) return defaultLimit;
	return Math.max(1, Math.floor(opts.limit));
}
function resolveSessionsListOffset(opts) {
	if (typeof opts.offset !== "number" || !Number.isFinite(opts.offset)) return 0;
	return Math.max(0, Math.floor(opts.offset));
}
function resolveSessionsListWindowLimit(limit, offset) {
	if (limit === void 0) return;
	const windowLimit = offset + limit;
	return Number.isFinite(windowLimit) ? Math.min(windowLimit, Number.MAX_SAFE_INTEGER) : void 0;
}
function selectNewestLimitedEntries(entries, limit) {
	const selected = [];
	for (const entry of entries) {
		const insertAt = selected.findIndex((candidate) => compareSessionEntryPairsByUpdatedAt(entry, candidate) < 0);
		if (insertAt >= 0) {
			selected.splice(insertAt, 0, entry);
			if (selected.length > limit) selected.pop();
		} else if (selected.length < limit) selected.push(entry);
	}
	return selected;
}
function sortAndLimitSessionEntries(entries, limit) {
	if (limit !== void 0 && limit <= SESSIONS_LIST_TOP_N_LIMIT) return selectNewestLimitedEntries(entries, limit);
	const sorted = entries.toSorted(compareSessionEntryPairsByUpdatedAt);
	return limit === void 0 ? sorted : sorted.slice(0, limit);
}
function filterSessionEntries(params) {
	const { cfg, store, opts, now } = params;
	const rowContext = params.rowContext;
	const includeGlobal = opts.includeGlobal === true;
	const includeUnknown = opts.includeUnknown === true;
	const spawnedBy = typeof opts.spawnedBy === "string" ? opts.spawnedBy : "";
	const label = normalizeOptionalString(opts.label) ?? "";
	const agentId = typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
	const search = normalizeLowercaseStringOrEmpty(opts.search);
	const activeMinutes = typeof opts.activeMinutes === "number" && Number.isFinite(opts.activeMinutes) ? Math.max(1, Math.floor(opts.activeMinutes)) : void 0;
	let entries = Object.entries(store).filter(([key]) => {
		if (isCronRunSessionKey(key)) return false;
		if (!includeGlobal && key === "global") return false;
		if (!includeUnknown && key === "unknown") return false;
		if (agentId) {
			if (key === "global" || key === "unknown") return false;
			const parsed = parseAgentSessionKey(key);
			if (!parsed) return false;
			return normalizeAgentId(parsed.agentId) === agentId;
		}
		return true;
	}).filter(([key, entry]) => {
		if (!spawnedBy) return true;
		if (key === "unknown" || key === "global") return false;
		const latest = rowContext ? rowContext.subagentRuns.getDisplaySubagentRun(key) : getSessionDisplaySubagentRunByChildSessionKey(key);
		if (latest) return (normalizeOptionalString(latest.controllerSessionKey) || normalizeOptionalString(latest.requesterSessionKey)) === spawnedBy && shouldKeepSubagentRunChildLink(latest, {
			activeDescendants: rowContext ? rowContext.subagentRuns.countActiveDescendantRuns(key) : countActiveDescendantRuns(key),
			now
		});
		return shouldKeepStoreOnlyChildLink(entry, now) && (entry?.spawnedBy === spawnedBy || entry?.parentSessionKey === spawnedBy);
	}).filter(([, entry]) => {
		if (!label) return true;
		return entry?.label === label;
	});
	if (search) entries = entries.filter(([key, entry]) => {
		return [
			resolveSessionListSearchDisplayName(key, entry),
			entry?.label,
			entry?.subject,
			entry?.sessionId,
			key,
			...resolveSessionListSearchModelFields({
				cfg,
				key,
				entry,
				rowContext
			})
		].some((f) => typeof f === "string" && normalizeLowercaseStringOrEmpty(f).includes(search));
	});
	if (activeMinutes !== void 0) {
		const cutoff = now - activeMinutes * 6e4;
		entries = entries.filter(([, entry]) => (entry?.updatedAt ?? 0) >= cutoff);
	}
	return entries;
}
function selectSessionEntries(params) {
	const filtered = filterSessionEntries(params);
	const limit = resolveSessionsListLimit(params.opts, params.defaultLimit);
	const offset = resolveSessionsListOffset(params.opts);
	const sortedWindow = sortAndLimitSessionEntries(filtered, resolveSessionsListWindowLimit(limit, offset));
	const entries = limit === void 0 ? sortedWindow.slice(offset) : sortedWindow.slice(offset, offset + limit);
	const nextOffset = offset + entries.length;
	const hasMore = nextOffset < filtered.length;
	return {
		entries,
		totalCount: filtered.length,
		limitApplied: limit,
		offset,
		nextOffset: hasMore ? nextOffset : null,
		hasMore
	};
}
function filterAndSortSessionEntries(params) {
	return selectSessionEntries(params).entries;
}
function listSessionsFromStore(params) {
	const { cfg, storePath, store, opts } = params;
	const now = Date.now();
	const sessionListTranscriptUsageMaxBytes = 64 * 1024;
	const sessionListTranscriptFieldRows = 100;
	let rowContext;
	const getRowContext = () => {
		rowContext ??= buildSessionListRowContext({
			store,
			now
		});
		return rowContext;
	};
	const includeDerivedTitles = opts.includeDerivedTitles === true;
	const includeLastMessage = opts.includeLastMessage === true;
	const { entries, totalCount, limitApplied, offset, nextOffset, hasMore } = selectSessionEntries({
		cfg,
		store,
		opts,
		now,
		rowContext: typeof opts.spawnedBy === "string" && opts.spawnedBy.length > 0 || Boolean(normalizeOptionalString(opts.search)) ? getRowContext() : void 0,
		defaultLimit: SESSIONS_LIST_DEFAULT_LIMIT
	});
	const sessions = entries.map(([key, entry], index) => {
		const includeTranscriptFields = index < sessionListTranscriptFieldRows;
		return buildGatewaySessionRow({
			cfg,
			storePath,
			store,
			key,
			entry,
			modelCatalog: params.modelCatalog,
			now,
			includeDerivedTitles: includeTranscriptFields && includeDerivedTitles,
			includeLastMessage: includeTranscriptFields && includeLastMessage,
			transcriptUsageMaxBytes: sessionListTranscriptUsageMaxBytes,
			storeChildSessionsByKey: getRowContext().storeChildSessionsByKey,
			rowContext: getRowContext()
		});
	});
	return {
		ts: now,
		path: storePath,
		count: sessions.length,
		totalCount,
		limitApplied,
		offset: offset > 0 ? offset : void 0,
		nextOffset,
		hasMore,
		defaults: getSessionDefaults(cfg, params.modelCatalog, { allowPluginNormalization: false }),
		sessions
	};
}
/**
* Async version of listSessionsFromStore that yields to the event loop between
* batches of session row builds. This prevents large session stores from
* blocking the event loop during sessions.list requests.
*
* The synchronous file I/O in readSessionTitleFieldsFromTranscript (head/tail
* reads for derived titles and last-message previews) is the dominant blocker.
* By yielding every SESSIONS_LIST_YIELD_BATCH_SIZE rows, we keep the event
* loop responsive for WebSocket heartbeats, channel I/O, and concurrent RPC.
*/
async function listSessionsFromStoreAsync(params) {
	const { cfg, storePath, store, opts } = params;
	const now = Date.now();
	const sessionListTranscriptUsageMaxBytes = 64 * 1024;
	const sessionListTranscriptFieldRows = 100;
	let rowContext;
	const getRowContext = () => {
		rowContext ??= buildSessionListRowContext({
			store,
			now
		});
		return rowContext;
	};
	const includeDerivedTitles = opts.includeDerivedTitles === true;
	const includeLastMessage = opts.includeLastMessage === true;
	const { entries, totalCount, limitApplied, offset, nextOffset, hasMore } = selectSessionEntries({
		cfg,
		store,
		opts,
		now,
		rowContext: typeof opts.spawnedBy === "string" && opts.spawnedBy.length > 0 || Boolean(normalizeOptionalString(opts.search)) ? getRowContext() : void 0,
		defaultLimit: SESSIONS_LIST_DEFAULT_LIMIT
	});
	const sessions = [];
	for (let i = 0; i < entries.length; i++) {
		const [key, entry] = entries[i];
		const includeTranscriptFields = i < sessionListTranscriptFieldRows;
		const row = buildGatewaySessionRow({
			cfg,
			storePath,
			store,
			key,
			entry,
			modelCatalog: params.modelCatalog,
			now,
			includeDerivedTitles: false,
			includeLastMessage: false,
			transcriptUsageMaxBytes: sessionListTranscriptUsageMaxBytes,
			storeChildSessionsByKey: getRowContext().storeChildSessionsByKey,
			rowContext: getRowContext(),
			skipTranscriptUsageFallback: true,
			lightweightListRow: true
		});
		if (entry?.sessionId && includeTranscriptFields && (includeDerivedTitles || includeLastMessage)) {
			const parsed = parseAgentSessionKey(key);
			const sessionAgentId = parsed?.agentId ? normalizeAgentId(parsed.agentId) : resolveDefaultAgentId(cfg);
			const fields = await readSessionTitleFieldsFromTranscriptAsync(entry.sessionId, storePath, entry.sessionFile, sessionAgentId);
			if (includeDerivedTitles) row.derivedTitle = deriveSessionTitle(entry, fields.firstUserMessage);
			if (includeLastMessage && fields.lastMessagePreview) row.lastMessagePreview = fields.lastMessagePreview;
		}
		sessions.push(row);
		if ((i + 1) % SESSIONS_LIST_YIELD_BATCH_SIZE === 0 && i + 1 < entries.length) await new Promise((resolve) => setImmediate(resolve));
	}
	return {
		ts: now,
		path: storePath,
		count: sessions.length,
		totalCount,
		limitApplied,
		offset: offset > 0 ? offset : void 0,
		nextOffset,
		hasMore,
		defaults: getSessionDefaults(cfg, params.modelCatalog, { allowPluginNormalization: false }),
		sessions
	};
}
//#endregion
export { resolveSessionModelIdentityRef as _, listSessionsFromStore as a, loadSessionEntry as c, resolveDeletedAgentIdFromSessionKey as d, resolveFreshestSessionEntryFromStoreKeys as f, resolveSessionDisplayModelIdentityRef as g, resolveGatewaySessionThinkingDefault as h, listAgentsForGateway as i, migrateAndPruneGatewaySessionStoreKey as l, resolveGatewaySessionStoreTarget as m, deriveSessionTitle as n, listSessionsFromStoreAsync as o, resolveGatewayModelSupportsImages as p, filterAndSortSessionEntries as r, loadGatewaySessionRow as s, buildGatewaySessionRow as t, pruneLegacyStoreKeys as u, resolveSessionModelRef as v };
