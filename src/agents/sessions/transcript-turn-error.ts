import {
  collectNestedErrorCandidates,
  readErrorName,
} from "@openclaw/normalization-core/error-coercion";
import {
  asOptionalObjectRecord,
  readStringField,
} from "@openclaw/normalization-core/record-coerce";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/session-transcript-writer-claim-error.js";

export type SessionTranscriptContinuityFailureKind =
  | "missing_active_anchor"
  | "projection_read_fence"
  | "writer_replaced";

/** A different provider cannot restore the admitted transcript's authority. */
export class SessionTranscriptContinuityError extends Error {
  readonly kind: SessionTranscriptContinuityFailureKind;

  constructor(
    kind: SessionTranscriptContinuityFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.kind = kind;
    this.name = "SessionTranscriptContinuityError";
  }
}

/** Preserve exact refusals across native, serialized and primary/secondary error boundaries. */
export function classifySessionTranscriptContinuityError(
  error: unknown,
): SessionTranscriptContinuityFailureKind | undefined {
  for (const candidate of collectNestedErrorCandidates(error)) {
    if (candidate instanceof SessionTranscriptContinuityError) {
      return candidate.kind;
    }
    if (
      candidate instanceof SessionTranscriptReadFenceError ||
      readErrorName(candidate) === "SessionTranscriptReadFenceError"
    ) {
      return "projection_read_fence";
    }
    if (
      candidate instanceof SessionTranscriptWriterClaimReboundError ||
      readErrorName(candidate) === "SessionTranscriptWriterClaimReboundError"
    ) {
      return "writer_replaced";
    }
    const message =
      typeof candidate === "string"
        ? candidate
        : readStringField(asOptionalObjectRecord(candidate), "message");
    const text = message?.replace(/^Error: /, "");
    if (text && /^Session transcript anchor was not returned: \S+$/.test(text)) {
      return "missing_active_anchor";
    }
    if (text === "Session transcript changed during context read") {
      return "projection_read_fence";
    }
    if (text === "session writer claim changed before transcript persistence") {
      return "writer_replaced";
    }
  }
  return undefined;
}

/** Native agent and Gateway error surfaces can retain only the admission assertion text. */
export function isSessionTranscriptTurnMismatchErrorMessage(
  message: string | undefined,
): message is string {
  const text = message?.replace(/^Error: /, "") ?? "";
  return (
    /^Session transcript keyed user is outside the current turn: \S/.test(text) ||
    /^Transcript idempotency key ".+" conflicts with the admitted message\.$/.test(text) ||
    text === "Model prompt projection lost its canonical user turn" ||
    text === "Pending input is no longer active in its admitted transcript" ||
    text === "Pending input session changed before transcript promotion" ||
    text === "Pending input custody ended before transcript promotion"
  );
}
