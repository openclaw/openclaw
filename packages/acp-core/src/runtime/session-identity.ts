import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString as normalizeText } from "@openclaw/normalization-core/string-coerce";
import type { SessionAcpIdentity, SessionAcpIdentitySource, SessionAcpMeta } from "../types.js";
import type { AcpRuntimeHandle, AcpRuntimeSessionMode, AcpRuntimeStatus } from "./types.js";

/** Normalize an identity object and infer pending/resolved state from stable ids. */
function normalizeIdentity(
  identity: SessionAcpIdentity | undefined,
): SessionAcpIdentity | undefined {
  if (!identity) {
    return undefined;
  }
  const state =
    identity.state === "pending" || identity.state === "resolved" ? identity.state : undefined;
  const source =
    identity.source === "ensure" || identity.source === "status" || identity.source === "event"
      ? identity.source
      : undefined;
  const acpxRecordId = normalizeText(identity.acpxRecordId);
  const acpxSessionId = normalizeText(identity.acpxSessionId);
  const agentSessionId = normalizeText(identity.agentSessionId);
  const sessionResumeSupported =
    typeof identity.sessionResumeSupported === "boolean"
      ? identity.sessionResumeSupported
      : undefined;
  const sessionResumeReady =
    typeof identity.sessionResumeReady === "boolean" ? identity.sessionResumeReady : undefined;
  const lastUpdatedAt = asFiniteNumber(identity.lastUpdatedAt);
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
    ...(sessionResumeSupported !== undefined ? { sessionResumeSupported } : {}),
    ...(sessionResumeReady !== undefined ? { sessionResumeReady } : {}),
    source: source ?? "status",
    lastUpdatedAt: lastUpdatedAt ?? Date.now(),
  };
}

type IdentityIds = Pick<SessionAcpIdentity, "acpxRecordId" | "acpxSessionId" | "agentSessionId">;

function readIdentityIdsFromHandle(handle: AcpRuntimeHandle): IdentityIds {
  return {
    acpxRecordId: normalizeText(handle.acpxRecordId),
    acpxSessionId: normalizeText(handle.backendSessionId),
    agentSessionId: normalizeText(handle.agentSessionId),
  };
}

