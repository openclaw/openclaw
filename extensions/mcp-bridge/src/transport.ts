import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "./types.js";

export function createTransport(server: McpServerConfig): Transport {
  switch (server.type) {
    case "stdio":
      return new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: server.env
          ? (Object.fromEntries(
              Object.entries({ ...process.env, ...server.env }).filter(
                (e): e is [string, string] => e[1] != null,
              ),
            ) as Record<string, string>)
          : undefined,
        cwd: server.cwd,
      });

    case "sse":
      return new SSEClientTransport(new URL(server.url), {
        requestInit: server.headers ? { headers: server.headers } : undefined,
      });

    case "http":
      return new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: server.headers ? { headers: server.headers } : undefined,
      });
  }
}

/**
 * Try Streamable HTTP first; fall back to SSE when the server rejects it.
 * Only applies to `type: "http"` servers since those may run either protocol.
 */
export async function createTransportWithFallback(
  server: McpServerConfig,
): Promise<{ transport: Transport; actualType: string }> {
  if (server.type !== "http") {
    return { transport: createTransport(server), actualType: server.type };
  }

  const reqInit = server.headers ? { headers: server.headers } : undefined;

  try {
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: reqInit,
    });
    return { transport, actualType: "streamable-http" };
  } catch {
    const transport = new SSEClientTransport(new URL(server.url), {
      requestInit: reqInit,
    });
    return { transport, actualType: "sse-fallback" };
  }
}
