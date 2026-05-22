import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, f as readStringValue, p as resolvePrimaryStringValue, r as lowercasePreservingWhitespace } from "./string-coerce-Bje8XVt9.js";
import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { p as resolveUserPath } from "./utils-CCskKJVV.js";
import { o as parseAgentSessionKey } from "./session-key-utils-Dnbck33i.js";
import { c as normalizeAgentId, t as DEFAULT_AGENT_ID, u as resolveAgentIdFromSessionKey } from "./session-key-CTLAw4n4.js";
import { n as resolveDefaultAgentWorkspaceDir } from "./workspace-default-D4pXK3zL.js";
import { t as resolveAgentModelFallbackValues } from "./model-input-qoijZF3K.js";
import { t as resolveEffectiveAgentSkillFilter } from "./agent-filter-z5x0B9XL.js";
import fs from "node:fs";
import path from "node:path";
//#region src/agents/agent-scope-config.ts
let defaultAgentWarned = false;
function warnMultipleDefaultAgents() {
	import("./subsystem-DxO_-M1k.js").then(({ createSubsystemLogger }) => {
		createSubsystemLogger("agent-scope").warn("Multiple agents marked default=true; using the first entry as default.");
	}).catch(() => void 0);
}
/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes$1(s) {
	return s.replaceAll("\0", "");
}
function listAgentEntries(cfg) {
	const list = cfg.agents?.list;
	if (!Array.isArray(list)) return [];
	return list.filter((entry) => entry !== null && typeof entry === "object");
}
function listAgentIds(cfg) {
	const agents = listAgentEntries(cfg);
	if (agents.length === 0) return [DEFAULT_AGENT_ID];
	const seen = /* @__PURE__ */ new Set();
	const ids = [];
	for (const entry of agents) {
		const id = normalizeAgentId(entry?.id);
		if (seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids.length > 0 ? ids : [DEFAULT_AGENT_ID];
}
function resolveDefaultAgentId(cfg) {
	const agents = listAgentEntries(cfg);
	if (agents.length === 0) return DEFAULT_AGENT_ID;
	const defaults = agents.filter((agent) => agent?.default);
	if (defaults.length > 1 && !defaultAgentWarned) {
		defaultAgentWarned = true;
		warnMultipleDefaultAgents();
	}
	const chosen = (defaults[0] ?? agents[0])?.id?.trim();
	return normalizeAgentId(chosen || "main");
}
function resolveAgentEntry(cfg, agentId) {
	const id = normalizeAgentId(agentId);
	return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}
function resolveAgentConfig(cfg, agentId) {
	const entry = resolveAgentEntry(cfg, normalizeAgentId(agentId));
	if (!entry) return;
	const agentDefaults = cfg.agents?.defaults;
	return {
		name: readStringValue(entry.name),
		workspace: readStringValue(entry.workspace),
		agentDir: readStringValue(entry.agentDir),
		systemPromptOverride: readStringValue(entry.systemPromptOverride),
		model: typeof entry.model === "string" || entry.model && typeof entry.model === "object" ? entry.model : void 0,
		thinkingDefault: entry.thinkingDefault,
		verboseDefault: entry.verboseDefault ?? agentDefaults?.verboseDefault,
		reasoningDefault: entry.reasoningDefault,
		fastModeDefault: entry.fastModeDefault,
		skills: Array.isArray(entry.skills) ? entry.skills : void 0,
		memorySearch: entry.memorySearch,
		humanDelay: entry.humanDelay,
		tts: entry.tts,
		contextLimits: typeof entry.contextLimits === "object" && entry.contextLimits ? {
			...agentDefaults?.contextLimits,
			...entry.contextLimits
		} : agentDefaults?.contextLimits,
		heartbeat: entry.heartbeat,
		identity: entry.identity,
		groupChat: entry.groupChat,
		subagents: typeof entry.subagents === "object" && entry.subagents ? entry.subagents : void 0,
		embeddedPi: typeof entry.embeddedPi === "object" && entry.embeddedPi ? entry.embeddedPi : void 0,
		sandbox: entry.sandbox,
		tools: entry.tools
	};
}
function resolveAgentContextLimits(cfg, agentId) {
	const defaults = cfg?.agents?.defaults?.contextLimits;
	if (!cfg || !agentId) return defaults;
	return resolveAgentConfig(cfg, agentId)?.contextLimits ?? defaults;
}
function resolveAgentWorkspaceDir(cfg, agentId, env = process.env) {
	const id = normalizeAgentId(agentId);
	const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
	if (configured) return stripNullBytes$1(resolveUserPath(configured, env));
	const defaultAgentId = resolveDefaultAgentId(cfg);
	const fallback = cfg.agents?.defaults?.workspace?.trim();
	if (id === defaultAgentId) {
		if (fallback) return stripNullBytes$1(resolveUserPath(fallback, env));
		return stripNullBytes$1(resolveDefaultAgentWorkspaceDir(env));
	}
	if (fallback) return stripNullBytes$1(path.join(resolveUserPath(fallback, env), id));
	const stateDir = resolveStateDir(env);
	return stripNullBytes$1(path.join(stateDir, `workspace-${id}`));
}
function resolveAgentDir(cfg, agentId, env = process.env) {
	const id = normalizeAgentId(agentId);
	const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
	if (configured) return resolveUserPath(configured, env);
	const root = resolveStateDir(env);
	return path.join(root, "agents", id, "agent");
}
//#endregion
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
function isPathWithinRoot(candidatePath, rootPath) {
	const relative = path.relative(rootPath, candidatePath);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function resolveAgentIdsByWorkspacePath(cfg, workspacePath) {
	const normalizedWorkspacePath = normalizePathForComparison(workspacePath);
	const ids = listAgentIds(cfg);
	const matches = [];
	for (let index = 0; index < ids.length; index += 1) {
		const id = ids[index];
		const workspaceDir = normalizePathForComparison(resolveAgentWorkspaceDir(cfg, id));
		if (!isPathWithinRoot(normalizedWorkspacePath, workspaceDir)) continue;
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
export { resolveDefaultAgentId as S, listAgentIds as _, resolveAgentIdByWorkspacePath as a, resolveAgentDir as b, resolveAgentModelPrimary as c, resolveFallbackAgentId as d, resolveRunModelFallbacksOverride as f, listAgentEntries as g, setAgentEffectiveModelPrimary as h, resolveAgentExplicitModelPrimary as i, resolveAgentSkillsFilter as l, resolveSessionAgentIds as m, resolveAgentEffectiveModelPrimary as n, resolveAgentIdsByWorkspacePath as o, resolveSessionAgentId as p, resolveAgentExecutionContract as r, resolveAgentModelFallbacksOverride as s, hasConfiguredModelFallbacks as t, resolveEffectiveModelFallbacks as u, resolveAgentConfig as v, resolveAgentWorkspaceDir as x, resolveAgentContextLimits as y };
