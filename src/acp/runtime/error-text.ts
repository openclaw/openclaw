import {
  type AcpRuntimeErrorCode,
  AcpRuntimeError,
  describeAcpRpcError,
  extractAcpRpcError,
  toAcpRuntimeError,
} from "./errors.js";

function resolveAcpRuntimeErrorNextStep(error: AcpRuntimeError): string | undefined {
  if (error.code === "ACP_BACKEND_MISSING" || error.code === "ACP_BACKEND_UNAVAILABLE") {
    return "Run `/acp doctor`, install/enable the backend plugin, then retry.";
  }
  if (error.code === "ACP_DISPATCH_DISABLED") {
    return "Enable `acp.dispatch.enabled=true` to allow thread-message ACP turns.";
  }
  if (error.code === "ACP_SESSION_INIT_FAILED") {
    return "If this session is stale, recreate it with `/acp spawn` and rebind the thread.";
  }
  if (error.code === "ACP_INVALID_RUNTIME_OPTION") {
    return "Use `/acp status` to inspect options and pass valid values.";
  }
  if (error.code === "ACP_BACKEND_UNSUPPORTED_CONTROL") {
    return "This backend does not support that control; use a supported command.";
  }
  if (error.code === "ACP_TURN_FAILED") {
    return "Retry, or use `/acp cancel` and send the message again.";
  }
  return undefined;
}

function resolveAcpRuntimeErrorDetail(error: AcpRuntimeError): string | undefined {
  const payload = extractAcpRpcError(error.cause);
  if (!payload) {
    return undefined;
  }
  const summary = describeAcpRpcError(error.cause);
  if (!summary) {
    return undefined;
  }
  if (error.message && summary.toLowerCase().includes(error.message.toLowerCase())) {
    return undefined;
  }
  return summary;
}

export function formatAcpRuntimeErrorText(error: AcpRuntimeError): string {
  const detail = resolveAcpRuntimeErrorDetail(error);
  const next = resolveAcpRuntimeErrorNextStep(error);
  const detailLine = detail ? `\ndetail: ${detail}` : "";
  if (!next) {
    return `ACP error (${error.code}): ${error.message}${detailLine}`;
  }
  return `ACP error (${error.code}): ${error.message}${detailLine}\nnext: ${next}`;
}

export function toAcpRuntimeErrorText(params: {
  error: unknown;
  fallbackCode: AcpRuntimeErrorCode;
  fallbackMessage: string;
}): string {
  return formatAcpRuntimeErrorText(
    toAcpRuntimeError({
      error: params.error,
      fallbackCode: params.fallbackCode,
      fallbackMessage: params.fallbackMessage,
    }),
  );
}
