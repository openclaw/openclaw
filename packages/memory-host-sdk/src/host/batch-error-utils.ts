import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import type { EmbeddingBatchOutputLine } from "./batch-output.js";
import { formatErrorMessage } from "./error-utils.js";

// Extracts provider batch error text from output and unavailable error files.

const BATCH_ERROR_DETAIL_MAX_CHARS = 500;
const BATCH_ERROR_DETAIL_TRUNCATED_SUFFIX = "... [truncated]";
const EMBEDDING_BATCH_UNAVAILABLE_CODE = "embedding_batch_unavailable";

/** Signals that a provider cannot run the configured embedding batch operation. */
export class EmbeddingBatchUnavailableError extends Error {
  readonly code = EMBEDDING_BATCH_UNAVAILABLE_CODE;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbeddingBatchUnavailableError";
  }
}

export function isEmbeddingBatchUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  try {
    return (error as { code?: unknown }).code === EMBEDDING_BATCH_UNAVAILABLE_CODE;
  } catch {
    return false;
  }
}

/** Pull a nested response error message without assuming a fixed provider body shape. */
function getResponseErrorMessage(line: EmbeddingBatchOutputLine | undefined): string | undefined {
  const body = line?.response?.body;
  if (typeof body === "string") {
    return body || line?.response?.message || undefined;
  }
  if (!body || typeof body !== "object") {
    return line?.response?.message || undefined;
  }
  return body.error?.message || line?.response?.message || undefined;
}

/** Return the first useful error message from batch output lines. */
export function extractBatchErrorMessage(lines: EmbeddingBatchOutputLine[]): string | undefined {
  const first = lines.find((line) => line.error?.message || getResponseErrorMessage(line));
  return first?.error?.message || getResponseErrorMessage(first);
}

/** Redact and bound provider-controlled batch diagnostics before logging them. */
export function formatBatchErrorDetail(detail: string | undefined): string | undefined {
  if (!detail) {
    return undefined;
  }
  return truncateWithMarker(formatErrorMessage(detail), BATCH_ERROR_DETAIL_MAX_CHARS, {
    marker: BATCH_ERROR_DETAIL_TRUNCATED_SUFFIX,
    reserve: BATCH_ERROR_DETAIL_TRUNCATED_SUFFIX.length,
    trimEnd: false,
  });
}

/** Format a failed error-file read without hiding the underlying read problem. */
export function formatUnavailableBatchError(err: unknown): string | undefined {
  const message = formatBatchErrorDetail(formatErrorMessage(err));
  return message ? `error file unavailable: ${message}` : undefined;
}
