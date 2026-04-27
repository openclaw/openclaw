import { normalizeText } from "../normalize-text.js";
function normalizeIdentityState(value) {
    if (value !== "pending" && value !== "resolved") {
        return undefined;
    }
    return value;
}
function normalizeIdentitySource(value) {
    if (value !== "ensure" && value !== "status" && value !== "event") {
        return undefined;
    }
    return value;
}
function normalizeIdentity(identity) {
    if (!identity) {
        return undefined;
    }
    const state = normalizeIdentityState(identity.state);
    const source = normalizeIdentitySource(identity.source);
    const acpxRecordId = normalizeText(identity.acpxRecordId);
    const acpxSessionId = normalizeText(identity.acpxSessionId);
    const agentSessionId = normalizeText(identity.agentSessionId);
    const lastUpdatedAt = typeof identity.lastUpdatedAt === "number" && Number.isFinite(identity.lastUpdatedAt)
        ? identity.lastUpdatedAt
        : undefined;
    const hasAnyId = Boolean(acpxRecordId || acpxSessionId || agentSessionId);
    if (!state && !source && !hasAnyId && lastUpdatedAt === undefined) {
        return undefined;
    }
    const resolved = Boolean(acpxSessionId || agentSessionId);
    const normalizedState = state ?? (resolved ? "resolved" : "pending");
    return {
        state: normalizedState,
        ...(acpxRecordId ? { acpxRecordId } : {}),
        ...(acpxSessionId ? { acpxSessionId } : {}),
        ...(agentSessionId ? { agentSessionId } : {}),
        source: source ?? "status",
        lastUpdatedAt: lastUpdatedAt ?? Date.now(),
    };
}
function readIdentityIdsFromHandle(handle) {
    return {
        acpxRecordId: normalizeText(handle.acpxRecordId),
        acpxSessionId: normalizeText(handle.backendSessionId),
        agentSessionId: normalizeText(handle.agentSessionId),
    };
}
function buildSessionIdentity(params) {
    const { acpxRecordId, acpxSessionId, agentSessionId } = params.ids;
    if (!acpxRecordId && !acpxSessionId && !agentSessionId) {
        return undefined;
    }
    return {
        state: params.state,
        ...(acpxRecordId ? { acpxRecordId } : {}),
        ...(acpxSessionId ? { acpxSessionId } : {}),
        ...(agentSessionId ? { agentSessionId } : {}),
        source: params.source,
        lastUpdatedAt: params.now,
    };
}
export function resolveSessionIdentityFromMeta(meta) {
    if (!meta) {
        return undefined;
    }
    return normalizeIdentity(meta.identity);
}
export function identityHasStableSessionId(identity) {
    return Boolean(identity?.acpxSessionId || identity?.agentSessionId);
}
export function resolveRuntimeResumeSessionId(identity) {
    if (!identity) {
        return undefined;
    }
    return normalizeText(identity.agentSessionId) ?? normalizeText(identity.acpxSessionId);
}
export function isSessionIdentityPending(identity) {
    if (!identity) {
        return true;
    }
    return identity.state === "pending";
}
export function identityEquals(left, right) {
    const a = normalizeIdentity(left);
    const b = normalizeIdentity(right);
    if (!a && !b) {
        return true;
    }
    if (!a || !b) {
        return false;
    }
    return (a.state === b.state &&
        a.acpxRecordId === b.acpxRecordId &&
        a.acpxSessionId === b.acpxSessionId &&
        a.agentSessionId === b.agentSessionId &&
        a.source === b.source);
}
export function mergeSessionIdentity(params) {
    const current = normalizeIdentity(params.current);
    const incoming = normalizeIdentity(params.incoming);
    if (!current) {
        if (!incoming) {
            return undefined;
        }
        return { ...incoming, lastUpdatedAt: params.now };
    }
    if (!incoming) {
        return current;
    }
    const currentResolved = current.state === "resolved";
    const incomingResolved = incoming.state === "resolved";
    const allowIncomingValue = !currentResolved || incomingResolved;
    const nextRecordId = allowIncomingValue && incoming.acpxRecordId ? incoming.acpxRecordId : current.acpxRecordId;
    const nextAcpxSessionId = allowIncomingValue && incoming.acpxSessionId ? incoming.acpxSessionId : current.acpxSessionId;
    const nextAgentSessionId = allowIncomingValue && incoming.agentSessionId
        ? incoming.agentSessionId
        : current.agentSessionId;
    const nextResolved = Boolean(nextAcpxSessionId || nextAgentSessionId);
    const nextState = nextResolved
        ? "resolved"
        : currentResolved
            ? "resolved"
            : incoming.state;
    const nextSource = allowIncomingValue ? incoming.source : current.source;
    const next = {
        state: nextState,
        ...(nextRecordId ? { acpxRecordId: nextRecordId } : {}),
        ...(nextAcpxSessionId ? { acpxSessionId: nextAcpxSessionId } : {}),
        ...(nextAgentSessionId ? { agentSessionId: nextAgentSessionId } : {}),
        source: nextSource,
        lastUpdatedAt: params.now,
    };
    return next;
}
export function createIdentityFromEnsure(params) {
    return buildSessionIdentity({
        ids: readIdentityIdsFromHandle(params.handle),
        state: "pending",
        source: "ensure",
        now: params.now,
    });
}
export function createIdentityFromHandleEvent(params) {
    const ids = readIdentityIdsFromHandle(params.handle);
    return buildSessionIdentity({
        ids,
        state: ids.agentSessionId ? "resolved" : "pending",
        source: "event",
        now: params.now,
    });
}
export function createIdentityFromStatus(params) {
    if (!params.status) {
        return undefined;
    }
    const details = params.status.details;
    const acpxRecordId = normalizeText(params.status.acpxRecordId) ??
        normalizeText(details?.acpxRecordId);
    const acpxSessionId = normalizeText(params.status.backendSessionId) ??
        normalizeText(details?.backendSessionId) ??
        normalizeText(details?.acpxSessionId);
    const agentSessionId = normalizeText(params.status.agentSessionId) ?? normalizeText(details?.agentSessionId);
    if (!acpxRecordId && !acpxSessionId && !agentSessionId) {
        return undefined;
    }
    const resolved = Boolean(acpxSessionId || agentSessionId);
    return {
        state: resolved ? "resolved" : "pending",
        ...(acpxRecordId ? { acpxRecordId } : {}),
        ...(acpxSessionId ? { acpxSessionId } : {}),
        ...(agentSessionId ? { agentSessionId } : {}),
        source: "status",
        lastUpdatedAt: params.now,
    };
}
export function resolveRuntimeHandleIdentifiersFromIdentity(identity) {
    if (!identity) {
        return {};
    }
    return {
        ...(identity.acpxSessionId ? { backendSessionId: identity.acpxSessionId } : {}),
        ...(identity.agentSessionId ? { agentSessionId: identity.agentSessionId } : {}),
    };
}
