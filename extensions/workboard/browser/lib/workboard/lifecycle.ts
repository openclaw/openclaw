import { asFiniteNumber } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GatewaySessionRow } from "../../api/types.ts";
import { normalizeSessionKeyForUiComparison } from "../sessions/session-key.ts";
import { isFailedSessionStatus, staleSessionState, workboardCardSessionKey } from "./card-state.ts";
import { isReservedSessionKey } from "./session-links.ts";
import type { WorkboardSessionResolution } from "./session-resolution.ts";
import type { WorkboardCard, WorkboardLifecycle } from "./types.ts";

export function findWorkboardSession(
  card: WorkboardCard,
  sessions: readonly GatewaySessionRow[],
  resolution?: WorkboardSessionResolution,
): GatewaySessionRow | null {
  const sessionKey = workboardCardSessionKey(card);
  if (!sessionKey || isReservedSessionKey(sessionKey)) {
    return null;
  }
  const key = normalizeSessionKeyForUiComparison(sessionKey);
  if (resolution?.key === key) {
    return resolution.status === "resolved" ? resolution.session : null;
  }
  // A filtered roster proves exact positive matches, never provisional uniqueness.
  return (
    sessions.find((session) => normalizeSessionKeyForUiComparison(session.key) === key) ?? null
  );
}

export function getWorkboardLifecycle(
  card: WorkboardCard,
  sessions: readonly GatewaySessionRow[],
  resolution?: WorkboardSessionResolution,
): WorkboardLifecycle {
  const session = findWorkboardSession(card, sessions, resolution);
  if (!workboardCardSessionKey(card)) {
    return { session: null, state: "unlinked" };
  }
  if (!session) {
    const current =
      resolution?.key === normalizeSessionKeyForUiComparison(workboardCardSessionKey(card) ?? "");
    return {
      session: null,
      state:
        current && (resolution.status === "ambiguous" || resolution.status === "unavailable")
          ? resolution.status
          : "unknown",
    };
  }
  if (session.status === "queued") {
    return {
      session,
      state: "queued",
      targetStatus: "todo",
      sourceUpdatedAt: asFiniteNumber(session.updatedAt),
    };
  }
  if (staleSessionState(session)) {
    return {
      session,
      state: "stale",
      targetStatus: "running",
      sourceUpdatedAt: asFiniteNumber(session.updatedAt),
    };
  }
  if (session.hasActiveRun === true || session.status === "running") {
    return {
      session,
      state: "running",
      targetStatus: "running",
      sourceUpdatedAt: asFiniteNumber(session.updatedAt),
    };
  }
  if (session.abortedLastRun || isFailedSessionStatus(session.status)) {
    return {
      session,
      state: "failed",
      targetStatus: "blocked",
      sourceUpdatedAt: asFiniteNumber(session.updatedAt),
    };
  }
  if (session.status === "done") {
    return {
      session,
      state: "succeeded",
      targetStatus: "review",
      sourceUpdatedAt: asFiniteNumber(session.updatedAt),
    };
  }
  return { session, state: "idle" };
}
