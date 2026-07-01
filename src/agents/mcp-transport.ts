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
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { substituteString, containsEnvVarReference } from "../config/env-substitution.js";
import { isDangerousHostEnvVarName } from "../infra/host-env-security.js";
import { logDebug } from "../logger.js";
import {
  buildMcpHttpFetch,
  withoutMcpAuthorizationHeader,
  withSameOriginMcpHttpHeaders,
} from "./mcp-http-fetch.js";
import { createMcpOAuthClientProvider } from "./mcp-oauth.js";
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
  if (!stderr || typeof stderr.on !== "function") {
    return undefined;
  }
  const onData = (chunk: Buffer | string) => {
    const message =
      normalizeOptionalString(typeof chunk === "string" ? chunk : String(chunk)) ?? "";
    if (!message) {
      return;
    }
    for (const line of message.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        logDebug(`bundle-mcp:${serverName}: ${trimmed}`);
      }
    }
  };
  stderr.on("data", onData);
  return () => {
    if (typeof stderr.off === "function") {
      stderr.off("data", onData);
    } else if (typeof stderr.removeListener === "function") {
      stderr.removeListener("data", onData);
    }
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
): ResolvedMcpTransport | null {
  const resolved = resolveMcpTransportConfig(serverName, rawServer);
  if (!resolved) {
    return null;
  }
  if (resolved.kind === "stdio") {
    const processEnv = process.env;
    const finalEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(resolved.env || {})) {
      if (isDangerousHostEnvVarName(key)) {
        throw new Error(
          `Dynamic environment variable substitution generated a dangerous host environment variable: ${key}`,
        );
      }
      finalEnv[key] =
        value && containsEnvVarReference(value)
          ? substituteString(value, processEnv, "mcp.servers.*.env")
          : value;
    }

    const transport = new OpenClawStdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: finalEnv,
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
  const authProvider =
    resolved.auth === "oauth"
      ? createMcpOAuthClientProvider({
          serverName,
          serverUrl: resolved.url,
          config: resolved.oauth,
        })
      : undefined;
  const headers =
    resolved.auth === "oauth" ? withoutMcpAuthorizationHeader(resolved.headers) : resolved.headers;

  const baseFetch = buildMcpHttpFetch({
    sslVerify: resolved.sslVerify,
    clientCert: resolved.clientCert,
    clientKey: resolved.clientKey,
    resourceUrl: resolved.url,
  });

  const substitutingFetch: FetchLike = (url, init) => {
    let finalInit = init;
    if (init?.headers) {
      const mergedHeaders = new Headers(init.headers);
      let needsReplace = false;
      const processEnv = process.env;
      for (const [key, value] of mergedHeaders.entries()) {
        if (value && containsEnvVarReference(value)) {
          mergedHeaders.set(key, substituteString(value, processEnv, "mcp.servers.*.headers"));
          needsReplace = true;
        }
      }
      if (needsReplace) {
        // We reconstruct as a plain object to avoid surprising any fetch polyfills or assertions
        // that expect a plain object, particularly in tests.
        const plainHeaders: Record<string, string> = {};
        for (const [key, value] of mergedHeaders.entries()) {
          plainHeaders[key] = value;
        }
        finalInit = { ...init, headers: plainHeaders };
      }
    }
    return baseFetch(url, finalInit);
  };

  const httpFetch =
    resolved.auth === "oauth"
      ? withSameOriginMcpHttpHeaders({
          fetchFn: substitutingFetch,
          headers,
          resourceUrl: resolved.url,
        })
      : substitutingFetch;

  if (resolved.transportType === "streamable-http") {
    return {
      transport: new StreamableHTTPClientTransport(new URL(resolved.url), {
        requestInit: resolved.auth === "oauth" || !headers ? undefined : { headers },
        fetch: httpFetch,
        authProvider,
      }),
      description: resolved.description,
      transportType: "streamable-http",
      connectionTimeoutMs: resolved.connectionTimeoutMs,
      requestTimeoutMs: resolved.requestTimeoutMs,
      supportsParallelToolCalls: resolved.supportsParallelToolCalls,
    };
  }

  const sseHeaders = headers ? { ...headers } : {};
  if (resolved.auth === "oauth" && sseHeaders.authorization) {
    delete sseHeaders.authorization;
  }

  return {
    transport: new SSEClientTransport(new URL(resolved.url), {
      requestInit: resolved.auth === "oauth" || !headers ? undefined : { headers },
      fetch: httpFetch,
      eventSourceInit: {
        fetch: buildSseEventSourceFetch(resolved.auth === "oauth" ? {} : sseHeaders, httpFetch),
      },
      authProvider,
    }),
    description: resolved.description,
    transportType: "sse",
    connectionTimeoutMs: resolved.connectionTimeoutMs,
    requestTimeoutMs: resolved.requestTimeoutMs,
    supportsParallelToolCalls: resolved.supportsParallelToolCalls,
  };
}
