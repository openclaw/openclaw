import { asOptionalRecord, stableStringify } from "@openclaw/normalization-core";
import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveProviderErrorRetrySeconds } from "../internal/retry-after.js";
import { projectDiagnosticValue, redactDiagnosticText } from "./credential-redaction.js";

const MAX_ERROR_BODY_LENGTH = 4000;

/** Diagnostics accept provider classification labels, not arbitrary error prose or objects. */
export function readTransportDiagnosticLabel(value: unknown): string | number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

export type ProviderErrorProjection = {
  stopReason: "aborted" | "error";
  errorMessage: string;
  errorCode?: string;
  quotaScope?: "daily-model";
  errorType?: string;
  errorBody?: string;
  retryAfterMs?: number | null;
};

export type ProviderErrorRedactor = (value: unknown) => unknown;
let providerErrorRedactor: ProviderErrorRedactor | undefined;
export function configureProviderErrorRedactor(redactor: ProviderErrorRedactor | undefined) {
  const previous = providerErrorRedactor;
  providerErrorRedactor = redactor;
  return previous;
}

function readProviderErrorField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    ? normalizeStringifiedOptionalString(value)
    : undefined;
}

function readCauseCode(error: Record<string, unknown>): string | undefined {
  const seen = new Set<Record<string, unknown>>();
  for (
    let cause = asOptionalRecord(error.cause);
    cause && seen.size < 8 && !seen.has(cause);
    cause = asOptionalRecord(cause.cause)
  ) {
    seen.add(cause);
    const code = readProviderErrorField(cause, "code");
    if (code) {
      return code;
    }
  }
  return undefined;
}

