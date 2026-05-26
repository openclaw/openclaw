import { r as normalizeOptionalString, t as normalizeLowercaseStringOrEmpty } from "./string-utils-xCz9RTVk.js";
import "./fs-utils-DdhuqF2m.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region packages/memory-host-sdk/src/host/config-utils.ts
const CANONICAL_ROOT_MEMORY_FILENAME = "MEMORY.md";
const DEFAULT_AGENT_ID = "main";
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;
const LEGACY_STATE_DIRNAMES = [".clawdbot"];
const NEW_STATE_DIRNAME = ".openclaw";
const DURATION_MULTIPLIERS = {
	ms: 1,
	s: 1e3,
	m: 6e4,
	h: 36e5,
	d: 864e5
};
function normalizeAgentId(value) {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return DEFAULT_AGENT_ID;
	const normalized = normalizeLowercaseStringOrEmpty(trimmed);
	if (VALID_ID_RE.test(trimmed)) return normalized;
	return normalized.replace(INVALID_CHARS_RE, "-").replace(LEADING_DASH_RE, "").replace(TRAILING_DASH_RE, "").slice(0, 64) || DEFAULT_AGENT_ID;
}
function normalizeHomeValue(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed || trimmed === "undefined" || trimmed === "null") return;
	return trimmed;
}
function resolveRawOsHomeDir(env, homedir) {
	return normalizeHomeValue(env.HOME) ?? normalizeHomeValue(env.USERPROFILE) ?? normalizeHomeValue(homedir());
}
function resolveRequiredHomeDir(env = process.env, homedir = os.homedir) {
	const explicitHome = normalizeHomeValue(env.OPENCLAW_HOME);
	const rawHome = explicitHome ? explicitHome.replace(/^~(?=$|[\\/])/, resolveRawOsHomeDir(env, homedir) ?? "") : resolveRawOsHomeDir(env, homedir);
	return rawHome ? path.resolve(rawHome) : path.resolve(process.cwd());
}
function resolveUserPath(input, env = process.env, homedir = os.homedir) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, resolveRequiredHomeDir(env, homedir)));
	return path.resolve(trimmed);
}
function legacyStateDirs(homedir) {
	return LEGACY_STATE_DIRNAMES.map((dir) => path.join(homedir(), dir));
}
function resolveStateDir(env = process.env, homedir = os.homedir) {
	const override = env.OPENCLAW_STATE_DIR?.trim();
	if (override) return resolveUserPath(override, env, homedir);
	const effectiveHome = () => resolveRequiredHomeDir(env, homedir);
	const nextDir = path.join(effectiveHome(), NEW_STATE_DIRNAME);
	if (env.OPENCLAW_TEST_FAST === "1" || fs.existsSync(nextDir)) return nextDir;
	return legacyStateDirs(effectiveHome).find((dir) => {
		try {
			return fs.existsSync(dir);
		} catch {
			return false;
		}
	}) ?? nextDir;
}
function resolveDefaultAgentWorkspaceDir(env = process.env) {
	const home = resolveRequiredHomeDir(env, os.homedir);
	const profile = env.OPENCLAW_PROFILE?.trim();
	if (profile && normalizeLowercaseStringOrEmpty(profile) !== "default") return path.join(home, ".openclaw", `workspace-${profile}`);
	return path.join(home, ".openclaw", "workspace");
}
function listAgentEntries(cfg) {
	return Array.isArray(cfg.agents?.list) ? cfg.agents.list.filter((entry) => Boolean(entry)) : [];
}
function resolveDefaultAgentId(cfg) {
	const agents = listAgentEntries(cfg);
	if (agents.length === 0) return DEFAULT_AGENT_ID;
	const chosen = (agents.find((agent) => agent.default) ?? agents[0])?.id;
	return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}
function resolveAgentConfig(cfg, agentId) {
	const id = normalizeAgentId(agentId);
	return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}
function stripNullBytes(value) {
	return value.replaceAll("\0", "");
}
function resolveAgentWorkspaceDir(cfg, agentId, env = process.env) {
	const id = normalizeAgentId(agentId);
	const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
	if (configured) return stripNullBytes(resolveUserPath(configured, env));
	const fallback = cfg.agents?.defaults?.workspace?.trim();
	if (id === resolveDefaultAgentId(cfg)) return stripNullBytes(fallback ? resolveUserPath(fallback, env) : resolveDefaultAgentWorkspaceDir(env));
	if (fallback) return stripNullBytes(path.join(resolveUserPath(fallback, env), id));
	return stripNullBytes(path.join(resolveStateDir(env), `workspace-${id}`));
}
function resolveAgentContextLimits(cfg, agentId) {
	const defaults = cfg?.agents?.defaults?.contextLimits;
	if (!cfg || !agentId) return defaults;
	return resolveAgentConfig(cfg, agentId)?.contextLimits ?? defaults;
}
function resolveMemorySearchConfig(cfg, agentId) {
	const defaults = cfg.agents?.defaults?.memorySearch;
	const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
	const enabled = overrides?.enabled ?? defaults?.enabled ?? true;
	if (!enabled) return null;
	const rawPaths = [...defaults?.extraPaths ?? [], ...overrides?.extraPaths ?? []].map((value) => value.trim()).filter(Boolean);
	return {
		enabled,
		extraPaths: Array.from(new Set(rawPaths))
	};
}
function parseDurationMs(raw, opts) {
	const trimmed = normalizeLowercaseStringOrEmpty(normalizeOptionalString(raw) ?? "");
	if (!trimmed) throw new Error("invalid duration (empty)");
	const single = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(trimmed);
	if (single) {
		const value = Number(single[1]);
		if (!Number.isFinite(value) || value < 0) throw new Error(`invalid duration: ${raw}`);
		const unit = single[2] ?? opts?.defaultUnit ?? "ms";
		return Math.round(value * (DURATION_MULTIPLIERS[unit] ?? 1));
	}
	let totalMs = 0;
	let consumed = 0;
	for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
		const [full, valueRaw, unitRaw] = match;
		const index = match.index ?? -1;
		if (!full || !valueRaw || !unitRaw || index !== consumed) throw new Error(`invalid duration: ${raw}`);
		const value = Number(valueRaw);
		const multiplier = DURATION_MULTIPLIERS[unitRaw];
		if (!Number.isFinite(value) || value < 0 || !multiplier) throw new Error(`invalid duration: ${raw}`);
		totalMs += value * multiplier;
		consumed += full.length;
	}
	if (consumed !== trimmed.length || consumed === 0) throw new Error(`invalid duration: ${raw}`);
	return Math.round(totalMs);
}
//#endregion
export { resolveAgentWorkspaceDir as a, resolveAgentContextLimits as i, normalizeAgentId as n, resolveMemorySearchConfig as o, parseDurationMs as r, resolveUserPath as s, CANONICAL_ROOT_MEMORY_FILENAME as t };
