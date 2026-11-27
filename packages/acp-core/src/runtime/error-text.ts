import { type AcpRuntimeErrorCode, AcpRuntimeError, toAcpRuntimeError } from "./errors.js";

const ACP_RUNTIME_ERROR_NEXT_STEPS: Record<AcpRuntimeErrorCode, string> = {
  ACP_BACKEND_MISSING: "Run `/acp doctor`, install/enable the backend plugin, then retry.",
  ACP_BACKEND_UNAVAILABLE: "Run `/acp doctor`, install/enable the backend plugin, then retry.",
  ACP_DISPATCH_DISABLED: "Enable `acp.dispatch.enabled=true` to allow thread-message ACP turns.",
  ACP_SESSION_INIT_FAILED:
    "If this session is stale, recreate it with `/acp spawn` and rebind the thread.",
  ACP_INVALID_RUNTIME_OPTION: "Use `/acp status` to inspect options and pass valid values.",
  ACP_BACKEND_UNSUPPORTED_CONTROL:
    "This backend does not support that control; use a supported command.",
  ACP_TURN_FAILED: "Retry, or use `/acp cancel` and send the message again.",
};

/** Formats ACP runtime errors with the operator next-step hint attached when known. */
export function formatAcpRuntimeErrorText(error: AcpRuntimeError): string {
  const next = Object.hasOwn(ACP_RUNTIME_ERROR_NEXT_STEPS, error.code)
    ? ACP_RUNTIME_ERROR_NEXT_STEPS[error.code]
    : undefined;
  return `ACP error (${error.code}): ${error.message}${next ? `\nnext: ${next}` : ""}`;
}

/** Normalizes unknown failures into ACP runtime error text for user-facing surfaces. */
export function toAcpRuntimeErrorText(params: {
  error: unknown;
  fallbackCode: AcpRuntimeErrorCode;
  fallbackMessage: string;
}): string {
  return formatAcpRuntimeErrorText(toAcpRuntimeError(params));
}
