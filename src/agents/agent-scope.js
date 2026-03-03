import path from "node:path";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { DEFAULT_AGENT_ID, normalizeAgentId, parseAgentSessionKey, resolveAgentIdFromSessionKey, } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { normalizeSkillFilter } from "./skills/filter.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";
const log = createSubsystemLogger("agent-scope");
/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s) {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\0/g, "");
}
export { resolveAgentIdFromSessionKey };
let defaultAgentWarned = false;
export function listAgentEntries(cfg) {
    const list = cfg.agents?.list;
    if (!Array.isArray(list)) {
        return [];
    }
    return list.filter((entry) => Boolean(entry && typeof entry === "object"));
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
        log.warn("Multiple agents marked default=true; using the first entry as default.");
    }
    const chosen = (defaults[0] ?? agents[0])?.id?.trim();
    return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}
export function resolveSessionAgentIds(params) {
    const defaultAgentId = resolveDefaultAgentId(params.config ?? {});
    const explicitAgentIdRaw = typeof params.agentId === "string" ? params.agentId.trim().toLowerCase() : "";
    const explicitAgentId = explicitAgentIdRaw ? normalizeAgentId(explicitAgentIdRaw) : null;
    const sessionKey = params.sessionKey?.trim();
    const normalizedSessionKey = sessionKey ? sessionKey.toLowerCase() : undefined;
    const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
    const sessionAgentId = explicitAgentId ?? (parsed?.agentId ? normalizeAgentId(parsed.agentId) : defaultAgentId);
    return { defaultAgentId, sessionAgentId };
}
export function resolveSessionAgentId(params) {
    return resolveSessionAgentIds(params).sessionAgentId;
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
    return {
        name: typeof entry.name === "string" ? entry.name : undefined,
        workspace: typeof entry.workspace === "string" ? entry.workspace : undefined,
        agentDir: typeof entry.agentDir === "string" ? entry.agentDir : undefined,
        model: typeof entry.model === "string" || (entry.model && typeof entry.model === "object")
            ? entry.model
            : undefined,
        skills: Array.isArray(entry.skills) ? entry.skills : undefined,
        memorySearch: entry.memorySearch,
        humanDelay: entry.humanDelay,
        heartbeat: entry.heartbeat,
        identity: entry.identity,
        groupChat: entry.groupChat,
        subagents: typeof entry.subagents === "object" && entry.subagents ? entry.subagents : undefined,
        sandbox: entry.sandbox,
        tools: entry.tools,
    };
}
export function resolveAgentSkillsFilter(cfg, agentId) {
    return normalizeSkillFilter(resolveAgentConfig(cfg, agentId)?.skills);
}
function resolveModelPrimary(raw) {
    if (typeof raw === "string") {
        const trimmed = raw.trim();
        return trimmed || undefined;
    }
    if (!raw || typeof raw !== "object") {
        return undefined;
    }
    const primary = raw.primary;
    if (typeof primary !== "string") {
        return undefined;
    }
    const trimmed = primary.trim();
    return trimmed || undefined;
}
export function resolveAgentExplicitModelPrimary(cfg, agentId) {
    const raw = resolveAgentConfig(cfg, agentId)?.model;
    return resolveModelPrimary(raw);
}
export function resolveAgentEffectiveModelPrimary(cfg, agentId) {
    return (resolveAgentExplicitModelPrimary(cfg, agentId) ??
        resolveModelPrimary(cfg.agents?.defaults?.model));
}
// Backward-compatible alias. Prefer explicit/effective helpers at new call sites.
export function resolveAgentModelPrimary(cfg, agentId) {
    return resolveAgentExplicitModelPrimary(cfg, agentId);
}
export function resolveAgentModelFallbacksOverride(cfg, agentId) {
    const raw = resolveAgentConfig(cfg, agentId)?.model;
    if (!raw || typeof raw === "string") {
        return undefined;
    }
    // Important: treat an explicitly provided empty array as an override to disable global fallbacks.
    if (!Object.hasOwn(raw, "fallbacks")) {
        return undefined;
    }
    return Array.isArray(raw.fallbacks) ? raw.fallbacks : undefined;
}
export function resolveFallbackAgentId(params) {
    const explicitAgentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (explicitAgentId) {
        return normalizeAgentId(explicitAgentId);
    }
    return resolveAgentIdFromSessionKey(params.sessionKey);
}
export function resolveRunModelFallbacksOverride(params) {
    if (!params.cfg) {
        return undefined;
    }
    return resolveAgentModelFallbacksOverride(params.cfg, resolveFallbackAgentId({ agentId: params.agentId, sessionKey: params.sessionKey }));
}
export function hasConfiguredModelFallbacks(params) {
    const fallbacksOverride = resolveRunModelFallbacksOverride(params);
    const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);
    return (fallbacksOverride ?? defaultFallbacks).length > 0;
}
export function resolveEffectiveModelFallbacks(params) {
    const agentFallbacksOverride = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
    if (!params.hasSessionModelOverride) {
        return agentFallbacksOverride;
    }
    const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
    return agentFallbacksOverride ?? defaultFallbacks;
}
export function resolveAgentWorkspaceDir(cfg, agentId) {
    const id = normalizeAgentId(agentId);
    const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
    if (configured) {
        return stripNullBytes(resolveUserPath(configured));
    }
    const defaultAgentId = resolveDefaultAgentId(cfg);
    if (id === defaultAgentId) {
        const fallback = cfg.agents?.defaults?.workspace?.trim();
        if (fallback) {
            return stripNullBytes(resolveUserPath(fallback));
        }
        return stripNullBytes(resolveDefaultAgentWorkspaceDir(process.env));
    }
    const stateDir = resolveStateDir(process.env);
    return stripNullBytes(path.join(stateDir, `workspace-${id}`));
}
export function resolveAgentDir(cfg, agentId) {
    const id = normalizeAgentId(agentId);
    const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
    if (configured) {
        return resolveUserPath(configured);
    }
    const root = resolveStateDir(process.env);
    return path.join(root, "agents", id, "agent");
}
