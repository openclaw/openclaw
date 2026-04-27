import { DEFAULT_HEARTBEAT_EVERY, resolveHeartbeatPrompt as resolveHeartbeatPromptText, } from "../auto-reply/heartbeat.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { listAgentEntries, resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope.js";
function resolveHeartbeatConfigForSystemPrompt(config, agentId) {
    const defaults = config?.agents?.defaults?.heartbeat;
    if (!config || !agentId) {
        return defaults;
    }
    const overrides = resolveAgentConfig(config, agentId)?.heartbeat;
    if (!defaults && !overrides) {
        return overrides;
    }
    return { ...defaults, ...overrides };
}
function isHeartbeatEnabledByAgentPolicy(config, agentId) {
    const resolvedAgentId = normalizeAgentId(agentId);
    const agents = listAgentEntries(config);
    const hasExplicitHeartbeatAgents = agents.some((entry) => Boolean(entry?.heartbeat));
    if (hasExplicitHeartbeatAgents) {
        return agents.some((entry) => Boolean(entry?.heartbeat) && normalizeAgentId(entry.id) === resolvedAgentId);
    }
    return resolvedAgentId === resolveDefaultAgentId(config);
}
function isHeartbeatCadenceEnabled(heartbeat) {
    const rawEvery = heartbeat?.every ?? DEFAULT_HEARTBEAT_EVERY;
    const trimmedEvery = normalizeOptionalString(rawEvery) ?? "";
    if (!trimmedEvery) {
        return false;
    }
    try {
        return parseDurationMs(trimmedEvery, { defaultUnit: "m" }) > 0;
    }
    catch {
        return false;
    }
}
export function shouldIncludeHeartbeatGuidanceForSystemPrompt(params) {
    const defaultAgentId = params.defaultAgentId ?? resolveDefaultAgentId(params.config ?? {});
    const agentId = params.agentId ?? defaultAgentId;
    if (!agentId || normalizeAgentId(agentId) !== normalizeAgentId(defaultAgentId)) {
        return false;
    }
    if (params.config && !isHeartbeatEnabledByAgentPolicy(params.config, agentId)) {
        return false;
    }
    const heartbeat = resolveHeartbeatConfigForSystemPrompt(params.config, agentId);
    if (heartbeat?.includeSystemPromptSection === false) {
        return false;
    }
    return isHeartbeatCadenceEnabled(heartbeat);
}
export function resolveHeartbeatPromptForSystemPrompt(params) {
    const agentId = params.agentId ?? params.defaultAgentId ?? resolveDefaultAgentId(params.config ?? {});
    const heartbeat = resolveHeartbeatConfigForSystemPrompt(params.config, agentId);
    if (!shouldIncludeHeartbeatGuidanceForSystemPrompt(params)) {
        return undefined;
    }
    return resolveHeartbeatPromptText(heartbeat?.prompt);
}
