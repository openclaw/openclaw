import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { isAcpSessionKey, isSubagentSessionKey, parseAgentSessionKey, } from "../routing/session-key.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { normalizeSubagentSessionKey } from "./subagent-session-key.js";
export const SUBAGENT_SESSION_ROLES = ["main", "orchestrator", "leaf"];
export const SUBAGENT_CONTROL_SCOPES = ["children", "none"];
function normalizeSubagentRole(value) {
    const trimmed = normalizeOptionalLowercaseString(value);
    return SUBAGENT_SESSION_ROLES.find((entry) => entry === trimmed);
}
function normalizeSubagentControlScope(value) {
    const trimmed = normalizeOptionalLowercaseString(value);
    return SUBAGENT_CONTROL_SCOPES.find((entry) => entry === trimmed);
}
function shouldInspectStoredSubagentEnvelope(sessionKey) {
    return isSubagentSessionKey(sessionKey) || isAcpSessionKey(sessionKey);
}
function isSameAgentSessionStore(leftSessionKey, rightSessionKey) {
    const leftAgentId = normalizeOptionalLowercaseString(parseAgentSessionKey(leftSessionKey)?.agentId);
    const rightAgentId = normalizeOptionalLowercaseString(parseAgentSessionKey(rightSessionKey)?.agentId);
    return Boolean(leftAgentId) && leftAgentId === rightAgentId;
}
function readSessionStore(storePath) {
    try {
        return loadSessionStore(storePath);
    }
    catch {
        return {};
    }
}
function findEntryBySessionId(store, sessionId) {
    const normalizedSessionId = normalizeSubagentSessionKey(sessionId);
    if (!normalizedSessionId) {
        return undefined;
    }
    for (const entry of Object.values(store)) {
        const candidateSessionId = normalizeSubagentSessionKey(entry?.sessionId);
        if (candidateSessionId === normalizedSessionId) {
            return entry;
        }
    }
    return undefined;
}
function resolveSessionCapabilityEntry(params) {
    if (params.store) {
        return params.store[params.sessionKey] ?? findEntryBySessionId(params.store, params.sessionKey);
    }
    if (!params.cfg) {
        return undefined;
    }
    const parsed = parseAgentSessionKey(params.sessionKey);
    if (!parsed?.agentId) {
        return undefined;
    }
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed.agentId });
    const store = readSessionStore(storePath);
    return store[params.sessionKey] ?? findEntryBySessionId(store, params.sessionKey);
}
export function resolveSubagentCapabilityStore(sessionKey, opts) {
    const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
    if (!normalizedSessionKey) {
        return opts?.store;
    }
    if (opts?.store) {
        return opts.store;
    }
    if (!opts?.cfg || !shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) {
        return undefined;
    }
    const parsed = parseAgentSessionKey(normalizedSessionKey);
    if (!parsed?.agentId) {
        return undefined;
    }
    const storePath = resolveStorePath(opts.cfg.session?.store, { agentId: parsed.agentId });
    return readSessionStore(storePath);
}
export function resolveSubagentRoleForDepth(params) {
    const depth = Number.isInteger(params.depth) ? Math.max(0, params.depth) : 0;
    const maxSpawnDepth = typeof params.maxSpawnDepth === "number" && Number.isFinite(params.maxSpawnDepth)
        ? Math.max(1, Math.floor(params.maxSpawnDepth))
        : DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
    if (depth <= 0) {
        return "main";
    }
    return depth < maxSpawnDepth ? "orchestrator" : "leaf";
}
export function resolveSubagentControlScopeForRole(role) {
    return role === "leaf" ? "none" : "children";
}
export function resolveSubagentCapabilities(params) {
    const role = resolveSubagentRoleForDepth(params);
    const controlScope = resolveSubagentControlScopeForRole(role);
    return {
        depth: Math.max(0, Math.floor(params.depth)),
        role,
        controlScope,
        canSpawn: role === "main" || role === "orchestrator",
        canControlChildren: controlScope === "children",
    };
}
function isStoredSubagentEnvelopeSession(params, visited = new Set()) {
    const normalizedSessionKey = normalizeSubagentSessionKey(params.sessionKey);
    if (!normalizedSessionKey || visited.has(normalizedSessionKey)) {
        return false;
    }
    visited.add(normalizedSessionKey);
    if (isSubagentSessionKey(normalizedSessionKey)) {
        return true;
    }
    if (!isAcpSessionKey(normalizedSessionKey)) {
        return false;
    }
    const entry = params.entry ??
        resolveSessionCapabilityEntry({
            sessionKey: normalizedSessionKey,
            cfg: params.cfg,
            store: params.store,
        });
    if (normalizeSubagentRole(entry?.subagentRole) ||
        normalizeSubagentControlScope(entry?.subagentControlScope)) {
        return true;
    }
    const spawnedBy = normalizeSubagentSessionKey(entry?.spawnedBy);
    if (!spawnedBy) {
        return false;
    }
    const parentStore = isSameAgentSessionStore(normalizedSessionKey, spawnedBy)
        ? params.store
        : undefined;
    return isStoredSubagentEnvelopeSession({
        sessionKey: spawnedBy,
        cfg: params.cfg,
        store: parentStore,
    }, visited);
}
export function isSubagentEnvelopeSession(sessionKey, opts) {
    const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
    if (!normalizedSessionKey) {
        return false;
    }
    if (isSubagentSessionKey(normalizedSessionKey)) {
        return true;
    }
    if (!isAcpSessionKey(normalizedSessionKey)) {
        return false;
    }
    const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
    return isStoredSubagentEnvelopeSession({
        sessionKey: normalizedSessionKey,
        cfg: opts?.cfg,
        store,
        entry: opts?.entry,
    });
}
export function resolveStoredSubagentCapabilities(sessionKey, opts) {
    const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
    const maxSpawnDepth = opts?.cfg?.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
    if (!normalizedSessionKey) {
        return resolveSubagentCapabilities({ depth: 0, maxSpawnDepth });
    }
    if (!shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) {
        const depth = getSubagentDepthFromSessionStore(normalizedSessionKey, {
            cfg: opts?.cfg,
            store: opts?.store,
        });
        return resolveSubagentCapabilities({ depth, maxSpawnDepth });
    }
    const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
    const entry = normalizedSessionKey
        ? resolveSessionCapabilityEntry({
            sessionKey: normalizedSessionKey,
            cfg: opts?.cfg,
            store,
        })
        : undefined;
    const depthStore = opts?.cfg && typeof entry?.spawnDepth !== "number" ? undefined : store;
    const depth = getSubagentDepthFromSessionStore(normalizedSessionKey, {
        cfg: opts?.cfg,
        store: depthStore,
    });
    if (!isSubagentEnvelopeSession(normalizedSessionKey, { ...opts, store, entry })) {
        return resolveSubagentCapabilities({ depth, maxSpawnDepth });
    }
    const storedRole = normalizeSubagentRole(entry?.subagentRole);
    const storedControlScope = normalizeSubagentControlScope(entry?.subagentControlScope);
    const fallback = resolveSubagentCapabilities({ depth, maxSpawnDepth });
    const role = storedRole ?? fallback.role;
    const controlScope = storedControlScope ?? resolveSubagentControlScopeForRole(role);
    return {
        depth,
        role,
        controlScope,
        canSpawn: role === "main" || role === "orchestrator",
        canControlChildren: controlScope === "children",
    };
}
