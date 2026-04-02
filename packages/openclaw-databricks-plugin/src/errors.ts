export type DatabricksErrorCode =
  | "CONFIG_ERROR"
  | "POLICY_VIOLATION"
  | "ALLOWLIST_VIOLATION"
  | "REQUEST_ERROR"
  | "TIMEOUT"
  | "STATEMENT_TIMEOUT"
  | "POLLING_TIMEOUT"
  | "POLLING_RETRY_EXHAUSTED"
  | "STATEMENT_PENDING_MAX_WAIT"
  | "STATEMENT_FAILED"
  | "UNAUTHORIZED"
  | "RATE_LIMIT"
  | "HTTP_ERROR"
  | "TRANSIENT_ERROR"
  | "UNKNOWN_ERROR";

const URL_REDACTION_PATTERN = /\bhttps?:\/\/[^\s"']+/giu;
const BEARER_REDACTION_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/giu;
const RAW_TOKEN_REDACTION_PATTERN = /\bdapi[a-z0-9._-]{8,}\b/giu;

function redactToken(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) {
    return "***";
  }
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-3)}`;
}

export function sanitizeDatabricksText(value: string): string {
  return value
    .replace(BEARER_REDACTION_PATTERN, (match) => {
      const token = match.replace(/^Bearer\s+/iu, "");
      return `Bearer ${redactToken(token)}`;
    })
    .replace(RAW_TOKEN_REDACTION_PATTERN, (token) => redactToken(token))
    .replace(URL_REDACTION_PATTERN, "[redacted-url]");
}

function sanitizeUnknownText(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeDatabricksText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeUnknownText(entry));
  }
  if (value && typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (
        lower.includes("token") ||
        lower.includes("authorization") ||
        lower.includes("api_key") ||
        lower.includes("apikey") ||
        lower.includes("secret")
      ) {
        safe[key] = "***";
        continue;
      }
      safe[key] = sanitizeUnknownText(nested);
    }
    return safe;
  }
  return value;
}

export class DatabricksError extends Error {
  readonly code: DatabricksErrorCode;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(params: {
    code: DatabricksErrorCode;
    message: string;
    retryable?: boolean;
    statusCode?: number;
    details?: Record<string, unknown>;
  }) {
    super(sanitizeDatabricksText(params.message));
    this.name = "DatabricksError";
    this.code = params.code;
    this.retryable = params.retryable ?? false;
    this.statusCode = params.statusCode;
    this.details = params.details
      ? (sanitizeUnknownText(params.details) as Record<string, unknown>)
      : undefined;
  }
}

export class DatabricksConfigError extends DatabricksError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: "CONFIG_ERROR",
      message,
      retryable: false,
      details,
    });
    this.name = "DatabricksConfigError";
  }
}

export class DatabricksPolicyError extends DatabricksError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: "POLICY_VIOLATION",
      message,
      retryable: false,
      details,
    });
    this.name = "DatabricksPolicyError";
  }
}

export class DatabricksAllowlistError extends DatabricksError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: "ALLOWLIST_VIOLATION",
      message,
      retryable: false,
      details,
    });
    this.name = "DatabricksAllowlistError";
  }
}

export class DatabricksHttpError extends DatabricksError {
  constructor(params: {
    statusCode: number;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }) {
    const code = mapStatusToErrorCode(params.statusCode);
    super({
      code,
      message: params.message,
      statusCode: params.statusCode,
      retryable: params.retryable ?? isRetryableStatus(params.statusCode),
      details: params.details,
    });
    this.name = "DatabricksHttpError";
  }
}

export function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode === 408 || statusCode >= 500;
}

function mapStatusToErrorCode(statusCode: number): DatabricksErrorCode {
  if (statusCode === 401 || statusCode === 403) {
    return "UNAUTHORIZED";
  }
  if (statusCode === 429) {
    return "RATE_LIMIT";
  }
  if (statusCode === 408 || statusCode >= 500) {
    return "TRANSIENT_ERROR";
  }
  return "HTTP_ERROR";
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || /aborted|abort/iu.test(error.message);
}

export function normalizeDatabricksError(error: unknown, fallbackMessage: string): DatabricksError {
  if (error instanceof DatabricksError) {
    return error;
  }
  if (isAbortError(error)) {
    return new DatabricksError({
      code: "TIMEOUT",
      message: fallbackMessage,
      retryable: true,
    });
  }
  if (error instanceof Error) {
    return new DatabricksError({
      code: "UNKNOWN_ERROR",
      message: error.message || fallbackMessage,
      retryable: false,
    });
  }
  return new DatabricksError({
    code: "UNKNOWN_ERROR",
    message: fallbackMessage,
    retryable: false,
  });
}
