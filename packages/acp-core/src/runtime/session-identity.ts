import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString as normalizeText } from "@openclaw/normalization-core/string-coerce";
import type { SessionAcpIdentity, SessionAcpIdentitySource, SessionAcpMeta } from "../types.js";
import type { AcpRuntimeHandle, AcpRuntimeStatus } from "./types.js";

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

/** Resolve normalized ACP identity from persisted session metadata. */
export function resolveSessionIdentityFromMeta(
  meta: SessionAcpMeta | undefined,
): SessionAcpIdentity | undefined {
  return normalizeIdentity(meta?.identity);
}

/** Return true when an identity has a backend or agent session id. */
export function identityHasStableSessionId(identity: SessionAcpIdentity | undefined): boolean {
  return Boolean(identity?.acpxSessionId || identity?.agentSessionId);
}

/** Resolve the runtime resume id, preferring agent session id over ACP backend id. */
export function resolveRuntimeResumeSessionId(
  identity: SessionAcpIdentity | undefined,
): string | undefined {
  return normalizeText(identity?.agentSessionId) ?? normalizeText(identity?.acpxSessionId);
}

/** Return true when identity is absent or still pending. */
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
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.state === b.state &&
    a.acpxRecordId === b.acpxRecordId &&
    a.acpxSessionId === b.acpxSessionId &&
    a.agentSessionId === b.agentSessionId &&
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

  const nextResolved = Boolean(nextAcpxSessionId || nextAgentSessionId);
  const nextState = nextResolved || currentResolved ? "resolved" : incoming.state;
  const nextSource = allowIncomingValue ? incoming.source : current.source;
  return {
    state: nextState,
    ...(nextRecordId ? { acpxRecordId: nextRecordId } : {}),
    ...(nextAcpxSessionId ? { acpxSessionId: nextAcpxSessionId } : {}),
    ...(nextAgentSessionId ? { agentSessionId: nextAgentSessionId } : {}),
    source: nextSource,
    lastUpdatedAt: params.now,
  };
}

/** Create a pending identity from an ensure-session handle. */
export function createIdentityFromEnsure(params: {
  handle: AcpRuntimeHandle;
  now: number;
}): SessionAcpIdentity | undefined {
  return buildSessionIdentity({
    ids: readIdentityIdsFromHandle(params.handle),
    state: "pending",
    source: "ensure",
    now: params.now,
  });
}

/** Create an identity from a runtime event handle. */
export function createIdentityFromHandleEvent(params: {
  handle: AcpRuntimeHandle;
  now: number;
}): SessionAcpIdentity | undefined {
  const ids = readIdentityIdsFromHandle(params.handle);
  return buildSessionIdentity({
    ids,
    state: ids.agentSessionId ? "resolved" : "pending",
    source: "event",
    now: params.now,
  });
}

/** Create an identity from runtime status output. */
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

/** Convert ACP identity ids into runtime handle resume identifiers. */
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
