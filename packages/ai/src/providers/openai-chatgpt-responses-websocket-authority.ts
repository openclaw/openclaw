import type { AiTransportHost } from "../host.js";
import { resolveCodexWebSocketUrl } from "./openai-chatgpt-responses-protocol.js";

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";

export interface CodexWebSocketAuthority {
  transportHost: AiTransportHost;
  url: string;
  headers: Headers;
  normalizedHeaders: ReadonlyArray<readonly [string, string]>;
}

export function resolveCodexWebSocketAuthority(params: {
  transport: string;
  transportHost: AiTransportHost;
  baseUrl: string | undefined;
  headers: () => Headers;
}): CodexWebSocketAuthority | undefined {
  if (params.transport === "sse") {
    return undefined;
  }
  const headers = params.headers();
  return {
    transportHost: params.transportHost,
    url: resolveCodexWebSocketUrl(params.baseUrl),
    headers,
    normalizedHeaders: Array.from(headers.entries()).filter(([name]) => name !== "traceparent"),
  };
}

export function buildCodexWebSocketHeaders(baseHeaders: Headers, requestId: string): Headers {
  baseHeaders.delete("accept");
  baseHeaders.delete("content-type");
  baseHeaders.delete("OpenAI-Beta");
  baseHeaders.delete("openai-beta");
  baseHeaders.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
  baseHeaders.set("x-client-request-id", requestId);
  baseHeaders.set("session_id", requestId);
  return baseHeaders;
}

export function matchesCodexWebSocketAuthority(
  cached: CodexWebSocketAuthority,
  requested: CodexWebSocketAuthority,
): boolean {
  return (
    cached.transportHost === requested.transportHost &&
    cached.url === requested.url &&
    cached.normalizedHeaders.length === requested.normalizedHeaders.length &&
    cached.normalizedHeaders.every(
      ([name, value], index) =>
        name === requested.normalizedHeaders[index]?.[0] &&
        value === requested.normalizedHeaders[index]?.[1],
    )
  );
}
