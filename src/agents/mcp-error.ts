import {
  InsufficientScopeError,
  ProtocolErrorCode,
  SdkErrorCode,
  SdkHttpError,
  SseError,
} from "@modelcontextprotocol/client";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { McpPaginationTimeoutError } from "./mcp-pagination.js";

const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Remote outages may degrade Doctor; local startup and protocol errors still fail it. */
export function isMcpServiceAvailabilityError(
  error: unknown,
  transportType: "stdio" | "sse" | "streamable-http",
): boolean {
  if (transportType === "stdio") {
    return false;
  }
  const visited = new Set<unknown>();
  const classify = (value: unknown, depth: number): boolean => {
    if (!isRecord(value) || visited.has(value) || depth > 4) {
      return false;
    }
    visited.add(value);
    if (value instanceof McpPaginationTimeoutError || value instanceof InsufficientScopeError) {
      return true;
    }
    if (value instanceof SdkHttpError || value instanceof SseError) {
      // Legacy SSE uses a numeric HTTP status; unrelated numeric RPC codes below do not.
      const status = value instanceof SseError ? value.code : value.status;
      return (
        status === 401 ||
        status === 403 ||
        status === 408 ||
        status === 429 ||
        (typeof status === "number" && status >= 500 && status <= 599)
      );
    }
    // JSON-RPC numeric errors come from the server, not the transport deadline.
    if (typeof value.code === "number") {
      return false;
    }
    if (
      isMcpRequestTimeoutError(value) ||
      value.code === "MCP_CONNECT_TIMEOUT" ||
      (typeof value.code === "string" && NETWORK_ERROR_CODES.has(value.code))
    ) {
      return true;
    }
    if (Array.isArray(value.errors)) {
      return value.errors.length > 0 && value.errors.every((nested) => classify(nested, depth + 1));
    }
    return classify(value.cause, depth + 1);
  };
  return classify(error, 0);
}

/** SDK deadlines use local string codes; remote numeric errors remain protocol failures. */
export function isMcpRequestTimeoutError(error: unknown): boolean {
  return isRecord(error) && error.code === SdkErrorCode.RequestTimeout;
}

export function isMcpMethodNotFoundError(error: unknown): boolean {
  if (isRecord(error) && error.code === ProtocolErrorCode.MethodNotFound) {
    return true;
  }
  const message = String(error);
  return message.includes("-32601") || /\b(?:method not found|unknown method)\b/i.test(message);
}

/** Redacts MCP diagnostics, including response bodies the SDK includes in thrown errors. */
export function redactMcpDiagnosticError(error: unknown): string {
  const message =
    error instanceof SdkHttpError && error.status === 401
      ? "authentication refused (401); check this MCP server's credentials or sign in again"
      : formatErrorMessage(error).replace(
          /(Error POSTing to endpoint(?: \(HTTP \d+\))?:)[\s\S]*/,
          "$1 [redacted response body]",
        );
  return redactToolPayloadText(redactSensitiveUrlLikeString(message));
}
