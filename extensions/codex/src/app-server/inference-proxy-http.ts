import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { Writable, type Duplex } from "node:stream";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { rejectWebSocketUpgrade } from "openclaw/plugin-sdk/websocket-runtime";
import { transportFailureReason } from "./inference-transport.js";

export const REQUEST_TIMEOUT_MS = 30_000;

export type CodexInferenceTransportStage =
  | "request"
  | "admission"
  | "prepare"
  | "authorization"
  | "upstream"
  | "response";

export function logInferenceTransportFailure(
  stage: CodexInferenceTransportStage,
  error: unknown,
  responseStarted: boolean,
): void {
  embeddedAgentLog.warn("codex inference HTTP relay failed", {
    stage,
    reason: transportFailureReason(error),
    responseStarted,
  });
}

const OVERLOADED = "Codex inference relay is busy; retry on a fresh connection.";
export const OVERLOAD_HEADERS = { "content-type": "application/json", "retry-after": "1" };
export const OVERLOAD_BODY = JSON.stringify({
  type: "error",
  status: 503,
  // Backend overload without retry advice is terminal; keep local saturation distinct and explicitly retryable.
  error: { type: "server_error", code: "inference_relay_busy", message: OVERLOADED },
  headers: { "retry-after": "1" },
});
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function rejectBusyUpgrade(socket: Duplex) {
  rejectWebSocketUpgrade(socket, {
    status: 503,
    headers: { "Retry-After": "1" },
    body: { contentType: "application/json", text: OVERLOAD_BODY },
  });
}

export function relayHeaders(input: IncomingHttpHeaders): Record<string, string> {
  const excluded = new Set(HOP_HEADERS);
  for (const token of (input.connection ?? "").split(",")) {
    excluded.add(token.trim().toLowerCase());
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !excluded.has(key.toLowerCase())) {
      output[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return output;
}

export function isCodexCatalogRequest(
  request: IncomingMessage,
  path: string,
  query: URLSearchParams,
): boolean {
  return (
    request.method === "GET" &&
    path === "/models" &&
    [...query.keys()].every((key) => key === "client_version") &&
    query.getAll("client_version").length <= 1 &&
    !request.headers["transfer-encoding"] &&
    (!request.headers["content-length"] || request.headers["content-length"] === "0")
  );
}

export function rejectUnsupportedHttpOperation(response: ServerResponse): void {
  // Native retries transport failures; unsupported operations cannot be fixed by retrying.
  response.writeHead(400, { "content-type": "application/json" }).end(
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "unsupported_relay_operation",
        message: "This operation is not supported by the Codex inference relay.",
      },
    }),
  );
}

/** Discovery retains native account headers and owns its guarded response through streaming. */
export async function relayCodexCatalogRequest(
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
  policy: Parameters<typeof fetchWithSsrFGuard>[0]["policy"],
  requestSignal: AbortSignal,
  assertCurrent: () => void,
): Promise<void> {
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const guarded = await fetchWithSsrFGuard({
    url: target.toString(),
    init: { method: "GET", headers: relayHeaders(request.headers), signal },
    signal,
    beforeRequest: assertCurrent,
    requireHttps: true,
    maxRedirects: 0,
    capture: false,
    mode: "trusted_env_proxy",
    policy,
    auditContext: "codex-parent-local-catalog",
  });
  try {
    assertCurrent();
    await relayHttpResponse(guarded.response, response, signal);
  } finally {
    await guarded.release().catch(() => undefined);
  }
}

export async function relayHttpResponse(
  upstream: Response,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  // Fetch decodes content encodings; never forward stale encoding/length headers.
  const headers = Object.fromEntries(upstream.headers);
  delete headers["content-encoding"];
  response.writeHead(upstream.status, relayHeaders(headers));
  if (upstream.body) {
    await upstream.body.pipeTo(Writable.toWeb(response), { signal });
  } else {
    response.end();
  }
}
