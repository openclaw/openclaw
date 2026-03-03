function normalizeText(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}
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
export function resolveSessionIdentityFromMeta(meta) {
    if (!meta) {
        return undefined;
    }
    return normalizeIdentity(meta.identity);
}
export function identityHasStableSessionId(identity) {
    return Boolean(identity?.acpxSessionId || identity?.agentSessionId);
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
    const acpxRecordId = normalizeText(params.handle.acpxRecordId);
    const acpxSessionId = normalizeText(params.handle.backendSessionId);
    const agentSessionId = normalizeText(params.handle.agentSessionId);
    if (!acpxRecordId && !acpxSessionId && !agentSessionId) {
        return undefined;
    }
    return {
        state: "pending",
        ...(acpxRecordId ? { acpxRecordId } : {}),
        ...(acpxSessionId ? { acpxSessionId } : {}),
        ...(agentSessionId ? { agentSessionId } : {}),
        source: "ensure",
        lastUpdatedAt: params.now,
    };
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
