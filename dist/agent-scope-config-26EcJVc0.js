import { f as readStringValue } from "./string-coerce-LndEvhRk.js";
import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { p as resolveUserPath } from "./utils-CKsuXgDI.js";
import { c as normalizeAgentId, t as DEFAULT_AGENT_ID } from "./session-key-DFEyR49L.js";
import { n as resolveDefaultAgentWorkspaceDir } from "./workspace-default-Cg5lIU6L.js";
import path from "node:path";
//#region src/agents/agent-scope-config.ts
let defaultAgentWarned = false;
function warnMultipleDefaultAgents() {
	import("./subsystem-Cb901ds8.js").then(({ createSubsystemLogger }) => {
		createSubsystemLogger("agent-scope").warn("Multiple agents marked default=true; using the first entry as default.");
	}).catch(() => void 0);
}
/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s) {
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
	if (configured) return stripNullBytes(resolveUserPath(configured, env));
	const defaultAgentId = resolveDefaultAgentId(cfg);
	const fallback = cfg.agents?.defaults?.workspace?.trim();
	if (id === defaultAgentId) {
		if (fallback) return stripNullBytes(resolveUserPath(fallback, env));
		return stripNullBytes(resolveDefaultAgentWorkspaceDir(env));
	}
	if (fallback) return stripNullBytes(path.join(resolveUserPath(fallback, env), id));
	const stateDir = resolveStateDir(env);
	return stripNullBytes(path.join(stateDir, `workspace-${id}`));
}
function resolveAgentDir(cfg, agentId, env = process.env) {
	const id = normalizeAgentId(agentId);
	const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
	if (configured) return resolveUserPath(configured, env);
	const root = resolveStateDir(env);
	return path.join(root, "agents", id, "agent");
}
function resolveDefaultAgentDir(cfg, env = process.env) {
	return resolveAgentDir(cfg, resolveDefaultAgentId(cfg), env);
}
//#endregion
export { resolveAgentDir as a, resolveDefaultAgentId as c, resolveAgentContextLimits as i, listAgentIds as n, resolveAgentWorkspaceDir as o, resolveAgentConfig as r, resolveDefaultAgentDir as s, listAgentEntries as t };
