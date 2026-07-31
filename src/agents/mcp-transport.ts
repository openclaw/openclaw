/**
 * MCP client transport factory.
 *
 * This module turns normalized MCP server config into stdio, SSE, or
 * streamable-HTTP SDK transports with OpenClaw auth, redirect, and logging rules.
 */
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logDebug } from "../logger.js";
import {
  appendUtf8Lines,
  createUtf8LineAccumulator,
  DEFAULT_MAX_PENDING_UTF8_LINE_BYTES,
  flushUtf8Line,
} from "../process/utf8-line-accumulator.js";
import { resolveMcpAuthProfileId, withMcpAuthProfileBearer } from "./mcp-auth-profile.js";
import {
  buildMcpHttpFetch,
  withoutMcpAuthorizationHeader,
  withSameOriginMcpHttpHeaders,
} from "./mcp-http-fetch.js";
import { withMcpOAuthBearer } from "./mcp-oauth-fetch.js";
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

// MCP servers may emit progress output without newlines. Keep the diagnostic tail
// bounded so one noisy server cannot grow the gateway heap indefinitely.
const MCP_STDERR_TRUNCATED_PREFIX = "[stderr line truncated] ";

function attachStderrLogging(serverName: string, transport: OpenClawStdioClientTransport) {
  const stderr = transport.stderr;
  if (!stderr || typeof stderr.on !== "function") {
    return undefined;
  }
  const lineAccumulator = createUtf8LineAccumulator();
  let detached = false;
  let finalized = false;
  const logLine = (line: string, truncated = false) => {
    const trimmed = `${truncated ? MCP_STDERR_TRUNCATED_PREFIX : ""}${line}`.trim();
    if (trimmed) {
      logDebug(`bundle-mcp:${serverName}: ${trimmed}`);
    }
  };
  const onData = (chunk: Buffer | string) => {
    for (const { line, truncated } of appendUtf8Lines({
      accumulator: lineAccumulator,
      chunk,
      maxLineBytes: DEFAULT_MAX_PENDING_UTF8_LINE_BYTES,
      maxPendingLineBytes: DEFAULT_MAX_PENDING_UTF8_LINE_BYTES,
      // MCP servers use CR and unterminated writes for live progress. Emit each
      // UTF-8-complete fragment so those diagnostics remain visible promptly.
      splitOnCarriageReturn: true,
      emitPending: true,
    })) {
      logLine(line, truncated);
    }
  };
  // Natural end covers MCP crashes; close is a fallback for abrupt stream teardown.
  // Explicit detach shares the same finalizer and removes listeners first.
  const finalize = () => {
    if (finalized) {
      return;
    }
    finalized = true;
    const trailing = flushUtf8Line(lineAccumulator, DEFAULT_MAX_PENDING_UTF8_LINE_BYTES);
    if (trailing) {
      logLine(trailing.line, trailing.truncated);
    }
  };
  stderr.on("data", onData);
  stderr.on("end", finalize);
  stderr.on("close", finalize);
  return () => {
    if (detached) {
      return;
    }
    detached = true;
    if (typeof stderr.off === "function") {
      stderr.off("data", onData);
      stderr.off("end", finalize);
      stderr.off("close", finalize);
    } else if (typeof stderr.removeListener === "function") {
      stderr.removeListener("data", onData);
      stderr.removeListener("end", finalize);
      stderr.removeListener("close", finalize);
    }
    finalize();
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
  options?: { cfg?: OpenClawConfig; agentDir?: string },
): ResolvedMcpTransport | null {
  const resolved = resolveMcpTransportConfig(serverName, rawServer);
  if (!resolved) {
    return null;
  }
  if (resolved.kind === "stdio") {
    const transport = new OpenClawStdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
      cwd: resolved.cwd,
      stderr: "pipe",
    });
    return {
      transport,
      description: resolved.description,
      transportType: "stdio",
      connectionTimeoutMs: resolved.connectionTimeoutMs,
      requestTimeoutMs: resolved.requestTimeoutMs,
      supportsParallelToolCalls: resolved.supportsParallelToolCalls,
      detachStderr: attachStderrLogging(serverName, transport),
    };
  }
  const authProfileId = resolveMcpAuthProfileId(rawServer);
  // The SDK reuses one fetch for OAuth and long-lived SSE/streamable bodies.
  // Per-RPC deadlines belong to client calls, not this transport fetch.
  const baseFetch = buildMcpHttpFetch({
    sslVerify: resolved.sslVerify,
    clientCert: resolved.clientCert,
    clientKey: resolved.clientKey,
    resourceUrl: resolved.url,
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
          // require the same routing headers. Cross-origin auth calls stay scrubbed.
          authFetchFn: resourceFetch,
          serverName,
          resourceUrl: resolved.url,
          config: resolved.oauth,
        })
      : baseFetch;
  if (resolved.transportType === "streamable-http") {
    return {
      transport: new StreamableHTTPClientTransport(new URL(resolved.url), {
        requestInit: resolved.auth === "oauth" || !headers ? undefined : { headers },
        fetch: httpFetch,
      }),
      description: resolved.description,
      transportType: "streamable-http",
      connectionTimeoutMs: resolved.connectionTimeoutMs,
      requestTimeoutMs: resolved.requestTimeoutMs,
      supportsParallelToolCalls: resolved.supportsParallelToolCalls,
    };
  }
  const sseHeaders: Record<string, string> = { ...headers };
  const hasHeaders = Object.keys(sseHeaders).length > 0;
  return {
    transport: new SSEClientTransport(new URL(resolved.url), {
      requestInit: resolved.auth === "oauth" || !hasHeaders ? undefined : { headers: sseHeaders },
      fetch: httpFetch,
      eventSourceInit: {
        fetch: buildSseEventSourceFetch(resolved.auth === "oauth" ? {} : sseHeaders, httpFetch),
      },
    }),
    description: resolved.description,
    transportType: "sse",
    connectionTimeoutMs: resolved.connectionTimeoutMs,
    requestTimeoutMs: resolved.requestTimeoutMs,
    supportsParallelToolCalls: resolved.supportsParallelToolCalls,
  };
}
