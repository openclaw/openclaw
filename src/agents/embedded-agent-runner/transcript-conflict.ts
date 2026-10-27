import {
  collectErrorGraphCandidates,
  readErrorCauses,
} from "@openclaw/normalization-core/error-coercion";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import { hasOutboundDeliveryEvidence, type AgentDeliveryEvidence } from "./delivery-evidence.js";
import { observeReplayMetadata, type EmbeddedRunReplayState } from "./replay-state.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

export function isTranscriptConflictReplaySafe(
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

const REWRITE_CONFLICT_MESSAGES = new Set([
  "Session transcript changed before rewrite preparation",
  "Session transcript changed before rewrite publication",
]);

/** True when a rewrite preparation or publication lost its transcript revision. */
export function isTranscriptRewriteConflict(error: unknown): boolean {
  return collectErrorGraphCandidates(error, readErrorCauses).some((candidate) => {
    if (candidate instanceof SqliteTranscriptMutationConflictError) {
      return true;
    }
    return candidate instanceof Error && REWRITE_CONFLICT_MESSAGES.has(candidate.message);
  });
}
