import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../glob-pattern.js";
import { expandToolGroups, normalizeToolName } from "../tool-policy.js";
import { DEFAULT_TOOL_ALLOW, DEFAULT_TOOL_DENY } from "./constants.js";
function buildSource(params) {
    return {
        source: params.scope,
        key: params.key,
    };
}
function pickConfiguredList(params) {
    if (Array.isArray(params.agent)) {
        return {
            values: params.agent,
            source: buildSource({ scope: "agent", key: "agents.list[].tools.sandbox.tools.allow" }),
        };
    }
    if (Array.isArray(params.global)) {
        return {
            values: params.global,
            source: buildSource({ scope: "global", key: "tools.sandbox.tools.allow" }),
        };
    }
    return {
        values: undefined,
        source: buildSource({ scope: "default", key: "tools.sandbox.tools.allow" }),
    };
}
function pickConfiguredDeny(params) {
    if (Array.isArray(params.agent)) {
        return {
            values: params.agent,
            source: buildSource({ scope: "agent", key: "agents.list[].tools.sandbox.tools.deny" }),
        };
    }
    if (Array.isArray(params.global)) {
        return {
            values: params.global,
            source: buildSource({ scope: "global", key: "tools.sandbox.tools.deny" }),
        };
    }
    return {
        values: undefined,
        source: buildSource({ scope: "default", key: "tools.sandbox.tools.deny" }),
    };
}
function pickConfiguredAlsoAllow(params) {
    if (Array.isArray(params.agent)) {
        return {
            values: params.agent,
            source: buildSource({
                scope: "agent",
                key: "agents.list[].tools.sandbox.tools.alsoAllow",
            }),
        };
    }
    if (Array.isArray(params.global)) {
        return {
            values: params.global,
            source: buildSource({ scope: "global", key: "tools.sandbox.tools.alsoAllow" }),
        };
    }
    return { values: undefined, source: undefined };
}
function mergeAllowlist(base, extra) {
    if (Array.isArray(base)) {
        // Preserve the existing sandbox meaning of `allow: []` => allow all.
        if (base.length === 0) {
            return [];
        }
        if (!Array.isArray(extra) || extra.length === 0) {
            return [...base];
        }
        return Array.from(new Set([...base, ...extra]));
    }
    if (Array.isArray(extra) && extra.length > 0) {
        return Array.from(new Set([...DEFAULT_TOOL_ALLOW, ...extra]));
    }
    return [...DEFAULT_TOOL_ALLOW];
}
function pickAllowSource(params) {
    if (params.allowDefined && params.allow.source === "agent") {
        return params.allow;
    }
    if (params.alsoAllow?.source === "agent") {
        return params.alsoAllow;
    }
    if (params.allowDefined && params.allow.source === "global") {
        return params.allow;
    }
    if (params.alsoAllow?.source === "global") {
        return params.alsoAllow;
    }
    return params.allow;
}
function resolveExplicitSandboxReAllowPatterns(params) {
    return Array.from(new Set([...(params.allow ?? []), ...(params.alsoAllow ?? [])]));
}
function filterDefaultDenyForExplicitAllows(params) {
    if (params.explicitAllowPatterns.length === 0) {
        return [...params.deny];
    }
    const allowPatterns = compileGlobPatterns({
        raw: expandToolGroups(params.explicitAllowPatterns),
        normalize: normalizeToolName,
    });
    if (allowPatterns.length === 0) {
        return [...params.deny];
    }
    return params.deny.filter((toolName) => !matchesAnyGlobPattern(normalizeToolName(toolName), allowPatterns));
}
function expandResolvedPolicy(policy) {
    const expandedDeny = expandToolGroups(policy.deny ?? []);
    let expandedAllow = expandToolGroups(policy.allow ?? []);
    const expandedDenyLower = expandedDeny.map(normalizeLowercaseStringOrEmpty);
    const expandedAllowLower = expandedAllow.map(normalizeLowercaseStringOrEmpty);
    // `image` is essential for multimodal workflows; keep the existing sandbox
    // behavior that auto-includes it for explicit allowlists unless it is denied.
    if (expandedAllow.length > 0 &&
        !expandedDenyLower.includes("image") &&
        !expandedAllowLower.includes("image")) {
        expandedAllow = [...expandedAllow, "image"];
    }
    return {
        allow: expandedAllow,
        deny: expandedDeny,
    };
}
export function classifyToolAgainstSandboxToolPolicy(name, policy) {
    if (!policy) {
        return {
            blockedByDeny: false,
            blockedByAllow: false,
        };
    }
    const normalized = normalizeToolName(name);
    const deny = compileGlobPatterns({
        raw: expandToolGroups(policy.deny ?? []),
        normalize: normalizeToolName,
    });
    const blockedByDeny = matchesAnyGlobPattern(normalized, deny);
    const allow = compileGlobPatterns({
        raw: expandToolGroups(policy.allow ?? []),
        normalize: normalizeToolName,
    });
    const blockedByAllow = !blockedByDeny && allow.length > 0 && !matchesAnyGlobPattern(normalized, allow);
    return {
        blockedByDeny,
        blockedByAllow,
    };
}
export function isToolAllowed(policy, name) {
    const { blockedByDeny, blockedByAllow } = classifyToolAgainstSandboxToolPolicy(name, policy);
    return !blockedByDeny && !blockedByAllow;
}
export function resolveSandboxToolPolicyForAgent(cfg, agentId) {
    const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : undefined;
    const agentPolicy = agentConfig?.tools?.sandbox?.tools;
    const globalPolicy = cfg?.tools?.sandbox?.tools;
    const allowConfig = pickConfiguredList({
        agent: agentPolicy?.allow,
        global: globalPolicy?.allow,
    });
    const alsoAllowConfig = pickConfiguredAlsoAllow({
        agent: agentPolicy?.alsoAllow,
        global: globalPolicy?.alsoAllow,
    });
    const denyConfig = pickConfiguredDeny({
        agent: agentPolicy?.deny,
        global: globalPolicy?.deny,
    });
    const explicitAllowPatterns = resolveExplicitSandboxReAllowPatterns({
        allow: allowConfig.values,
        alsoAllow: alsoAllowConfig.values,
    });
    const resolvedAllow = mergeAllowlist(allowConfig.values, alsoAllowConfig.values);
    const resolvedDeny = Array.isArray(denyConfig.values)
        ? [...denyConfig.values]
        : filterDefaultDenyForExplicitAllows({
            deny: [...DEFAULT_TOOL_DENY],
            explicitAllowPatterns,
        });
    const expanded = expandResolvedPolicy({
        allow: resolvedAllow,
        deny: resolvedDeny,
    });
    return {
        allow: expanded.allow ?? [],
        deny: expanded.deny ?? [],
        sources: {
            allow: pickAllowSource({
                allow: allowConfig.source,
                allowDefined: Array.isArray(allowConfig.values),
                alsoAllow: alsoAllowConfig.source,
            }),
            deny: denyConfig.source,
        },
    };
}
