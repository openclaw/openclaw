import fs from "node:fs";
import path from "node:path";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { normalizeAgentId, parseAgentSessionKey, resolveAgentIdFromSessionKey, } from "../routing/session-key.js";
import { lowercasePreservingWhitespace, normalizeLowercaseStringOrEmpty, normalizeOptionalString, resolvePrimaryStringValue, } from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";
import { listAgentIds, resolveAgentConfig, resolveAgentWorkspaceDir, resolveDefaultAgentId, } from "./agent-scope-config.js";
import { resolveEffectiveAgentSkillFilter } from "./skills/agent-filter.js";
export { listAgentEntries, listAgentIds, resolveAgentConfig, resolveAgentContextLimits, resolveAgentDir, resolveAgentWorkspaceDir, resolveDefaultAgentId, } from "./agent-scope-config.js";
/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s) {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\0/g, "");
}
export { resolveAgentIdFromSessionKey };
export function resolveSessionAgentIds(params) {
    const defaultAgentId = resolveDefaultAgentId(params.config ?? {});
    const explicitAgentIdRaw = normalizeLowercaseStringOrEmpty(params.agentId);
    const explicitAgentId = explicitAgentIdRaw ? normalizeAgentId(explicitAgentIdRaw) : null;
    const sessionKey = params.sessionKey?.trim();
    const normalizedSessionKey = sessionKey ? normalizeLowercaseStringOrEmpty(sessionKey) : undefined;
    const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
    const sessionAgentId = explicitAgentId ?? (parsed?.agentId ? normalizeAgentId(parsed.agentId) : defaultAgentId);
    return { defaultAgentId, sessionAgentId };
}
export function resolveSessionAgentId(params) {
    return resolveSessionAgentIds(params).sessionAgentId;
}
export function resolveAgentExecutionContract(cfg, agentId) {
    const defaultContract = cfg?.agents?.defaults?.embeddedPi?.executionContract;
    if (!cfg || !agentId) {
        return defaultContract;
    }
    const agentContract = resolveAgentConfig(cfg, agentId)?.embeddedPi?.executionContract;
    return agentContract ?? defaultContract;
}
export function resolveAgentSkillsFilter(cfg, agentId) {
    return resolveEffectiveAgentSkillFilter(cfg, agentId);
}
export function resolveAgentExplicitModelPrimary(cfg, agentId) {
    const raw = resolveAgentConfig(cfg, agentId)?.model;
    return resolvePrimaryStringValue(raw);
}
export function resolveAgentEffectiveModelPrimary(cfg, agentId) {
    return (resolveAgentExplicitModelPrimary(cfg, agentId) ??
        resolvePrimaryStringValue(cfg.agents?.defaults?.model));
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
    const explicitAgentId = normalizeOptionalString(params.agentId) ?? "";
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
function normalizePathForComparison(input) {
    const resolved = path.resolve(stripNullBytes(resolveUserPath(input)));
    let normalized = resolved;
    // Prefer realpath when available to normalize aliases/symlinks (for example /tmp -> /private/tmp)
    // and canonical path case without forcing case-folding on case-sensitive macOS volumes.
    try {
        normalized = fs.realpathSync.native(resolved);
    }
    catch {
        // Keep lexical path for non-existent directories.
    }
    if (process.platform === "win32") {
        return lowercasePreservingWhitespace(normalized);
    }
    return normalized;
}
function isPathWithinRoot(candidatePath, rootPath) {
    const relative = path.relative(rootPath, candidatePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
export function resolveAgentIdsByWorkspacePath(cfg, workspacePath) {
    const normalizedWorkspacePath = normalizePathForComparison(workspacePath);
    const ids = listAgentIds(cfg);
    const matches = [];
    for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index];
        const workspaceDir = normalizePathForComparison(resolveAgentWorkspaceDir(cfg, id));
        if (!isPathWithinRoot(normalizedWorkspacePath, workspaceDir)) {
            continue;
        }
        matches.push({ id, workspaceDir, order: index });
    }
    matches.sort((left, right) => {
        const workspaceLengthDelta = right.workspaceDir.length - left.workspaceDir.length;
        if (workspaceLengthDelta !== 0) {
            return workspaceLengthDelta;
        }
        return left.order - right.order;
    });
    return matches.map((entry) => entry.id);
}
export function resolveAgentIdByWorkspacePath(cfg, workspacePath) {
    return resolveAgentIdsByWorkspacePath(cfg, workspacePath)[0];
}
