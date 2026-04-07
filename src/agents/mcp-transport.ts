import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { logDebug } from "../logger.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

export type ResolvedMcpTransport = {
  transport: Transport;
  description: string;
  transportType: "stdio" | "sse" | "streamable-http";
  connectionTimeoutMs: number;
  auth?: "oauth";
  detachStderr?: () => void;
};

function attachStderrLogging(serverName: string, transport: StdioClientTransport) {
  const stderr = transport.stderr;
  if (!stderr || typeof stderr.on !== "function") {
    return undefined;
  }
  const onData = (chunk: Buffer | string) => {
    const message = String(chunk).trim();
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

function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) {
    return normalized;
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      normalized[key] = value;
    }
    return normalized;
  }
  return { ...headers };
}

function buildSseEventSourceFetch(headers: Record<string, string>) {
  return (url: string | URL, init?: RequestInit) => {
    const sdkHeaders = toHeaderRecord(init?.headers);
    return fetch(url, {
      ...init,
      headers: { ...sdkHeaders, ...headers },
    });
  };
}

export function resolveMcpTransport(
  serverName: string,
  rawServer: unknown,
  options?: { authProvider?: OAuthClientProvider },
): ResolvedMcpTransport | null {
  const resolved = resolveMcpTransportConfig(serverName, rawServer);
  if (!resolved) {
    return null;
  }
  if (resolved.kind === "stdio") {
    const transport = new StdioClientTransport({
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
      detachStderr: attachStderrLogging(serverName, transport),
    };
  }

  const authProvider = resolved.auth === "oauth" ? options?.authProvider : undefined;

  if (resolved.transportType === "streamable-http") {
    return {
      transport: new StreamableHTTPClientTransport(new URL(resolved.url), {
        authProvider,
        requestInit: resolved.headers ? { headers: resolved.headers } : undefined,
      }),
      description: resolved.description,
      transportType: "streamable-http",
      connectionTimeoutMs: resolved.connectionTimeoutMs,
      auth: resolved.auth,
    };
  }
  const headers: Record<string, string> = {
    ...resolved.headers,
  };
  const hasHeaders = Object.keys(headers).length > 0;
  return {
    transport: new SSEClientTransport(new URL(resolved.url), {
      authProvider,
      requestInit: hasHeaders ? { headers } : undefined,
      eventSourceInit: hasHeaders ? { fetch: buildSseEventSourceFetch(headers) } : undefined,
    }),
    description: resolved.description,
    transportType: "sse",
    connectionTimeoutMs: resolved.connectionTimeoutMs,
    auth: resolved.auth,
  };
}
