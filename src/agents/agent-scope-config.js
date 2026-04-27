import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { readStringValue } from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace-default.js";
let defaultAgentWarned = false;
function warnMultipleDefaultAgents() {
    void import("../logging/subsystem.js")
        .then(({ createSubsystemLogger }) => {
        createSubsystemLogger("agent-scope").warn("Multiple agents marked default=true; using the first entry as default.");
    })
        .catch(() => undefined);
}
/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s) {
    return s.replaceAll("\0", "");
}
export function listAgentEntries(cfg) {
    const list = cfg.agents?.list;
    if (!Array.isArray(list)) {
        return [];
    }
    return list.filter((entry) => entry !== null && typeof entry === "object");
}
export function listAgentIds(cfg) {
    const agents = listAgentEntries(cfg);
    if (agents.length === 0) {
        return [DEFAULT_AGENT_ID];
    }
    const seen = new Set();
    const ids = [];
    for (const entry of agents) {
        const id = normalizeAgentId(entry?.id);
        if (seen.has(id)) {
            continue;
        }
        seen.add(id);
        ids.push(id);
    }
    return ids.length > 0 ? ids : [DEFAULT_AGENT_ID];
}
export function resolveDefaultAgentId(cfg) {
    const agents = listAgentEntries(cfg);
    if (agents.length === 0) {
        return DEFAULT_AGENT_ID;
    }
    const defaults = agents.filter((agent) => agent?.default);
    if (defaults.length > 1 && !defaultAgentWarned) {
        defaultAgentWarned = true;
        warnMultipleDefaultAgents();
    }
    const chosen = (defaults[0] ?? agents[0])?.id?.trim();
    return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}
function resolveAgentEntry(cfg, agentId) {
    const id = normalizeAgentId(agentId);
    return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}
export function resolveAgentConfig(cfg, agentId) {
    const id = normalizeAgentId(agentId);
    const entry = resolveAgentEntry(cfg, id);
    if (!entry) {
        return undefined;
    }
    const agentDefaults = cfg.agents?.defaults;
    return {
        name: readStringValue(entry.name),
        workspace: readStringValue(entry.workspace),
        agentDir: readStringValue(entry.agentDir),
        systemPromptOverride: readStringValue(entry.systemPromptOverride),
        model: typeof entry.model === "string" || (entry.model && typeof entry.model === "object")
            ? entry.model
            : undefined,
        thinkingDefault: entry.thinkingDefault,
        verboseDefault: entry.verboseDefault ?? agentDefaults?.verboseDefault,
        reasoningDefault: entry.reasoningDefault,
        fastModeDefault: entry.fastModeDefault,
        skills: Array.isArray(entry.skills) ? entry.skills : undefined,
        memorySearch: entry.memorySearch,
        humanDelay: entry.humanDelay,
        contextLimits: typeof entry.contextLimits === "object" && entry.contextLimits
            ? { ...agentDefaults?.contextLimits, ...entry.contextLimits }
            : agentDefaults?.contextLimits,
        heartbeat: entry.heartbeat,
        identity: entry.identity,
        groupChat: entry.groupChat,
        subagents: typeof entry.subagents === "object" && entry.subagents ? entry.subagents : undefined,
        embeddedPi: typeof entry.embeddedPi === "object" && entry.embeddedPi ? entry.embeddedPi : undefined,
        sandbox: entry.sandbox,
        tools: entry.tools,
    };
}
export function resolveAgentContextLimits(cfg, agentId) {
    const defaults = cfg?.agents?.defaults?.contextLimits;
    if (!cfg || !agentId) {
        return defaults;
    }
    return resolveAgentConfig(cfg, agentId)?.contextLimits ?? defaults;
}
export function resolveAgentWorkspaceDir(cfg, agentId, env = process.env) {
    const id = normalizeAgentId(agentId);
    const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
    if (configured) {
        return stripNullBytes(resolveUserPath(configured, env));
    }
    const defaultAgentId = resolveDefaultAgentId(cfg);
    const fallback = cfg.agents?.defaults?.workspace?.trim();
    if (id === defaultAgentId) {
        if (fallback) {
            return stripNullBytes(resolveUserPath(fallback, env));
        }
        return stripNullBytes(resolveDefaultAgentWorkspaceDir(env));
    }
    if (fallback) {
        return stripNullBytes(path.join(resolveUserPath(fallback, env), id));
    }
    const stateDir = resolveStateDir(env);
    return stripNullBytes(path.join(stateDir, `workspace-${id}`));
}
export function resolveAgentDir(cfg, agentId, env = process.env) {
    const id = normalizeAgentId(agentId);
    const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
    if (configured) {
        return resolveUserPath(configured, env);
    }
    const root = resolveStateDir(env);
    return path.join(root, "agents", id, "agent");
}
