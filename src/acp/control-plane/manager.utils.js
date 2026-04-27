import { canonicalizeMainSessionAlias, resolveMainSessionKey, } from "../../config/sessions/main-session.js";
import { normalizeAgentId, normalizeMainKey, parseAgentSessionKey, } from "../../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { ACP_ERROR_CODES, AcpRuntimeError } from "../runtime/errors.js";
export function resolveAcpAgentFromSessionKey(sessionKey, fallback = "main") {
    const parsed = parseAgentSessionKey(sessionKey);
    return normalizeAgentId(parsed?.agentId ?? fallback);
}
export function resolveMissingMetaError(sessionKey) {
    return new AcpRuntimeError("ACP_SESSION_INIT_FAILED", `ACP metadata is missing for ${sessionKey}. Recreate this ACP session with /acp spawn and rebind the thread.`);
}
export function resolveAcpSessionResolutionError(resolution) {
    if (resolution.kind === "ready") {
        return null;
    }
    if (resolution.kind === "stale") {
        return resolution.error;
    }
    return new AcpRuntimeError("ACP_SESSION_INIT_FAILED", `Session is not ACP-enabled: ${resolution.sessionKey}`);
}
export function requireReadySessionMeta(resolution) {
    if (resolution.kind === "ready") {
        return resolution.meta;
    }
    throw resolveAcpSessionResolutionError(resolution);
}
export function normalizeSessionKey(sessionKey) {
    return sessionKey.trim();
}
export function canonicalizeAcpSessionKey(params) {
    const normalized = normalizeSessionKey(params.sessionKey);
    if (!normalized) {
        return "";
    }
    const lowered = normalizeLowercaseStringOrEmpty(normalized);
    if (lowered === "global" || lowered === "unknown") {
        return lowered;
    }
    const parsed = parseAgentSessionKey(lowered);
    if (parsed) {
        return canonicalizeMainSessionAlias({
            cfg: params.cfg,
            agentId: parsed.agentId,
            sessionKey: lowered,
        });
    }
    const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
    if (lowered === "main" || lowered === mainKey) {
        return resolveMainSessionKey(params.cfg);
    }
    return lowered;
}
export function normalizeActorKey(sessionKey) {
    return normalizeLowercaseStringOrEmpty(sessionKey);
}
export function normalizeAcpErrorCode(code) {
    if (!code) {
        return "ACP_TURN_FAILED";
    }
    const normalized = code.trim().toUpperCase();
    for (const allowed of ACP_ERROR_CODES) {
        if (allowed === normalized) {
            return allowed;
        }
    }
    return "ACP_TURN_FAILED";
}
export function createUnsupportedControlError(params) {
    return new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", `ACP backend "${params.backend}" does not support ${params.control}.`);
}
export function resolveRuntimeIdleTtlMs(cfg) {
    const ttlMinutes = cfg.acp?.runtime?.ttlMinutes;
    if (typeof ttlMinutes !== "number" || !Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
        return 0;
    }
    return Math.round(ttlMinutes * 60 * 1000);
}
export function hasLegacyAcpIdentityProjection(meta) {
    const raw = meta;
    return (Object.hasOwn(raw, "backendSessionId") ||
        Object.hasOwn(raw, "agentSessionId") ||
        Object.hasOwn(raw, "sessionIdsProvisional"));
}
