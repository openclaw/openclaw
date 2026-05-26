import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, p as resolvePrimaryStringValue, r as lowercasePreservingWhitespace } from "./string-coerce-LndEvhRk.js";
import { i as isPathInside } from "./path-B5B-_oAT.js";
import { p as resolveUserPath } from "./utils-CKsuXgDI.js";
import { r as resolveAgentModelFallbackValues } from "./model-input-B9p-bobB.js";
import "./path-guards-DOGmBasP.js";
import { o as parseAgentSessionKey } from "./session-key-utils-qD-NZHCY.js";
import { c as normalizeAgentId, u as resolveAgentIdFromSessionKey } from "./session-key-DFEyR49L.js";
import { c as resolveDefaultAgentId, n as listAgentIds, o as resolveAgentWorkspaceDir, r as resolveAgentConfig } from "./agent-scope-config-26EcJVc0.js";
import { t as resolveEffectiveAgentSkillFilter } from "./agent-filter-DDYttCiF.js";
import fs from "node:fs";
import path from "node:path";
//#region src/agents/agent-scope.ts
/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s) {
	return s.replace(/\0/g, "");
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
	const raw = resolveAgentConfig(cfg, agentId)?.model;
	if (!raw) return;
	if (typeof raw === "string") return resolvePrimaryStringValue(raw) ? [] : void 0;
	if (!Object.hasOwn(raw, "fallbacks")) return Object.hasOwn(raw, "primary") && resolvePrimaryStringValue(raw) ? [] : void 0;
	return Array.isArray(raw.fallbacks) ? raw.fallbacks : void 0;
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
	if (params.modelOverrideSource !== "auto") return [];
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
export { resolveAgentIdByWorkspacePath as a, resolveAgentModelPrimary as c, resolveFallbackAgentId as d, resolveRunModelFallbacksOverride as f, setAgentEffectiveModelPrimary as h, resolveAgentExplicitModelPrimary as i, resolveAgentSkillsFilter as l, resolveSessionAgentIds as m, resolveAgentEffectiveModelPrimary as n, resolveAgentIdsByWorkspacePath as o, resolveSessionAgentId as p, resolveAgentExecutionContract as r, resolveAgentModelFallbacksOverride as s, hasConfiguredModelFallbacks as t, resolveEffectiveModelFallbacks as u };
