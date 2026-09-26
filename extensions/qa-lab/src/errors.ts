// Qa Lab plugin module defines shared suite errors.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

const QA_SUITE_INFRA_RETRY_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
]);

export function toQaError(value: unknown): Error {
  return value instanceof Error ? value : new Error(formatErrorMessage(value));
}

type QaSuiteArtifactErrorCode =
  | "evidence_missing"
  | "report_missing"
  | "summary_missing"
  | "summary_read_failed"
  | "summary_parse_failed"
  | "summary_not_completed"
  | "summary_counts_invalid"
  | "summary_failure_count_missing"
  | "summary_blocking_count_missing";

export class QaSuiteArtifactError extends Error {
  readonly code: QaSuiteArtifactErrorCode;

  constructor(code: QaSuiteArtifactErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QaSuiteArtifactError";
    this.code = code;
  }
}

type QaSuiteInfraErrorCode =
  | "agent_wait_failed"
  | "gateway_startup_unhealthy"
  | "gateway_ready_timeout"
  | "qa_cli_timeout"
  | "transport_ready_timeout";

export class QaSuiteInfraError extends Error {
  readonly code: QaSuiteInfraErrorCode;

  constructor(code: QaSuiteInfraErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QaSuiteInfraError";
    this.code = code;
  }
}

export class QaSuiteScenarioSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaSuiteScenarioSkipError";
  }
}

// Only unconfirmed resource cleanup closes further admission. Ordinary cleanup
// errors retain their existing retry policy and must not acquire this marker.
export class QaSuiteCleanupError extends AggregateError {
  constructor(errors: unknown[], message: string) {
    super(errors, message, { cause: errors[0] });
    this.name = "QaSuiteCleanupError";
  }
}

export function combineQaSuiteErrors(
  errors: unknown[],
  message: string,
  options?: ErrorOptions,
): AggregateError {
  return errors.some((error) => error instanceof QaSuiteCleanupError)
    ? new QaSuiteCleanupError(errors, message)
    : new AggregateError(errors, message, options);
}

export function isQaSuiteInfraRetryableError(error: unknown) {
  if (error instanceof QaSuiteCleanupError) {
    return false;
  }
  if (error instanceof QaSuiteArtifactError || error instanceof QaSuiteInfraError) {
    return true;
  }
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current !== "object") {
      return false;
    }
    // SAFETY: The loop excludes null; these optional fields remain unknown until checked.
    const record = current as { cause?: unknown; code?: unknown };
    if (
      typeof record.code === "string" &&
      QA_SUITE_INFRA_RETRY_NETWORK_ERROR_CODES.has(record.code.toUpperCase())
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}
