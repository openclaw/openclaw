import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { resolveSubagentRunDisposition } from "../subagent-terminal-outcome.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentSessionStartRecord = Pick<SubagentRunRecord, "sessionStartedAt"> & {
  execution: Pick<SubagentRunRecord["execution"], "startedAt">;
};
type SubagentSessionRuntimeRecord = Pick<SubagentRunRecord, "accumulatedRuntimeMs"> & {
  execution: Pick<SubagentRunRecord["execution"], "startedAt" | "endedAt">;
};
type SubagentSessionStatusRecord = Pick<
  SubagentRunRecord,
  "endedReason" | "waitExpiryObservedAt" | "pauseReason"
> & {
  delivery?: Pick<NonNullable<SubagentRunRecord["delivery"]>, "status" | "disposition">;
  execution: Pick<
    SubagentRunRecord["execution"],
    "status" | "endedAt" | "outcome" | "interruptionReason"
  >;
};

/** Returns a recorded execution start, never the earlier admission time. */
export function getSubagentSessionStartedAt(
  entry: SubagentSessionStartRecord | null | undefined,
): number | undefined {
  return asFiniteNumber(entry?.sessionStartedAt) ?? asFiniteNumber(entry?.execution.startedAt);
}

/** Computes accumulated runtime including the current live run when still active. */
export function getSubagentSessionRuntimeMs(
  entry: SubagentSessionRuntimeRecord | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!entry) {
    return undefined;
  }

  const accumulatedRuntimeMs = Math.max(0, asFiniteNumber(entry.accumulatedRuntimeMs) ?? 0);

  const startedAt = asFiniteNumber(entry.execution.startedAt);
  if (startedAt === undefined) {
    // Archived/recovered rows may only have an accumulated duration.
    return accumulatedRuntimeMs > 0 ? accumulatedRuntimeMs : undefined;
  }

  const currentRunEndedAt = asFiniteNumber(entry.execution.endedAt) ?? now;
  return Math.max(0, accumulatedRuntimeMs + Math.max(0, currentRunEndedAt - startedAt));
}

/**
 * True when a wait-expiry observation (or legacy provisional timeout outcome)
 * records only a deadline, without observed child stop.
 *
 * The single derivation of that predicate for the whole codebase: the registry's
 * `shouldDeferTerminalCleanupForUnconfirmedChild` delegates here, and so do the
 * read-side status projections below. It lives in this leaf module because the
 * display and liveness paths must be able to ask the question without importing
 * the cleanup layer.
 */
export function isSubagentChildStopUnconfirmed(
  entry: Pick<SubagentSessionStatusRecord, "execution" | "waitExpiryObservedAt"> | null | undefined,
): boolean {
  if (!entry) {
    return false;
  }
  // The observation is not terminal evidence and must stop matching after the
  // actual completion. Legacy provisional rows can already carry an endedAt.
  return (
    (typeof entry.waitExpiryObservedAt === "number" &&
      Number.isFinite(entry.waitExpiryObservedAt) &&
      entry.execution.endedAt === undefined) ||
    resolveSubagentRunDisposition(entry.execution.outcome) === "still-running"
  );
}

/** Maps persisted run outcome fields to the compact session status shown in tools/UI. */
export function resolveSubagentSessionStatus(
  entry: SubagentSessionStatusRecord | null | undefined,
): "queued" | "running" | "interrupted" | "killed" | "failed" | "timeout" | "done" | undefined {
  if (!entry) {
    return undefined;
  }
  if (!entry.execution.endedAt) {
    if (entry.execution.status === "interrupted") {
      return "interrupted";
    }
    return entry.execution.status === "queued" ? "queued" : "running";
  }
  if (entry.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    return "killed";
  }
  if (isSubagentChildStopUnconfirmed(entry)) {
    // `endedAt` on this row is the end of the PARENT'S WAIT, not of the child's
    // run. Reporting `timeout` here would file a possibly-live child under a
    // terminal death in every reader of this function — including the session
    // rows a parent consults before deciding whether to replace it. Report the
    // only thing that is known: the child has not been observed to stop.
    return "running";
  }
  const status = entry.execution.outcome?.status;
  if (status === "error" && entry.execution.interruptionReason === "gateway-restart") {
    const delivery = entry.delivery;
    return delivery &&
      delivery.disposition !== "intentional_non_delivery" &&
      (delivery.status === "failed" ||
        delivery.status === "suspended" ||
        delivery.status === "discarded")
      ? "failed"
      : "interrupted";
  }
  if (status === "error") {
    return "failed";
  }
  if (status === "timeout") {
    return "timeout";
  }
  return "done";
}

/** Formats the authoritative run status while preserving unfinished descendants. */
export function resolveSubagentDisplayStatus(
  entry: SubagentSessionStatusRecord,
  pendingDescendants = 0,
): string {
  // A bare `running` would hide that this row's wait already ended, so the
  // display form says both halves out loud. It is deliberately not the word
  // `timeout`: the tool output a parent reads must never contradict the
  // completion warning that told it the child may still be working.
  const status = isSubagentChildStopUnconfirmed(entry)
    ? "running (wait expired; child stop unconfirmed)"
    : (resolveSubagentSessionStatus(entry) ?? "done");
  const pending = Math.max(0, pendingDescendants);
  if (
    entry.pauseReason === "sessions_yield" &&
    status !== "killed" &&
    status !== "failed" &&
    status !== "timeout"
  ) {
    return pending > 0
      ? `waiting on ${pending} ${pending === 1 ? "child" : "children"}`
      : "waiting for external continuation";
  }
  if (pending > 0) {
    const childLabel = pending === 1 ? "child" : "children";
    const waiting = `waiting on ${pending} ${childLabel}`;
    // Pending descendants keep the row active without hiding a terminal failure,
    // and must not collapse an unconfirmed stop into a plain `active` either.
    return status === "running" || status === "done"
      ? `active (${waiting})`
      : `${status} (${waiting})`;
  }
  return status;
}
