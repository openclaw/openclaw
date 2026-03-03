import { normalizeAgentId } from "../routing/session-key.js";
import { AcpRuntimeError } from "./runtime/errors.js";
const ACP_DISABLED_MESSAGE = "ACP is disabled by policy (`acp.enabled=false`).";
const ACP_DISPATCH_DISABLED_MESSAGE = "ACP dispatch is disabled by policy (`acp.dispatch.enabled=false`).";
export function isAcpEnabledByPolicy(cfg) {
    return cfg.acp?.enabled !== false;
}
export function resolveAcpDispatchPolicyState(cfg) {
    if (!isAcpEnabledByPolicy(cfg)) {
        return "acp_disabled";
    }
    if (cfg.acp?.dispatch?.enabled !== true) {
        return "dispatch_disabled";
    }
    return "enabled";
}
export function isAcpDispatchEnabledByPolicy(cfg) {
    return resolveAcpDispatchPolicyState(cfg) === "enabled";
}
export function resolveAcpDispatchPolicyMessage(cfg) {
    const state = resolveAcpDispatchPolicyState(cfg);
    if (state === "acp_disabled") {
        return ACP_DISABLED_MESSAGE;
    }
    if (state === "dispatch_disabled") {
        return ACP_DISPATCH_DISABLED_MESSAGE;
    }
    return null;
}
export function resolveAcpDispatchPolicyError(cfg) {
    const message = resolveAcpDispatchPolicyMessage(cfg);
    if (!message) {
        return null;
    }
    return new AcpRuntimeError("ACP_DISPATCH_DISABLED", message);
}
export function isAcpAgentAllowedByPolicy(cfg, agentId) {
    const allowed = (cfg.acp?.allowedAgents ?? [])
        .map((entry) => normalizeAgentId(entry))
        .filter(Boolean);
    if (allowed.length === 0) {
        return true;
    }
    return allowed.includes(normalizeAgentId(agentId));
}
export function resolveAcpAgentPolicyError(cfg, agentId) {
    if (isAcpAgentAllowedByPolicy(cfg, agentId)) {
        return null;
    }
    return new AcpRuntimeError("ACP_SESSION_INIT_FAILED", `ACP agent "${normalizeAgentId(agentId)}" is not allowed by policy.`);
}
