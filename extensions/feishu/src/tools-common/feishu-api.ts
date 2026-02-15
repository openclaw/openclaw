/**
 * Minimal response shape shared by Feishu OpenAPI endpoints.
 * Most endpoints return success when `code` is `0` (or omitted).
 */
export type FeishuApiResponse = {
  code?: number;
  msg?: string;
  log_id?: string;
  logId?: string;
};

type FeishuErrorInfo = {
  code?: number;
  msg?: string;
  logId?: string;
};

type RunFeishuApiCallOptions = {
  /** Feishu error codes that should be treated as transient and retried. */
  retryableCodes?: Iterable<number>;
  /** Retry delays in milliseconds. Number of entries controls retry attempts. */
  backoffMs?: number[];
};

/**
 * Standard tool result payload:
 * - `content` for model-visible text output
 * - `details` for structured downstream access
 */
export function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/** Convert any thrown value into the standard JSON error envelope. */
export function errorResult(err: unknown) {
  return json({ error: err instanceof Error ? err.message : String(err) });
}

/** Small async sleep utility used by retry backoff. */
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract Feishu error fields (`code`, `msg`, `log_id`) from different throw shapes.
 * Handles nested SDK error arrays and axios-style `response.data`.
 */
function extractFeishuErrorInfo(err: unknown): FeishuErrorInfo | null {
  if (!err) return null;

  // Feishu SDK may throw nested array structures like:
  // [axiosError, { code, msg, log_id, ... }]
  if (Array.isArray(err)) {
    for (let i = err.length - 1; i >= 0; i -= 1) {
      const info = extractFeishuErrorInfo(err[i]);
      if (info) return info;
    }
    return null;
  }

  if (typeof err !== "object") return null;

  const obj = err as Record<string, unknown>;
  const codeValue = obj.code;
  const msgValue = obj.msg ?? obj.message;
  const logIdValue = obj.log_id ?? obj.logId;

  const hasCode = typeof codeValue === "number";
  const hasMsg = typeof msgValue === "string";
  const hasLogId = typeof logIdValue === "string";

  if (hasCode || hasMsg || hasLogId) {
    return {
      code: hasCode ? codeValue : undefined,
      msg: hasMsg ? (msgValue as string) : undefined,
      logId: hasLogId ? (logIdValue as string) : undefined,
    };
  }

  const responseData = (obj.response as { data?: unknown } | undefined)?.data;
  if (responseData) return extractFeishuErrorInfo(responseData);

  return null;
}

function assertFeishuOk<T extends FeishuApiResponse>(response: T, context: string): T {
  if (response.code === undefined || response.code === 0) return response;

  const message = response.msg || `code ${response.code}`;
  const detail = response.log_id ?? response.logId;
  const error = new Error(
    detail
      ? `${context} failed: ${message}, code=${response.code}, log_id=${detail}`
      : `${context} failed: ${message}, code=${response.code}`,
  ) as Error & { code?: number; log_id?: string; logId?: string };
  error.code = response.code;
  if (detail) {
    error.log_id = detail;
    error.logId = detail;
  }
  throw error;
}

/**
 * Normalize unknown errors to a readable, context-aware Error message.
 * Preserves Feishu `code/log_id` details when available.
 */
function toError(err: unknown, context: string): Error {
  if (err instanceof Error) {
    const info = extractFeishuErrorInfo(err);
    if (!info) return err;
    const details = [
      info.msg || `code ${info.code}`,
      info.code !== undefined ? `code=${info.code}` : undefined,
      info.logId ? `log_id=${info.logId}` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    return new Error(`${context} failed: ${details}`);
  }

  const info = extractFeishuErrorInfo(err);
  if (info) {
    const details = [
      info.msg || `code ${info.code}`,
      info.code !== undefined ? `code=${info.code}` : undefined,
      info.logId ? `log_id=${info.logId}` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    return new Error(`${context} failed: ${details}`);
  }

  return new Error(`${context} failed: ${String(err)}`);
}

/**
 * Execute a Feishu API call with shared success/error handling.
 *
 * Behavior:
 * - Treats `code === 0` (or undefined) as success.
 * - Converts non-zero responses and thrown values into normalized Errors.
 * - Optionally retries only for configured transient error codes.
 *
 * Retry model:
 * - Attempts = `backoffMs.length + 1`
 * - Delay before each retry uses the corresponding `backoffMs` entry.
 */
export async function runFeishuApiCall<T extends FeishuApiResponse>(
  context: string,
  fn: () => Promise<T>,
  options?: RunFeishuApiCallOptions,
): Promise<T> {
  const retryableCodes = new Set(options?.retryableCodes ?? []);
  const backoffMs = options?.backoffMs ?? [];
  const maxAttempts = backoffMs.length + 1;
  let attempt = 0;
  let lastErr: unknown = null;

  while (attempt < maxAttempts) {
    try {
      const response = await fn();
      return assertFeishuOk(response, context);
    } catch (err) {
      lastErr = err;
      const info = extractFeishuErrorInfo(err);
      const retryable =
        retryableCodes.size > 0 && info?.code !== undefined && retryableCodes.has(info.code);
      const exhausted = attempt >= maxAttempts - 1;
      if (!retryable || exhausted) {
        throw toError(err, context);
      }

      const waitMs = backoffMs[Math.min(attempt, backoffMs.length - 1)];
      await sleep(waitMs);
      attempt += 1;
    }
  }

  throw toError(lastErr, context);
}