/** Build an identity only when at least one stable id is known. */
function buildSessionIdentity(params: {
  ids: IdentityIds;
  state: SessionAcpIdentity["state"];
  source: SessionAcpIdentitySource;
  now: number;
}): SessionAcpIdentity | undefined {
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

export function resolveSessionIdentityFromMeta(
  meta: SessionAcpMeta | undefined,
): SessionAcpIdentity | undefined {
  return normalizeIdentity(meta?.identity);
}

export function identityHasStableSessionId(identity: SessionAcpIdentity | undefined): boolean {
  return Boolean(identity?.acpxSessionId || identity?.agentSessionId);
}

/** Preserve persistent agent-ID precedence; one-shots prefer the ACP protocol ID. */
export function resolveRuntimeResumeSessionId(
  identity: SessionAcpIdentity | undefined,
  mode: AcpRuntimeSessionMode = "persistent",
): string | undefined {
  return mode === "oneshot"
    ? (normalizeText(identity?.acpxSessionId) ?? normalizeText(identity?.agentSessionId))
    : (normalizeText(identity?.agentSessionId) ?? normalizeText(identity?.acpxSessionId));
}

export function isSessionIdentityPending(identity: SessionAcpIdentity | undefined): boolean {
  return !identity || identity.state === "pending";
}

/** Compare identities ignoring lastUpdatedAt timestamp churn. */
export function identityEquals(
  left: SessionAcpIdentity | undefined,
  right: SessionAcpIdentity | undefined,
): boolean {
  const a = normalizeIdentity(left);
  const b = normalizeIdentity(right);
  if (!a || !b) {
    return a === b;
  }
  return (
    a.state === b.state &&
    a.acpxRecordId === b.acpxRecordId &&
    a.acpxSessionId === b.acpxSessionId &&
    a.agentSessionId === b.agentSessionId &&
    a.sessionResumeSupported === b.sessionResumeSupported &&
    a.sessionResumeReady === b.sessionResumeReady &&
    a.source === b.source
  );
}

/** Merge current and incoming identity observations without downgrading resolved ids. */
export function mergeSessionIdentity(params: {
  current: SessionAcpIdentity | undefined;
  incoming: SessionAcpIdentity | undefined;
  now: number;
}): SessionAcpIdentity | undefined {
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
  const nextRecordId =
    allowIncomingValue && incoming.acpxRecordId ? incoming.acpxRecordId : current.acpxRecordId;
  const nextAcpxSessionId =
    allowIncomingValue && incoming.acpxSessionId ? incoming.acpxSessionId : current.acpxSessionId;
  const nextAgentSessionId =
    allowIncomingValue && incoming.agentSessionId
      ? incoming.agentSessionId
      : current.agentSessionId;
  const nextSessionResumeSupported =
    incoming.sessionResumeSupported ?? current.sessionResumeSupported;
  const nextSessionResumeReady = incoming.sessionResumeReady ?? current.sessionResumeReady;

  const nextResolved = Boolean(nextAcpxSessionId || nextAgentSessionId);
  const nextState = nextResolved || currentResolved ? "resolved" : incoming.state;
  const nextSource = allowIncomingValue ? incoming.source : current.source;
  return {
    state: nextState,
    ...(nextRecordId ? { acpxRecordId: nextRecordId } : {}),
    ...(nextAcpxSessionId ? { acpxSessionId: nextAcpxSessionId } : {}),
    ...(nextAgentSessionId ? { agentSessionId: nextAgentSessionId } : {}),
    ...(nextSessionResumeSupported !== undefined
      ? { sessionResumeSupported: nextSessionResumeSupported }
      : {}),
    ...(nextSessionResumeReady !== undefined ? { sessionResumeReady: nextSessionResumeReady } : {}),
    source: nextSource,
    lastUpdatedAt: params.now,
  };
}

/** Create a pending identity from an ensure-session handle. */
export function createIdentityFromEnsure(params: {
  handle: AcpRuntimeHandle;
  now: number;
}): SessionAcpIdentity | undefined {
  const identity = buildSessionIdentity({
    ids: readIdentityIdsFromHandle(params.handle),
    state: "pending",
    source: "ensure",
    now: params.now,
  });
  if (params.handle.sessionResumeSupported === undefined) {
    return identity;
  }
  return {
    state: "pending",
    source: "ensure",
    lastUpdatedAt: params.now,
    ...identity,
    sessionResumeSupported: params.handle.sessionResumeSupported,
  };
}

export function createIdentityFromHandleEvent(params: {
  handle: AcpRuntimeHandle;
  now: number;
}): SessionAcpIdentity | undefined {
  const ids = readIdentityIdsFromHandle(params.handle);
  const identity = buildSessionIdentity({
    ids,
    state: ids.agentSessionId ? "resolved" : "pending",
    source: "event",
    now: params.now,
  });
  return identity && params.handle.sessionResumeSupported !== undefined
    ? { ...identity, sessionResumeSupported: params.handle.sessionResumeSupported }
    : identity;
}

export function createIdentityFromStatus(params: {
  status: AcpRuntimeStatus | undefined;
  now: number;
}): SessionAcpIdentity | undefined {
  if (!params.status) {
    return undefined;
  }
  const details = params.status.details;
  const acpxRecordId =
    normalizeText(params.status.acpxRecordId) ?? normalizeText(details?.acpxRecordId);
  const acpxSessionId =
    normalizeText(params.status.backendSessionId) ??
    normalizeText(details?.backendSessionId) ??
    normalizeText(details?.acpxSessionId);
  const agentSessionId =
    normalizeText(params.status.agentSessionId) ?? normalizeText(details?.agentSessionId);
  return buildSessionIdentity({
    ids: { acpxRecordId, acpxSessionId, agentSessionId },
    state: acpxSessionId || agentSessionId ? "resolved" : "pending",
    source: "status",
    now: params.now,
  });
}

export function resolveRuntimeHandleIdentifiersFromIdentity(
  identity: SessionAcpIdentity | undefined,
): { backendSessionId?: string; agentSessionId?: string } {
  if (!identity) {
    return {};
  }
  return {
    ...(identity.acpxSessionId ? { backendSessionId: identity.acpxSessionId } : {}),
    ...(identity.agentSessionId ? { agentSessionId: identity.agentSessionId } : {}),
  };
}
