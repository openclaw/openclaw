type MediaUnderstandingSkipReason =
  | "maxBytes"
  | "timeout"
  | "unsupported"
  | "empty"
  | "blocked"
  | "tooSmall";

/** Error used when a media attachment should be skipped without failing the whole request. */
export class MediaUnderstandingSkipError extends Error {
  readonly reason: MediaUnderstandingSkipReason;

  constructor(reason: MediaUnderstandingSkipReason, message: string) {
    super(message);
    this.reason = reason;
    this.name = "MediaUnderstandingSkipError";
  }
}

export function isMediaUnderstandingSkipError(err: unknown): err is MediaUnderstandingSkipError {
  return err instanceof MediaUnderstandingSkipError;
}
