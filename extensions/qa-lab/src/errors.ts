// Qa Lab plugin module defines shared suite errors.
export type QaSuiteArtifactErrorCode =
  | "evidence_missing"
  | "report_missing"
  | "summary_missing"
  | "summary_read_failed"
  | "summary_parse_failed"
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

export type QaSuiteInfraErrorCode =
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

export function toQaErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
