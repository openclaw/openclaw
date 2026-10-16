import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { redactToolPayloadText } from "../logging/redact.js";

/** MCP lifecycle errors use the protocol code, including serialized SDK errors. */
export function isMcpRequestTimeoutError(error: unknown): boolean {
  return isRecord(error) && error.code === ErrorCode.RequestTimeout;
}

export function isMcpMethodNotFoundError(error: unknown): boolean {
  if (isRecord(error) && error.code === ErrorCode.MethodNotFound) {
    return true;
  }
  const message = String(error);
  return message.includes("-32601") || /\b(?:method not found|unknown method)\b/i.test(message);
}

/** Redacts MCP diagnostics, including response bodies the SDK includes in thrown errors. */
export function redactMcpDiagnosticError(error: unknown): string {
  const message =
    error instanceof StreamableHTTPError && error.code === 401
      ? "authentication refused (401); check this MCP server's credentials or sign in again"
      : formatErrorMessage(error).replace(
          /(Error POSTing to endpoint(?: \(HTTP \d+\))?:)[\s\S]*/,
          "$1 [redacted response body]",
        );
  return redactToolPayloadText(redactSensitiveUrlLikeString(message));
}
