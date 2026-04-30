import { formatErrorMessage } from "../infra/errors.js";

export type TransientProviderRetryParams = {
  error: unknown;
  message: string;
  provider: string;
  apiKeyIndex: number;
  attemptNumber: number;
};

export type TransientProviderRetryOptions = {
  /**
   * Total executions per API key, including the first call.
   * attempts: 2 means one initial call plus one same-key retry.
   */
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  shouldRetry?: (params: TransientProviderRetryParams) => boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function readErrorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function readErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  for (const value of [record.status, record.statusCode, record.code]) {
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
    if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
      return Number(value.trim());
    }
  }
  return undefined;
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function readErrorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return (error as { cause?: unknown }).cause;
}

function hasTransientNetworkSignal(error: unknown, message: string): boolean {
  const transientCodes = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/i;
  if (transientCodes.test(message)) {
    return true;
  }
  const cause = readErrorCause(error);
  if (!cause || cause === error) {
    return false;
  }
  const causeCode = readErrorCode(cause);
  if (causeCode && transientCodes.test(causeCode)) {
    return true;
  }
  const causeMessage = formatErrorMessage(cause);
  return transientCodes.test(causeMessage);
}

function hasTimeoutSignal(error: unknown, message: string): boolean {
  if (/\b(?:request timeout|provider timeout|timed out|timeout)\b/i.test(message)) {
    return true;
  }
  const cause = readErrorCause(error);
  if (!cause || cause === error) {
    return false;
  }
  return /\b(?:request timeout|provider timeout|timed out|timeout)\b/i.test(
    formatErrorMessage(cause),
  );
}

export function isTransientProviderOperationError(error: unknown, message: string): boolean {
  const status = readErrorStatus(error);
  if (status !== undefined) {
    return status === 500 || status === 502 || status === 503 || status === 504;
  }
  if (
    /\b(?:HTTP\s*)?(?:400|401|403|404)\b/i.test(message) ||
    /\b(?:invalid api key|permission denied|model not found|validation|unsupported model)\b/i.test(
      message,
    )
  ) {
    return false;
  }
  if (/\b(?:HTTP\s*)?(?:500|502|503|504)\b/i.test(message)) {
    return true;
  }
  if (hasTransientNetworkSignal(error, message)) {
    return true;
  }
  if (readErrorName(error) === "AbortError") {
    // Timeout wrappers can abort without a reason, yielding a generic AbortError
    // message such as "This operation was aborted". Caller aborts are filtered
    // by the retry options signal before this classifier is used.
    return true;
  }
  if (hasTimeoutSignal(error, message)) {
    return true;
  }
  if (/\bfetch failed\b/i.test(message)) {
    return hasTransientNetworkSignal(error, message);
  }
  return false;
}

export function resolveTransientProviderAttempts(options?: TransientProviderRetryOptions): number {
  if (!options) {
    return 1;
  }
  return Math.max(1, Math.round(Number.isFinite(options.attempts) ? options.attempts : 1));
}

export function resolveTransientProviderDelayMs(
  options: TransientProviderRetryOptions,
  attemptNumber: number,
): number {
  const rawBaseDelayMs = options.baseDelayMs ?? 250;
  const baseDelayMs = Math.max(
    0,
    Math.round(Number.isFinite(rawBaseDelayMs) ? rawBaseDelayMs : 250),
  );
  const rawMaxDelayMs = options.maxDelayMs ?? 1_000;
  const maxDelayMs = Math.max(
    baseDelayMs,
    Math.round(Number.isFinite(rawMaxDelayMs) ? rawMaxDelayMs : 1_000),
  );
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(attemptNumber - 1, 0));
}

export function shouldRetrySameKeyProviderOperation(params: {
  options: TransientProviderRetryOptions;
  error: unknown;
  message: string;
  provider: string;
  apiKeyIndex: number;
  attemptNumber: number;
  maxAttempts: number;
}): boolean {
  if (params.attemptNumber >= params.maxAttempts) {
    return false;
  }
  if (params.options.signal?.aborted) {
    return false;
  }
  const retryParams: TransientProviderRetryParams = {
    error: params.error,
    message: params.message,
    provider: params.provider,
    apiKeyIndex: params.apiKeyIndex,
    attemptNumber: params.attemptNumber,
  };
  return params.options.shouldRetry
    ? params.options.shouldRetry(retryParams)
    : isTransientProviderOperationError(params.error, params.message);
}
