import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Recorded pause only; cancellation and continuation eligibility are separate decisions. */
export function isSubagentPausedByYield<T extends Pick<SubagentRunRecord, "pauseReason">>(
  entry: T | null | undefined,
): entry is T & { pauseReason: "sessions_yield" } {
  return entry?.pauseReason === "sessions_yield";
}

/** Exact spawning-turn binding, independent of whether this child owes a result. */
export function isSubagentBoundToRequesterTurn(
  entry: Pick<SubagentRunRecord, "requesterTurnRunId">,
  requesterTurnRunId: string,
): boolean {
  return entry.requesterTurnRunId === requesterTurnRunId;
}

/** A specified turn still owns this child's result; live custody is checked separately. */
export function isRequesterTurnAwaitingResult(
  entry: Pick<SubagentRunRecord, "requesterTurnRunId" | "expectsCompletionMessage">,
  requesterTurnRunId: string,
): boolean {
  return (
    isSubagentBoundToRequesterTurn(entry, requesterTurnRunId) &&
    entry.expectsCompletionMessage === true
  );
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
