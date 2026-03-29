import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { logDebug, logWarn } from "../logger.js";
import { describeSseMcpServerLaunchConfig, resolveSseMcpServerLaunchConfig } from "./mcp-sse.js";
import {
  describeStdioMcpServerLaunchConfig,
  resolveStdioMcpServerLaunchConfig,
} from "./mcp-stdio.js";

export type ResolvedMcpTransport = {
  transport: Transport;
  description: string;
  transportType: "stdio" | "sse" | "streamable-http";
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

function buildSseEventSourceFetch(headers: Record<string, string>) {
  return (url: string | URL, init?: RequestInit) => {
    const sdkHeaders: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          sdkHeaders[key] = value;
        });
      } else {
        Object.assign(sdkHeaders, init.headers);
      }
    }
    return fetch(url, {
      ...init,
      headers: { ...sdkHeaders, ...headers },
    });
  };
}

function resolveSseTransport(serverName: string, rawServer: unknown): ResolvedMcpTransport | null {
  const sseLaunch = resolveSseMcpServerLaunchConfig(rawServer, {
    onDroppedHeader: (key) => {
      logWarn(
        `bundle-mcp: server "${serverName}": header "${key}" has an unsupported value type and was ignored.`,
      );
    },
    onMalformedHeaders: () => {
      logWarn(
        `bundle-mcp: server "${serverName}": "headers" must be a JSON object; the value was ignored.`,
      );
    },
  });
  if (!sseLaunch.ok) {
    return null;
  }
  const headers: Record<string, string> = {
    ...sseLaunch.config.headers,
  };
  const hasHeaders = Object.keys(headers).length > 0;
  return {
    transport: new SSEClientTransport(new URL(sseLaunch.config.url), {
      requestInit: hasHeaders ? { headers } : undefined,
      eventSourceInit: hasHeaders ? { fetch: buildSseEventSourceFetch(headers) } : undefined,
    }),
    description: describeSseMcpServerLaunchConfig(sseLaunch.config),
    transportType: "sse",
  };
}

function resolveStreamableHttpTransport(
  serverName: string,
  rawServer: unknown,
): ResolvedMcpTransport | null {
  const launch = resolveSseMcpServerLaunchConfig(rawServer, {
    onDroppedHeader: (key) => {
      logWarn(
        `bundle-mcp: server "${serverName}": header "${key}" has an unsupported value type and was ignored.`,
      );
    },
    onMalformedHeaders: () => {
      logWarn(
        `bundle-mcp: server "${serverName}": "headers" must be a JSON object; the value was ignored.`,
      );
    },
  });
  if (!launch.ok) {
    return null;
  }
  return {
    transport: new StreamableHTTPClientTransport(new URL(launch.config.url), {
      requestInit: launch.config.headers ? { headers: launch.config.headers } : undefined,
    }),
    description: describeSseMcpServerLaunchConfig(launch.config),
    transportType: "streamable-http",
  };
}

export function resolveMcpTransport(
  serverName: string,
  rawServer: unknown,
): ResolvedMcpTransport | null {
  const requestedTransport =
    rawServer &&
    typeof rawServer === "object" &&
    typeof (rawServer as { transport?: unknown }).transport === "string"
      ? ((rawServer as { transport?: string }).transport ?? "").trim().toLowerCase()
      : "";
  const stdioLaunch = resolveStdioMcpServerLaunchConfig(rawServer);
  if (stdioLaunch.ok) {
    const transport = new StdioClientTransport({
      command: stdioLaunch.config.command,
      args: stdioLaunch.config.args,
      env: stdioLaunch.config.env,
      cwd: stdioLaunch.config.cwd,
      stderr: "pipe",
    });
    return {
      transport,
      description: describeStdioMcpServerLaunchConfig(stdioLaunch.config),
      transportType: "stdio",
      detachStderr: attachStderrLogging(serverName, transport),
    };
  }

  if (
    requestedTransport &&
    requestedTransport !== "sse" &&
    requestedTransport !== "streamable-http"
  ) {
    logWarn(
      `bundle-mcp: skipped server "${serverName}" because transport "${requestedTransport}" is not supported.`,
    );
    return null;
  }

  if (requestedTransport === "streamable-http") {
    const httpTransport = resolveStreamableHttpTransport(serverName, rawServer);
    if (httpTransport) {
      return httpTransport;
    }
  }

  const sseTransport = resolveSseTransport(serverName, rawServer);
  if (sseTransport) {
    return sseTransport;
  }

  const sseLaunch = resolveSseMcpServerLaunchConfig(rawServer);
  const sseReason = sseLaunch.ok ? "not an SSE server" : sseLaunch.reason;
  logWarn(
    `bundle-mcp: skipped server "${serverName}" because ${stdioLaunch.reason} and ${sseReason}.`,
  );
  return null;
}
