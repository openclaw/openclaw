import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import type { SessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";

export function committedTranscriptViewError(payload: unknown): Error {
  const error = new Error("Committed session transcript view could not be reconstructed");
  if (payload) {
    retainOpenClawStateWorkerErrorPayload(error, payload);
  }
  return hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
}

export class SessionEntryCommittedError extends Error {
  constructor(
    readonly committedEntryId: string,
    readonly committedTarget: SessionTranscriptTargetBinding,
    readonly committedVersion: SessionTranscriptContextVersion,
    cause: unknown,
  ) {
    super("Session entry committed, but publication did not complete; do not replay the append", {
      cause,
    });
    this.name = "SessionEntryCommittedError";
    recordModelFallbackStop(this);
  }
}

export function isSqliteTranscriptMutationConflict(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if (current.name === "SqliteTranscriptMutationConflictError") {
      return true;
    }
    current = current.cause;
  }
  return false;
}
