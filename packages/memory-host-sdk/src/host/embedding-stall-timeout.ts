/** Marker contract for provider-owned per-call stall deadlines.
 * A fired stall deadline already bounded a full provider attempt, so retry
 * owners must surface the error instead of spending the caller's remaining
 * budget on another attempt that hangs the same way (#136405). */
export const EMBEDDING_STALL_TIMEOUT_ERROR_NAME = "EmbeddingStallTimeoutError";

export function createEmbeddingStallTimeoutError(
  message: string,
  options?: { cause?: unknown },
): Error {
  const error = new Error(message, options);
  error.name = EMBEDDING_STALL_TIMEOUT_ERROR_NAME;
  return error;
}

export function isEmbeddingStallTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === EMBEDDING_STALL_TIMEOUT_ERROR_NAME
  );
}
