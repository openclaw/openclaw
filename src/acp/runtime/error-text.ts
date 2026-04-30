import { type AcpRuntimeErrorCode, AcpRuntimeError, toAcpRuntimeError } from "./errors.js";

const ACP_PROVIDER_AUTH_FAILURE_PATTERN =
  /\b(?:API Error:\s*)?401\b|authentication_error|Invalid authentication credentials|Failed to authenticate/i;

function isAcpProviderAuthFailure(error: AcpRuntimeError): boolean {
  return error.code === "ACP_TURN_FAILED" && ACP_PROVIDER_AUTH_FAILURE_PATTERN.test(error.message);
}

function resolveAcpRuntimeErrorMessage(error: AcpRuntimeError): string {
  if (isAcpProviderAuthFailure(error)) {
    return "ACP provider authentication failed. Use an allowed and configured ACP agent.";
  }
  return error.message;
}

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
  if (isAcpProviderAuthFailure(error)) {
    return 'Use `/acp cancel`, then start a Codex ACP session or retry with `agentId="codex"`.';
  }
  if (error.code === "ACP_TURN_FAILED") {
    return "Retry, or use `/acp cancel` and send the message again.";
  }
  return undefined;
}

export function formatAcpRuntimeErrorText(error: AcpRuntimeError): string {
  const message = resolveAcpRuntimeErrorMessage(error);
  const next = resolveAcpRuntimeErrorNextStep(error);
  if (!next) {
    return `ACP error (${error.code}): ${message}`;
  }
  return `ACP error (${error.code}): ${message}\nnext: ${next}`;
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
