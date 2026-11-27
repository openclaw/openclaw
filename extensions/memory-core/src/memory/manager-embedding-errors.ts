import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
} from "openclaw/plugin-sdk/error-runtime";

const MEMORY_EMBEDDING_OPERATION_ERROR_CODE = "MEMORY_EMBEDDING_OPERATION_FAILED";

type MemoryEmbeddingOperationKind = "query" | "batch" | "structured-batch";

type MemoryEmbeddingOperationError = Error & {
  code: typeof MEMORY_EMBEDDING_OPERATION_ERROR_CODE;
  operation: MemoryEmbeddingOperationKind;
  providerId?: string;
  cause?: unknown;
};

export function createMemoryEmbeddingOperationError(params: {
  operation: MemoryEmbeddingOperationKind;
  providerId?: string;
  cause: unknown;
}): MemoryEmbeddingOperationError {
  const message = formatErrorMessage(params.cause);
  const error = new Error(message) as MemoryEmbeddingOperationError;
  error.code = MEMORY_EMBEDDING_OPERATION_ERROR_CODE;
  error.operation = params.operation;
  if (params.providerId) {
    error.providerId = params.providerId;
  }
  error.cause = params.cause;
  return error;
}

export function isMemoryEmbeddingOperationError(
  err: unknown,
): err is MemoryEmbeddingOperationError {
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === MEMORY_EMBEDDING_OPERATION_ERROR_CODE
  );
}

/** A provider marks one media file it cannot decode; it is skipped, not retried. */
export function isUnsupportedEmbeddingMediaError(err: unknown): boolean {
  return collectErrorGraphCandidates(err, (current) => [current.cause]).some(
    (cause) => extractErrorCode(cause) === "EMBEDDING_MEDIA_UNSUPPORTED",
  );
}

/** A media file the provider rejects as too large or cannot decode does not stop the sync. */
export function isRejectedMultimodalFileError(err: unknown, message: string): boolean {
  return (
    isUnsupportedEmbeddingMediaError(err) ||
    /(413|payload too large|request too large|input too large|too many tokens|input limit|request size)/i.test(
      message,
    )
  );
}
