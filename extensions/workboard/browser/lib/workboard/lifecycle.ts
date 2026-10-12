import type { GatewaySessionRow } from "../../api/types.ts";
import { workboardHost } from "../../host.ts";
import { workboardCardSessionKey } from "./card-state.ts";
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
  const key = workboardHost().sessions.normalizeKey(sessionKey);
  if (resolution?.key === key) {
    return resolution.status === "resolved" ? resolution.session : null;
  }
  // A filtered roster proves exact positive matches, never provisional uniqueness.
  return (
    sessions.find((session) => workboardHost().sessions.normalizeKey(session.key) === key) ?? null
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
      resolution?.key ===
      workboardHost().sessions.normalizeKey(workboardCardSessionKey(card) ?? "");
    return {
      session: null,
      state:
        current && (resolution.status === "ambiguous" || resolution.status === "unavailable")
          ? resolution.status
          : "unknown",
    };
  }
  if (session.status === "queued") {
    return { session, state: "queued" };
  }
  if (
    session.status === "running" &&
    session.hasActiveRun === false &&
    typeof session.updatedAt === "number" &&
    !(Date.now() - session.updatedAt < 30 * 60 * 1000)
  ) {
    return { session, state: "stale" };
  }
  if (session.hasActiveRun === true || session.status === "running") {
    return { session, state: "running" };
  }
  if (
    session.abortedLastRun ||
    session.status === "failed" ||
    session.status === "killed" ||
    session.status === "timeout"
  ) {
    return { session, state: "failed" };
  }
  if (session.status === "done") {
    return { session, state: "succeeded" };
  }
  return { session, state: "idle" };
}
