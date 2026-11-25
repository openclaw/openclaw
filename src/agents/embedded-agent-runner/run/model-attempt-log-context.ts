import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type AttemptIdentity = Pick<
  EmbeddedRunAttemptParams,
  "sessionId" | "sessionKey" | "modelCallSequence"
> &
  Partial<Pick<EmbeddedRunAttemptParams, "runId">>;
type Recovery = EmbeddedRunAttemptResult["preflightRecovery"];

function sequence(attempt: AttemptIdentity): number {
  return Math.max(0, Math.floor(attempt.modelCallSequence?.value ?? 0));
}

/** Current dispatched call; before the first call this is also model:1. */
export function currentModelAttemptId(attempt: AttemptIdentity): string {
  return `${attempt.runId ?? "unknown"}:model:${Math.max(1, sequence(attempt))}`;
}

/** Next call that will be dispatched, matching attempt-stream's nextCallId. */
export function nextModelAttemptId(attempt: AttemptIdentity): string {
  return `${attempt.runId ?? "unknown"}:model:${sequence(attempt) + 1}`;
}

/** Initial preflight does not consume a call number; mid-turn/provider recovery does. */
export function recoveryModelAttemptId(attempt: AttemptIdentity, recovery?: Recovery): string {
  return recovery && recovery.source !== "mid-turn"
    ? nextModelAttemptId(attempt)
    : currentModelAttemptId(attempt);
}

export function retryModelAttemptId(attempt: AttemptIdentity, recovery?: Recovery): string {
  return recovery && recovery.source !== "mid-turn"
    ? recoveryModelAttemptId(attempt, recovery)
    : nextModelAttemptId(attempt);
}

export function modelAttemptLogContext(attempt: AttemptIdentity, recovery?: Recovery): string {
  return formatModelAttemptLogContext(attempt, recoveryModelAttemptId(attempt, recovery));
}

/** Provider admission happens before attempt-stream consumes the next sequence number. */
export function nextModelAttemptLogContext(attempt: AttemptIdentity): string {
  return formatModelAttemptLogContext(attempt, nextModelAttemptId(attempt));
}

function formatModelAttemptLogContext(attempt: AttemptIdentity, attemptId: string): string {
  const sessionId = attempt.sessionId ?? "unknown";
  return (
    `runId=${attempt.runId ?? "unknown"} sessionId=${sessionId} ` +
    `sessionKey=${attempt.sessionKey ?? sessionId} ` +
    `attemptId=${attemptId}`
  );
}

export function retryModelAttemptLogContext(attempt: AttemptIdentity, recovery?: Recovery): string {
  return `${modelAttemptLogContext(attempt, recovery)} retryAttemptId=${retryModelAttemptId(attempt, recovery)}`;
}
