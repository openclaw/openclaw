import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  asOptionalRecord,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export function formatMatrixErrorReason(err: unknown): string {
  return normalizeLowercaseStringOrEmpty(formatErrorMessage(err));
}

export function isMatrixNotFoundError(err: unknown): boolean {
  const errObj = err as { statusCode?: number; body?: { errcode?: string } };
  if (errObj?.statusCode === 404 || errObj?.body?.errcode === "M_NOT_FOUND") {
    return true;
  }
  const message = formatMatrixErrorReason(err);
  return (
    message.includes("m_not_found") || message.includes("[404]") || message.includes("not found")
  );
}

// The relations and room-history endpoints take `from` as an opaque pagination
// token, so a caller that passes a message/event id gets this specific 400.
const MATRIX_INVALID_FROM_TOKEN_PATTERN = /['"]?from['"]? parameter is invalid/;

export function isMatrixInvalidPaginationTokenError(err: unknown): boolean {
  const record = asOptionalRecord(err);
  const status = record?.statusCode ?? record?.httpStatus;
  if (status !== 400) {
    return false;
  }
  return MATRIX_INVALID_FROM_TOKEN_PATTERN.test(formatMatrixErrorReason(err));
}

export function formatMatrixInvalidPaginationTokenError(token: string): string {
  return (
    `Matrix rejected the read cursor ${JSON.stringify(token)} with HTTP 400 ("'from' parameter is invalid"). ` +
    "The before/after options take an opaque pagination token returned by a previous read " +
    "(nextBatch or prevBatch), not a message or event id. " +
    "Retry with the nextBatch or prevBatch value from the previous read response."
  );
}
