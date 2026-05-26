import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, p as resolvePrimaryStringValue, r as lowercasePreservingWhitespace } from "./string-coerce-DyL154ka.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { r as resolveAgentModelFallbackValues } from "./model-input-ChW9XXsQ.js";
import "./path-guards-CBe_wA_B.js";
import { a as isSubagentSessionKey, c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { d as resolveAgentIdFromSessionKey, l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId, n as listAgentIds, o as resolveAgentWorkspaceDir, r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { t as resolveEffectiveAgentSkillFilter } from "./agent-filter-CZoQBzQY.js";
import fs from "node:fs";
import path from "node:path";
//#region src/config/sessions/model-override-provenance.ts
function hasSessionAutoModelFallbackProvenance(entry) {
	const hasActiveOverride = Boolean(normalizeOptionalString(entry?.providerOverride) || normalizeOptionalString(entry?.modelOverride));
	return Boolean(hasActiveOverride && normalizeOptionalString(entry?.modelOverrideFallbackOriginProvider) && normalizeOptionalString(entry?.modelOverrideFallbackOriginModel));
}
//#endregion
//#region src/agents/agent-scope.ts
/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s) {
	return s.replace(/\0/g, "");
}
const AUTO_FALLBACK_PRIMARY_PROBE_INTERVAL_MS = 300 * 1e3;
const AUTO_FALLBACK_PRIMARY_PROBE_MAX_KEYS = 4096;
const autoFallbackPrimaryProbeState = /* @__PURE__ */ new Map();
function autoFallbackPrimaryProbeStateKey(params) {
	return [normalizeOptionalString(params.sessionKey) ?? "", `${params.primaryProvider}/${params.primaryModel}`].join("\0");
}
function pruneAutoFallbackPrimaryProbeState(params) {
	const maxKeys = Math.max(1, Math.trunc(params.maxKeys ?? AUTO_FALLBACK_PRIMARY_PROBE_MAX_KEYS));
	const staleBefore = params.now - params.minIntervalMs;
	for (const [key, lastProbeAt] of params.state) if (!Number.isFinite(lastProbeAt) || lastProbeAt < staleBefore) params.state.delete(key);
	if (params.state.size <= maxKeys) return;
	const removeCount = params.state.size - maxKeys;
	let removed = 0;
	for (const key of params.state.keys()) {
		params.state.delete(key);
		removed += 1;
		if (removed >= removeCount) break;
	}
}
function resolveAutoFallbackPrimaryProbe(params) {
	const entry = params.entry;
	if (!entry) return;
	const recoveredAutoFallbackOverride = entry.modelOverrideSource === void 0 && hasSessionAutoModelFallbackProvenance(entry);
	if (entry.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) return;
	const originProvider = normalizeOptionalString(entry.modelOverrideFallbackOriginProvider);
	const originModel = normalizeOptionalString(entry.modelOverrideFallbackOriginModel);
	const overrideProvider = normalizeOptionalString(entry.providerOverride);
	const overrideModel = normalizeOptionalString(entry.modelOverride);
	const primaryProvider = normalizeOptionalString(params.primaryProvider);
	const primaryModel = normalizeOptionalString(params.primaryModel);
	if (!originProvider || !originModel || !overrideProvider || !overrideModel) return;
	if (!primaryProvider || !primaryModel) return;
	if (originProvider !== primaryProvider || originModel !== primaryModel) return;
	if (overrideProvider === originProvider && overrideModel === originModel) return;
	const now = params.now ?? Date.now();
	const minIntervalMs = params.minIntervalMs ?? AUTO_FALLBACK_PRIMARY_PROBE_INTERVAL_MS;
	const state = params.probeState ?? autoFallbackPrimaryProbeState;
	pruneAutoFallbackPrimaryProbeState({
		state,
		now,
		minIntervalMs,
		maxKeys: params.maxTrackedProbeKeys
	});
	const key = autoFallbackPrimaryProbeStateKey({
		sessionKey: params.sessionKey,
		primaryProvider: originProvider,
		primaryModel: originModel
	});
	const lastProbeAt = state.get(key);
	if (typeof lastProbeAt === "number" && Number.isFinite(lastProbeAt) && now - lastProbeAt < minIntervalMs) return;
	const fallbackAuthProfileId = normalizeOptionalString(entry.authProfileOverride);
	const fallbackAuthProfileIdSource = entry.authProfileOverrideSource ?? (entry.authProfileOverrideCompactionCount !== void 0 ? "auto" : void 0);
	return {
		provider: originProvider,
		model: originModel,
		fallbackProvider: overrideProvider,
		fallbackModel: overrideModel,
		...fallbackAuthProfileId ? {
			fallbackAuthProfileId,
			...fallbackAuthProfileIdSource ? { fallbackAuthProfileIdSource } : {}
		} : {}
	};
}
function markAutoFallbackPrimaryProbe(params) {
	const now = params.now ?? Date.now();
	const minIntervalMs = params.minIntervalMs ?? AUTO_FALLBACK_PRIMARY_PROBE_INTERVAL_MS;
	const state = params.probeState ?? autoFallbackPrimaryProbeState;
	pruneAutoFallbackPrimaryProbeState({
		state,
		now,
		minIntervalMs,
		maxKeys: params.maxTrackedProbeKeys
	});
	const key = autoFallbackPrimaryProbeStateKey({
		sessionKey: params.sessionKey,
		primaryProvider: params.probe.provider,
		primaryModel: params.probe.model
	});
	state.set(key, now);
	pruneAutoFallbackPrimaryProbeState({
		state,
		now,
		minIntervalMs,
		maxKeys: params.maxTrackedProbeKeys
	});
}
function entryMatchesAutoFallbackPrimaryProbe(entry, probe) {
	if (!entry) return false;
	const recoveredAutoFallbackOverride = entry.modelOverrideSource === void 0 && hasSessionAutoModelFallbackProvenance(entry);
	if (entry.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) return false;
	return normalizeOptionalString(entry.providerOverride) === probe.fallbackProvider && normalizeOptionalString(entry.modelOverride) === probe.fallbackModel && normalizeOptionalString(entry.modelOverrideFallbackOriginProvider) === probe.provider && normalizeOptionalString(entry.modelOverrideFallbackOriginModel) === probe.model;
}
function clearAutoFallbackPrimaryProbeSelection(entry, now = Date.now()) {
	delete entry.providerOverride;
	delete entry.modelOverride;
	delete entry.modelOverrideSource;
	delete entry.modelOverrideFallbackOriginProvider;
	delete entry.modelOverrideFallbackOriginModel;
	if (entry.authProfileOverrideSource === "auto" || entry.authProfileOverrideSource === void 0 && entry.authProfileOverrideCompactionCount !== void 0) {
		delete entry.authProfileOverride;
		delete entry.authProfileOverrideSource;
		delete entry.authProfileOverrideCompactionCount;
	}
	delete entry.fallbackNoticeSelectedModel;
	delete entry.fallbackNoticeActiveModel;
	delete entry.fallbackNoticeReason;
	entry.updatedAt = now;
}
function resolveSessionAgentIds(params) {
	const defaultAgentId = resolveDefaultAgentId(params.config ?? {});
	const explicitAgentIdRaw = normalizeLowercaseStringOrEmpty(params.agentId);
	const explicitAgentId = explicitAgentIdRaw ? normalizeAgentId(explicitAgentIdRaw) : null;
	const sessionKey = params.sessionKey?.trim();
	const normalizedSessionKey = sessionKey ? normalizeLowercaseStringOrEmpty(sessionKey) : void 0;
	const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
	return {
		defaultAgentId,
		sessionAgentId: explicitAgentId ?? (parsed?.agentId ? normalizeAgentId(parsed.agentId) : defaultAgentId)
	};
}
function resolveSessionAgentId(params) {
	return resolveSessionAgentIds(params).sessionAgentId;
}
function resolveAgentExecutionContract(cfg, agentId) {
	const defaultContract = cfg?.agents?.defaults?.embeddedPi?.executionContract;
	if (!cfg || !agentId) return defaultContract;
	return resolveAgentConfig(cfg, agentId)?.embeddedPi?.executionContract ?? defaultContract;
}
function resolveAgentSkillsFilter(cfg, agentId) {
	return resolveEffectiveAgentSkillFilter(cfg, agentId);
}
function resolveAgentExplicitModelPrimary(cfg, agentId) {
	const raw = resolveAgentConfig(cfg, agentId)?.model;
	return resolvePrimaryStringValue(raw);
}
function resolveAgentEffectiveModelPrimary(cfg, agentId) {
	return resolveAgentExplicitModelPrimary(cfg, agentId) ?? resolvePrimaryStringValue(cfg.agents?.defaults?.model);
}
function findMutableAgentEntry(cfg, agentId) {
	const id = normalizeAgentId(agentId);
	return cfg.agents?.list?.find((entry) => normalizeAgentId(entry?.id) === id);
}
function updateAgentModelPrimary(existing, primary) {
	if (existing && typeof existing === "object" && !Array.isArray(existing)) return {
		...existing,
		primary
	};
	return primary;
}
function setAgentEffectiveModelPrimary(cfg, agentId, primary) {
	const id = normalizeAgentId(agentId);
	if (resolveAgentExplicitModelPrimary(cfg, id)) {
		const entry = findMutableAgentEntry(cfg, id);
		if (entry) {
			entry.model = updateAgentModelPrimary(entry.model, primary);
			return "agent";
		}
	}
	cfg.agents ??= {};
	cfg.agents.defaults ??= {};
	cfg.agents.defaults.model = updateAgentModelPrimary(cfg.agents.defaults.model, primary);
	return "defaults";
}
/** @deprecated Prefer explicit/effective helpers at new call sites. */
function resolveAgentModelPrimary(cfg, agentId) {
	return resolveAgentExplicitModelPrimary(cfg, agentId);
}
function resolveAgentModelFallbacksOverride(cfg, agentId) {
	return resolveSelectedModelFallbacksOverride(resolveAgentConfig(cfg, agentId)?.model);
}
function resolveSelectedModelFallbacksOverride(raw) {
	if (!raw) return;
	if (typeof raw === "string") return resolvePrimaryStringValue(raw) ? [] : void 0;
	if (!Object.hasOwn(raw, "fallbacks")) return Object.hasOwn(raw, "primary") && resolvePrimaryStringValue(raw) ? [] : void 0;
	return Array.isArray(raw.fallbacks) ? raw.fallbacks : void 0;
}
function resolveFirstModelFallbacksOverride(candidates) {
	for (const candidate of candidates) {
		const fallbackOverride = resolveSelectedModelFallbacksOverride(candidate);
		if (fallbackOverride !== void 0) return fallbackOverride;
	}
}
function resolveSubagentModelConfigSelectionResult(params) {
	const agentConfig = params.agentConfigOverride ?? (params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : void 0);
	return [
		...agentConfig?.subagents?.model ? [{
			raw: agentConfig.subagents.model,
			source: "subagent"
		}] : [],
		...agentConfig?.model ? [{
			raw: agentConfig.model,
			source: "agent"
		}] : [],
		...params.cfg.agents?.defaults?.subagents?.model ? [{
			raw: params.cfg.agents.defaults.subagents.model,
			source: "default-subagent"
		}] : []
	].find((candidate) => resolvePrimaryStringValue(candidate.raw));
}
function resolveSubagentModelConfigSelection(params) {
	return resolveSubagentModelConfigSelectionResult(params)?.raw;
}
function resolveSubagentModelFallbacksOverride(cfg, agentId) {
	const agentConfig = resolveAgentConfig(cfg, agentId);
	const subagentFallbacks = resolveSelectedModelFallbacksOverride(agentConfig?.subagents?.model);
	if (subagentFallbacks !== void 0) return subagentFallbacks;
	const selection = resolveSubagentModelConfigSelectionResult({
		cfg,
		agentId
	});
	if (selection?.source === "agent") return resolveSelectedModelFallbacksOverride(agentConfig?.model);
	if (selection?.source === "default-subagent") return resolveSelectedModelFallbacksOverride(cfg.agents?.defaults?.subagents?.model);
}
function resolveSubagentSpawnModelFallbacksOverride(cfg, agentId) {
	const agentConfig = resolveAgentConfig(cfg, agentId);
	return resolveFirstModelFallbacksOverride([
		agentConfig?.subagents?.model,
		cfg.agents?.defaults?.subagents?.model,
		agentConfig?.model
	]);
}
function resolveFallbackAgentId(params) {
	const explicitAgentId = normalizeOptionalString(params.agentId) ?? "";
	if (explicitAgentId) return normalizeAgentId(explicitAgentId);
	return resolveAgentIdFromSessionKey(params.sessionKey);
}
function resolveRunModelFallbacksOverride(params) {
	if (!params.cfg) return;
	return resolveAgentModelFallbacksOverride(params.cfg, resolveFallbackAgentId({
		agentId: params.agentId,
		sessionKey: params.sessionKey
	}));
}
function hasConfiguredModelFallbacks(params) {
	const fallbacksOverride = resolveRunModelFallbacksOverride(params);
	const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);
	return (fallbacksOverride ?? defaultFallbacks).length > 0;
}
function resolveEffectiveModelFallbacks(params) {
	const agentFallbacksOverride = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
	if (!params.hasSessionModelOverride) return agentFallbacksOverride;
	if (!(params.modelOverrideSource === "auto" || params.modelOverrideSource === void 0 && params.hasAutoFallbackProvenance === true)) return [];
	const subagentFallbacksOverride = isSubagentSessionKey(params.sessionKey) ? resolveSubagentSpawnModelFallbacksOverride(params.cfg, params.agentId) : void 0;
	if (subagentFallbacksOverride !== void 0) return subagentFallbacksOverride;
	const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
	return agentFallbacksOverride ?? defaultFallbacks;
}
function normalizePathForComparison(input) {
	const resolved = path.resolve(stripNullBytes(resolveUserPath(input)));
	let normalized = resolved;
	try {
		normalized = fs.realpathSync.native(resolved);
	} catch {}
	if (process.platform === "win32") return lowercasePreservingWhitespace(normalized);
	return normalized;
}
function resolveAgentIdsByWorkspacePath(cfg, workspacePath) {
	const normalizedWorkspacePath = normalizePathForComparison(workspacePath);
	const ids = listAgentIds(cfg);
	const matches = [];
	for (let index = 0; index < ids.length; index += 1) {
		const id = ids[index];
		const workspaceDir = normalizePathForComparison(resolveAgentWorkspaceDir(cfg, id));
		if (!isPathInside(workspaceDir, normalizedWorkspacePath)) continue;
		matches.push({
			id,
			workspaceDir,
			order: index
		});
	}
	matches.sort((left, right) => {
		const workspaceLengthDelta = right.workspaceDir.length - left.workspaceDir.length;
		if (workspaceLengthDelta !== 0) return workspaceLengthDelta;
		return left.order - right.order;
	});
	return matches.map((entry) => entry.id);
}
function resolveAgentIdByWorkspacePath(cfg, workspacePath) {
	return resolveAgentIdsByWorkspacePath(cfg, workspacePath)[0];
}
//#endregion
export { hasSessionAutoModelFallbackProvenance as C, setAgentEffectiveModelPrimary as S, resolveSessionAgentId as _, resolveAgentEffectiveModelPrimary as a, resolveSubagentModelConfigSelectionResult as b, resolveAgentIdByWorkspacePath as c, resolveAgentModelPrimary as d, resolveAgentSkillsFilter as f, resolveRunModelFallbacksOverride as g, resolveFallbackAgentId as h, markAutoFallbackPrimaryProbe as i, resolveAgentIdsByWorkspacePath as l, resolveEffectiveModelFallbacks as m, entryMatchesAutoFallbackPrimaryProbe as n, resolveAgentExecutionContract as o, resolveAutoFallbackPrimaryProbe as p, hasConfiguredModelFallbacks as r, resolveAgentExplicitModelPrimary as s, clearAutoFallbackPrimaryProbeSelection as t, resolveAgentModelFallbacksOverride as u, resolveSessionAgentIds as v, resolveSubagentModelFallbacksOverride as x, resolveSubagentModelConfigSelection as y };
