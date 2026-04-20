import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { DiagnosticsConfig } from "../config/types.base.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

const DEFAULT_SESSION_ID_HEADER = "x-session-id";
const DEFAULT_SESSION_NAME_HEADER = "x-session-name";

export function resolveSessionTracingHeaders(params: {
  sessionKey?: string;
  diagnostics?: DiagnosticsConfig;
}): Record<string, string> | undefined {
  const tracing = params.diagnostics?.sessionTracing;
  if (!tracing?.enabled) return undefined;

  const sessionKey = params.sessionKey;
  if (!sessionKey) return undefined;

  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) return undefined;

  const headers: Record<string, string> = {};

  // Use configured header names or defaults
  const sessionIdHeader = tracing.headers?.sessionId ?? DEFAULT_SESSION_ID_HEADER;
  const sessionNameHeader = tracing.headers?.sessionName ?? DEFAULT_SESSION_NAME_HEADER;

  // x-session-id: the full session key
  headers[sessionIdHeader] = sessionKey;

  // x-session-name: configured value, or derive from agent ID
  const sessionName = tracing.sessionName ?? parsed.agentId;
  headers[sessionNameHeader] = sessionName;

  return headers;
}

export function wrapStreamFnWithSessionTracing(params: {
  streamFn: StreamFn;
  sessionKey?: string;
  diagnostics?: DiagnosticsConfig;
}): StreamFn {
  const tracingHeaders = resolveSessionTracingHeaders({
    sessionKey: params.sessionKey,
    diagnostics: params.diagnostics,
  });
  if (!tracingHeaders) return params.streamFn;

  const inner = params.streamFn;
  return (model, context, options) => {
    const mergedHeaders = options?.headers
      ? { ...tracingHeaders, ...options.headers }
      : tracingHeaders;
    return inner(model, context, { ...options, headers: mergedHeaders });
  };
}
