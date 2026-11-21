import {
  collectErrorGraphCandidates,
  readErrorCauses,
} from "@openclaw/normalization-core/error-coercion";
import { hasOutboundDeliveryEvidence, type AgentDeliveryEvidence } from "./delivery-evidence.js";
import { observeReplayMetadata, type EmbeddedRunReplayState } from "./replay-state.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

export function isEmbeddedRunReplaySafe(
  previous: EmbeddedRunReplayState,
  attempt: AgentDeliveryEvidence &
    Partial<Pick<EmbeddedRunAttemptResult, "replayMetadata" | "clientToolCalls">>,
): boolean {
  const replay = observeReplayMetadata(previous, attempt.replayMetadata);
  return (
    !replay.replayInvalid &&
    !replay.hadPotentialSideEffects &&
    !attempt.didSendDeterministicApprovalPrompt &&
    !attempt.clientToolCalls?.length &&
    !hasOutboundDeliveryEvidence(attempt)
  );
}

/** A rejected transcript write after a run with positively observed replay-safe effects. */
export class ReplaySafeTranscriptConflictError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = "ReplaySafeTranscriptConflictError";
  }
}

export function isReplaySafeTranscriptConflict(error: unknown): boolean {
  return collectErrorGraphCandidates(error, readErrorCauses).some(
    (candidate) => candidate instanceof ReplaySafeTranscriptConflictError,
  );
}

/** Cancellation after the execution owner positively proved the whole run effect-free. */
export class ReplaySafeRunAbortError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = cause.name;
  }
}

export function findReplaySafeRunAbort(error: unknown): ReplaySafeRunAbortError | undefined {
  return collectErrorGraphCandidates(error, readErrorCauses).find(
    (candidate): candidate is ReplaySafeRunAbortError =>
      candidate instanceof ReplaySafeRunAbortError,
  );
}