function truncateField(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${truncateUtf16Safe(text, maxLength)}... [truncated]`;
}

function stringifyField(value: unknown, maxLength?: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = redactDiagnosticText(
    (typeof value === "string" ? value : stableStringify(value)).trim(),
  );
  if (!text) {
    return undefined;
  }
  return maxLength === undefined ? text : truncateField(text, maxLength);
}

type ProviderDailyModelQuotaEvidence = {
  status: 429;
  code: "RESOURCE_EXHAUSTED";
  quotaScope: "daily-model";
};

/** Validate a producer assertion without joining facts from separate error records. */
export function readProviderDailyModelQuotaEvidence(
  snapshot: unknown,
): ProviderDailyModelQuotaEvidence | undefined {
  const pending = [snapshot];
  const seen = new Set<object>();
  const identity: { provider?: string; model?: string } = {};
  let asserted = false;
  try {
    while (pending.length && seen.size < 16) {
      const source = asOptionalRecord(pending.shift());
      if (!source || seen.has(source)) {
        continue;
      }
      seen.add(source);
      const record: Record<string, unknown> = {};
      for (const key of [
        "status",
        "statusCode",
        "code",
        "errorCode",
        "quotaScope",
        "provider",
        "model",
        "error",
        "cause",
        "response",
        "payload",
      ]) {
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if ((descriptor && !("value" in descriptor)) || (!descriptor && key in source)) {
          return undefined;
        }
        record[key] = descriptor?.value;
      }
      if (
        (record.status !== undefined && record.status !== 429) ||
        (record.statusCode !== undefined && record.statusCode !== 429) ||
        (record.code !== undefined && record.code !== "RESOURCE_EXHAUSTED") ||
        (record.errorCode !== undefined && record.errorCode !== "RESOURCE_EXHAUSTED") ||
        (record.quotaScope !== undefined && record.quotaScope !== "daily-model")
      ) {
        return undefined;
      }
      for (const key of ["provider", "model"] as const) {
        const value = record[key];
        if (value !== undefined) {
          if (
            typeof value !== "string" ||
            (identity[key] !== undefined && identity[key] !== value)
          ) {
            return undefined;
          }
          identity[key] = value;
        }
      }
      asserted ||=
        record.quotaScope === "daily-model" &&
        (record.status ?? record.statusCode) === 429 &&
        (record.errorCode ?? record.code) === "RESOURCE_EXHAUSTED";
      pending.push(record.error, record.cause, record.response, record.payload);
    }
    return asserted && pending.length === 0
      ? { status: 429, code: "RESOURCE_EXHAUSTED", quotaScope: "daily-model" }
      : undefined;
  } catch {
    return undefined;
  }
}

function buildProjection(
  snapshot: unknown,
  signal: AbortSignal | undefined,
  dailyQuota: ProviderDailyModelQuotaEvidence | undefined,
): ProviderErrorProjection {
  const error = asOptionalRecord(snapshot);
  const response = asOptionalRecord(error?.response);
  const nestedError =
    asOptionalRecord(error?.error) ??
    asOptionalRecord(response?.error) ??
    asOptionalRecord(asOptionalRecord(error?.payload)?.error);
  const status =
    [error?.status, error?.statusCode, response?.status, response?.statusCode].find(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    ) ?? dailyQuota?.status;
  const bodyValue =
    error?.errorBody ?? error?.body ?? response?.body ?? response?.data ?? nestedError;
  // Redact complete structured data before clipping its message/body projections.
  const body = stringifyField(bodyValue);
  const originalMessage =
    (typeof snapshot === "string" ? snapshot : undefined) ??
    readProviderErrorField(error, "message") ??
    readProviderErrorField(nestedError, "message");
  const genericMessage = originalMessage === `${status} status code (no body)`;
  let errorMessage =
    status !== undefined && body && (!originalMessage || genericMessage)
      ? `${status}: ${body}`
      : (originalMessage ??
        body ??
        stringifyField(snapshot, MAX_ERROR_BODY_LENGTH) ??
        "Unknown provider error");
  if (
    status !== undefined &&
    (originalMessage || dailyQuota) &&
    !errorMessage.startsWith(String(status))
  ) {
    errorMessage = `${status}: ${errorMessage}`;
  }
  const metadata = asOptionalRecord(nestedError?.metadata);
  const rawMetadata = stringifyField(metadata?.raw, MAX_ERROR_BODY_LENGTH);
  if (rawMetadata && !errorMessage.includes(rawMetadata)) {
    errorMessage += `\n${rawMetadata}`;
  }
  const errorCode =
    readProviderErrorField(error, "errorCode") ??
    readProviderErrorField(error, "code") ??
    readProviderErrorField(nestedError, "code") ??
    (error ? readCauseCode(error) : undefined) ??
    dailyQuota?.code ??
    (status === undefined ? undefined : String(status));
  const errorType =
    readProviderErrorField(error, "errorType") ??
    readProviderErrorField(error, "type") ??
    readProviderErrorField(nestedError, "type");
  // Scope is an explicit producer fact. Status/code alone (or matching prose)
  // never establish a daily limit, and wrappers must not combine separate errors.
  const quotaScope =
    dailyQuota && status === 429 && errorCode === "RESOURCE_EXHAUSTED"
      ? ("daily-model" as const)
      : undefined;
  return {
    stopReason: signal?.aborted ? "aborted" : "error",
    ...(quotaScope ? { quotaScope } : {}),
    errorMessage: stringifyField(errorMessage, 4096) ?? "Unknown provider error",
    ...(errorCode ? { errorCode: truncateUtf16Safe(errorCode, 256) } : {}),
    ...(errorType ? { errorType: truncateUtf16Safe(errorType, 256) } : {}),
    ...(body ? { errorBody: truncateField(body, 500) } : {}),
  };
}

/** Projects one hostile provider throw into final, bounded assistant terminal fields. */
export function projectProviderError(
  error: unknown,
  signal?: AbortSignal,
): ProviderErrorProjection {
  try {
    // Diagnostic projection intentionally discards non-display response headers.
    // Capture only the safe timing scalar before that lossy boundary, including
    // RetryInfo that body truncation would cut off.
    const retryAfterSeconds = resolveProviderErrorRetrySeconds(error);
    // Read only producer-owned data fields before diagnostic limits/redaction can hide aliases.
    const dailyQuota = readProviderDailyModelQuotaEvidence(error);
    const localSnapshot = projectDiagnosticValue(error);
    let snapshot = localSnapshot;
    try {
      snapshot = providerErrorRedactor?.(localSnapshot) ?? localSnapshot;
    } catch {
      // Package projection is independently safe when embedding-host strengthening fails.
    }
    const projection = buildProjection(snapshot, signal, dailyQuota);
    if (retryAfterSeconds !== undefined) {
      const retryAfterMs = Math.ceil(retryAfterSeconds * 1000);
      if (Number.isSafeInteger(retryAfterMs)) {
        projection.retryAfterMs = retryAfterMs;
      } else {
        // JSON cannot carry Infinity; null preserves the non-retryable timing floor.
        projection.retryAfterMs = null;
      }
      const suffix = `; Retry-After: ${retryAfterSeconds} seconds`;
      projection.errorMessage = `${truncateUtf16Safe(projection.errorMessage, 4096 - suffix.length)}${suffix}`;
    }
    return projection;
  } catch {
    return {
      stopReason: signal?.aborted ? "aborted" : "error",
      errorMessage: "Unknown provider error",
    };
  }
}
