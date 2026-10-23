/**
 * MCP client transport factory.
 *
 * This module turns normalized MCP server config into stdio, SSE, or
 * streamable-HTTP SDK transports with OpenClaw auth, redirect, and logging rules.
 */
import type { SSEClientTransportOptions, FetchLike, Transport } from "@modelcontextprotocol/client";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logDebug } from "../logger.js";
import type { SessionMcpRequesterScope } from "./agent-bundle-mcp-types.js";
import { resolveMcpAuthProfileId, withMcpAuthProfileBearer } from "./mcp-auth-profile.js";
import {
  buildMcpHttpFetch,
  buildMcpOAuthHttpFetch,
  withoutMcpAuthorizationHeader,
  withSameOriginMcpHttpHeaders,
} from "./mcp-http-fetch.js";
import {
  OpenClawSSEClientTransport,
  OpenClawStreamableHTTPClientTransport,
} from "./mcp-http-transport.js";
import { withMcpOAuthBearer } from "./mcp-oauth-fetch.js";
import { operatorMcpOAuthIdentity, requesterMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

type ResolvedMcpTransport = {
  transport: Transport;
  description: string;
  transportType: "stdio" | "sse" | "streamable-http";
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  supportsParallelToolCalls: boolean;
  detachStderr?: () => void;
};

function attachStderrLogging(serverName: string, transport: OpenClawStdioClientTransport) {
  const stderr = transport.stderr;
  let reported = false;
  const onData = () => {
    if (!reported) {
      reported = true;
      // External server output can contain message text or tool arguments.
      logDebug(`bundle-mcp:${serverName}: stderr output omitted`);
    }
  };
  // Keep consuming after the notice so stderr cannot block the server's shutdown.
  stderr.on("data", onData);
  return () => {
    stderr.off("data", onData);
  };
}

type SseEventSourceFetch = NonNullable<
  NonNullable<SSEClientTransportOptions["eventSourceInit"]>["fetch"]
>;

function buildSseEventSourceFetch(
  headers: Record<string, string>,
  baseFetch: FetchLike,
): SseEventSourceFetch {
  return (url: string | URL, init?: RequestInit) => {
    // Header names are case-insensitive, but object spreads preserve case
    // variants and can duplicate Authorization on the wire. Normalize before
    // merging so operator headers override SDK headers as a single entry.
    const mergedHeaders: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers)) {
      mergedHeaders[key.toLowerCase()] = value;
    }
    for (const [key, value] of Object.entries(headers)) {
      mergedHeaders[key.toLowerCase()] = value;
    }
    return baseFetch(url, {
      ...(init as RequestInit),
      headers: mergedHeaders,
    }) as ReturnType<SseEventSourceFetch>;
  };
}

/** Resolves a configured MCP server into a live SDK transport instance. */
export function resolveMcpTransport(
  serverName: string,
  rawServer: unknown,
  options?: {
    cfg?: OpenClawConfig;
    agentDir?: string;
    prepareDataDir?: string;
    requesterScope?: SessionMcpRequesterScope;
    /** Protocol-owned headers for a single stateless request, not credential overrides. */
    requestHeaders?: Record<string, string>;
    /** Recheck the owning operation after asynchronous auth and before HTTP effects. */
    beforeRequest?: () => void;
  },
): ResolvedMcpTransport | null {
  const resolved = resolveMcpTransportConfig(serverName, rawServer);
  if (!resolved) {
    return null;
  }
  const metadata = {
    description: resolved.description,
    transportType: resolved.transportType,
    connectionTimeoutMs: resolved.connectionTimeoutMs,
    requestTimeoutMs: resolved.requestTimeoutMs,
    supportsParallelToolCalls: resolved.supportsParallelToolCalls,
  };
  if (resolved.kind === "stdio") {
    const transport = new OpenClawStdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
      cwd: resolved.cwd,
      prepareDataDir: options?.prepareDataDir,
    });
    return {
      transport,
      ...metadata,
      detachStderr: attachStderrLogging(serverName, transport),
    };
  }
  const authProfileId = resolveMcpAuthProfileId(rawServer);
  const requesterScope = options?.requesterScope;
  let oauthIdentity;
  if (resolved.oauth?.identity === "per-requester") {
    if (!requesterScope) {
      return null;
    }
    oauthIdentity = requesterMcpOAuthIdentity(serverName, resolved.url, requesterScope);
  } else {
    oauthIdentity = operatorMcpOAuthIdentity(serverName, resolved.url, options?.cfg);
  }
  // The SDK reuses one fetch for OAuth and long-lived SSE/streamable bodies.
  // Per-RPC deadlines belong to client calls, not this transport fetch.
  const baseFetch = buildMcpHttpFetch({
    sslVerify: resolved.sslVerify,
    clientCert: resolved.clientCert,
    clientKey: resolved.clientKey,
    resourceUrl: resolved.url,
    requestTimeoutMs: resolved.requestTimeoutMs,
    beforeRequest: options?.beforeRequest,
  });
  const headers =
    resolved.auth === "oauth" || authProfileId
      ? withoutMcpAuthorizationHeader(resolved.headers)
      : resolved.headers;
  const resourceFetch = withSameOriginMcpHttpHeaders({
    fetchFn: baseFetch,
    headers,
    resourceUrl: resolved.url,
  });
  const httpFetch = authProfileId
    ? withMcpAuthProfileBearer({
        fetchFn: baseFetch,
        serverName,
        resourceUrl: resolved.url,
        headers,
        authProfileId,
        cfg: options?.cfg,
        agentDir: options?.agentDir,
      })
    : resolved.auth === "oauth"
      ? withMcpOAuthBearer({
          fetchFn: resourceFetch,
          // Protected-resource discovery lives at the resource origin and may
          // require the same routing headers. Resource requests intentionally retain
          // redirect-body replay for MCP compatibility, while credential-bearing
          // auth redirects use the stricter fail-closed policy.
          authFetchFn: buildMcpOAuthHttpFetch({
            sslVerify: resolved.sslVerify,
            clientCert: resolved.clientCert,
            clientKey: resolved.clientKey,
            resourceUrl: resolved.url,
            timeoutMs: resolved.requestTimeoutMs,
            beforeRequest: options?.beforeRequest,
            headers,
          }),
          identity: oauthIdentity,
          config: resolved.oauth,
        })
      : baseFetch;
  if (resolved.transportType === "streamable-http") {
    let requestInit: RequestInit | undefined =
      resolved.auth === "oauth" || !headers ? undefined : { headers };
    if (options?.requestHeaders) {
      const requestHeaders = new Headers(requestInit?.headers);
      for (const [name, value] of Object.entries(options.requestHeaders)) {
        requestHeaders.set(name, value);
      }
      requestInit = { headers: requestHeaders };
    }
    return {
      transport: new OpenClawStreamableHTTPClientTransport(new URL(resolved.url), {
        requestInit,
        fetch: httpFetch,
      }),
      ...metadata,
    };
  }
  const sseHeaders: Record<string, string> = { ...headers };
  const hasHeaders = Object.keys(sseHeaders).length > 0;
  return {
    transport: new OpenClawSSEClientTransport(new URL(resolved.url), {
      requestInit: resolved.auth === "oauth" || !hasHeaders ? undefined : { headers: sseHeaders },
      fetch: httpFetch,
      eventSourceInit: {
        fetch: buildSseEventSourceFetch(resolved.auth === "oauth" ? {} : sseHeaders, httpFetch),
      },
    }),
    ...metadata,
  };
}
