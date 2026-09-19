import type { ProviderFailureReason } from "openclaw/plugin-sdk/decisions";

export class EvaluationError extends Error {
  constructor(
    message: string,
    readonly reason: ProviderFailureReason,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EvaluationError";
  }
}

/** Only fixed plugin diagnostics cross the tool/provider boundary; raw causes stay discarded. */
export function evaluationError(error: unknown, aborted: boolean): EvaluationError {
  if (aborted) {
    return new EvaluationError("TypeSafe evaluation cancelled.", "transport");
  }
  if (error instanceof EvaluationError) {
    return error;
  }
  return new EvaluationError(
    "TypeSafe evaluation failed or returned an invalid response.",
    "invalid-response",
  );
}
