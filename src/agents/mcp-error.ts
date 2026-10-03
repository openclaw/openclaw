import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { redactToolPayloadText } from "../logging/redact.js";

const STREAMABLE_RESPONSE_BODY_MARKER = "Error POSTing to endpoint:";
const LEGACY_RESPONSE_BODY_RE = /Error POSTing to endpoint \(HTTP \d+\):/;

/** MCP lifecycle errors use the protocol code, including serialized SDK errors. */
export function isMcpRequestTimeoutError(error: unknown): boolean {
  return isRecord(error) && error.code === ErrorCode.RequestTimeout;
}

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

/** Classifies known transport and remote-auth failures without interpreting server text. */
export function isMcpServiceAvailabilityError(error: unknown): boolean {
  const visited = new Set<unknown>();
  const classify = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object" || visited.has(value) || depth > 4) {
      return false;
    }
    visited.add(value);
    const mcpCode: unknown = value instanceof McpError ? value.code : undefined;
    if (mcpCode === ErrorCode.ConnectionClosed || mcpCode === ErrorCode.RequestTimeout) {
      return true;
    }
    if (value instanceof StreamableHTTPError || value instanceof SseError) {
      const status = value.code;
      if (
        status === 401 ||
        status === 403 ||
        status === 408 ||
        status === 429 ||
        (typeof status === "number" && status >= 500 && status <= 599)
      ) {
        return true;
      }
    }
    if (isRecord(value)) {
      if (value.code === "MCP_CONNECT_TIMEOUT") {
        return true;
      }
      if (typeof value.code === "string" && NETWORK_ERROR_CODES.has(value.code)) {
        return true;
      }
      if (Array.isArray(value.errors)) {
        return (
          value.errors.length > 0 && value.errors.every((nested) => classify(nested, depth + 1))
        );
      }
      if (classify(value.cause, depth + 1)) {
        return true;
      }
    }
    return false;
  };
  return classify(error, 0);
}

/** Redacts MCP diagnostics, including response bodies the SDK includes in thrown errors. */
export function redactMcpDiagnosticError(error: unknown): string {
  let message = formatErrorMessage(error);
  const streamableIndex = message.indexOf(STREAMABLE_RESPONSE_BODY_MARKER);
  const legacyMatch = LEGACY_RESPONSE_BODY_RE.exec(message);
  const prefixEnd =
    streamableIndex >= 0
      ? streamableIndex + STREAMABLE_RESPONSE_BODY_MARKER.length
      : legacyMatch
        ? legacyMatch.index + legacyMatch[0].length
        : undefined;
  if (prefixEnd !== undefined) {
    message = `${message.slice(0, prefixEnd)} [redacted response body]`;
  }
  return redactToolPayloadText(redactSensitiveUrlLikeString(message));
}
