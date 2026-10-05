import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import type { SessionMetadataOperations } from "../../config/sessions/session-manager-write-contract.js";
import type { SessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";

type AcknowledgedMetadataReply = {
  ok: true;
  value: SessionMetadataOperations[keyof SessionMetadataOperations]["output"];
};

export class SessionManagerActorCommittedError extends Error {
  // A rewrite receipt can contain transcript content; ordinary diagnostics must not print it.
  readonly #committedReply: AcknowledgedMetadataReply;

  constructor(
    readonly committedCommand: keyof SessionMetadataOperations,
    committedReply: AcknowledgedMetadataReply,
    cause: unknown,
  ) {
    super("Acknowledged transcript operation could not finish; do not replay", { cause });
    this.#committedReply = committedReply;
    this.name = "SessionManagerActorCommittedError";
    recordModelFallbackStop(this);
  }

  get committedReply(): AcknowledgedMetadataReply {
    return this.#committedReply;
  }
}

/** Acknowledgment survives publication failure; callers must finish their existing receipt owner. */
export async function receiveSessionManagerCommit<Key extends keyof SessionMetadataOperations>(
  command: Key,
  operation: () => Promise<SessionMetadataOperations[Key]["output"]>,
): Promise<{
  value: SessionMetadataOperations[Key]["output"];
  failure?: SessionManagerActorCommittedError;
}> {
  try {
    return { value: await operation() };
  } catch (error) {
    if (
      !(error instanceof SessionManagerActorCommittedError) ||
      error.committedCommand !== command
    ) {
      throw error;
    }
    return {
      // SAFETY: the receipt is paired with the command checked above.
      value: error.committedReply.value as SessionMetadataOperations[Key]["output"],
      failure: error,
    };
  }
}

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
