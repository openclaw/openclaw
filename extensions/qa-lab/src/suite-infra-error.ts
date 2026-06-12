// Qa Lab plugin module defines shared suite infrastructure errors.
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
