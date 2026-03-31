export type DatabricksErrorCode =
  | "CONFIG_ERROR"
  | "POLICY_VIOLATION"
  | "REQUEST_ERROR"
  | "TIMEOUT"
  | "UNAUTHORIZED"
  | "RATE_LIMIT"
  | "HTTP_ERROR"
  | "TRANSIENT_ERROR"
  | "UNKNOWN_ERROR";

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
    super(params.message);
    this.name = "DatabricksError";
    this.code = params.code;
    this.retryable = params.retryable ?? false;
    this.statusCode = params.statusCode;
    this.details = params.details;
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
  return error.name === "AbortError" || /aborted|abort/i.test(error.message);
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
