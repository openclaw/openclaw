import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Recorded turn affinity; live custody and cancellation authority are separate decisions. */
export function hasRequesterTurn(
  entry: Pick<SubagentRunRecord, "requesterTurnRunId">,
  runId: string,
): boolean {
  return entry.requesterTurnRunId === runId;
}

/** Recorded pause only; cancellation and continuation eligibility are separate decisions. */
export function isSubagentPausedByYield<T extends Pick<SubagentRunRecord, "pauseReason">>(
  entry: T | null | undefined,
): entry is T & { pauseReason: "sessions_yield" } {
  return entry?.pauseReason === "sessions_yield";
}

/** Collectors can retain a turn binding without owing it a completion. */
export function hasPendingRequesterTurnResult(
  entry: Pick<SubagentRunRecord, "requesterTurnRunId" | "expectsCompletionMessage">,
): boolean {
  return Boolean(entry.requesterTurnRunId) && entry.expectsCompletionMessage === true;
}

/** The spawning turn recorded yield intent; its later wake has its own cohort identity. */
export function hasRequesterTurnYielded(
  entry: Pick<SubagentRunRecord, "requesterTurnYielded">,
): boolean {
  return entry.requesterTurnYielded === true;
}
