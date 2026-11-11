import {
  formatErrorMessage,
  PlatformMessageNotDispatchedError,
} from "openclaw/plugin-sdk/error-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export function formatMatrixErrorReason(err: unknown): string {
  return normalizeLowercaseStringOrEmpty(formatErrorMessage(err));
}

/**
 * Matrix error responses mean "not stored", except 429 (rate limited: the
 * event may already be accepted) and 408 (timeout: no definitive answer).
 * Definitive 4xx rejections become proven no-send markers so the queue
 * neither retries them blindly nor reports them as unknown-after-send;
 * anything else stays ambiguous.
 */
export function asDefinitiveMatrixRejection(err: unknown): PlatformMessageNotDispatchedError | undefined {
  const status = (err as { httpStatus?: unknown })?.httpStatus;
  if (
    typeof status !== "number" ||
    status < 400 ||
    status >= 500 ||
    status === 429 ||
    status === 408
  ) {
    return undefined;
  }
  return new PlatformMessageNotDispatchedError(formatErrorMessage(err), {
    cause: err,
    retryable: false,
  });
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
