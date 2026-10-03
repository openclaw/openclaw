import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentSessionStartRecord = Pick<SubagentRunRecord, "sessionStartedAt"> & {
  execution: Pick<SubagentRunRecord["execution"], "startedAt">;
};
type SubagentSessionRuntimeRecord = Pick<SubagentRunRecord, "accumulatedRuntimeMs"> & {
  execution: Pick<SubagentRunRecord["execution"], "startedAt" | "endedAt">;
};
type SubagentSessionStatusRecord = Pick<SubagentRunRecord, "endedReason" | "pauseReason"> & {
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
  const status = resolveSubagentSessionStatus(entry) ?? "done";
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
    // Pending descendants keep the row active without hiding a terminal failure.
    return status === "running" || status === "done"
      ? `active (${waiting})`
      : `${status} (${waiting})`;
  }
  return status;
}
