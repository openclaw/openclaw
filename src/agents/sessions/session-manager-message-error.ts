import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import type { SessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";

/** Retain the durable outcome when its caller can no longer publish it. */
export class SessionTranscriptMessageCommittedError extends Error {
  readonly committedTarget: SessionTranscriptTargetBinding;

  constructor(
    readonly committedMessageId: string,
    cause: unknown,
    target: SessionTranscriptTargetBinding,
    readonly committedVersion?: SessionTranscriptContextVersion,
    readonly committedLifecycleRevision?: string,
  ) {
    super(
      "Session transcript message committed, but publication did not complete; do not replay the append",
      { cause },
    );
    this.name = "SessionTranscriptMessageCommittedError";
    this.committedTarget = { ...target, ...(target.env ? { env: { ...target.env } } : {}) };
    recordModelFallbackStop(this);
  }
}
