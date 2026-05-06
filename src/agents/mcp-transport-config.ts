import { resolveOpenClawMcpTransportAlias } from "../config/mcp-config-normalize.js";
import { logWarn } from "../logger.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import {
  describeHttpMcpServerLaunchConfig,
  resolveHttpMcpServerLaunchConfig,
  type HttpMcpTransportType,
} from "./mcp-http.js";
import {
  describeStdioMcpServerLaunchConfig,
  resolveStdioMcpServerLaunchConfig,
} from "./mcp-stdio.js";

type ResolvedBaseMcpTransportConfig = {
  description: string;
  connectionTimeoutMs: number;
  /** Per-call request timeout. See `getRequestTimeoutMs` for the fallback rules. */
  requestTimeoutMs: number;
};

type ResolvedStdioMcpTransportConfig = ResolvedBaseMcpTransportConfig & {
  kind: "stdio";
  transportType: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

type ResolvedHttpMcpTransportConfig = ResolvedBaseMcpTransportConfig & {
  kind: "http";
  transportType: HttpMcpTransportType;
  url: string;
  headers?: Record<string, string>;
};

type ResolvedMcpTransportConfig = ResolvedStdioMcpTransportConfig | ResolvedHttpMcpTransportConfig;

const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
// MCP SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC` (60s, see @modelcontextprotocol/sdk
// `protocol.ts`). When the operator has not explicitly set
// `connectionTimeoutMs`, fall back to this value for per-call request
// timeouts so unconfigured servers keep the SDK's existing 60s budget for
// tools that legitimately run 30–60s.
const MCP_SDK_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function readExplicitConnectionTimeoutMs(rawServer: unknown): number | undefined {
  if (
    rawServer &&
    typeof rawServer === "object" &&
    typeof (rawServer as { connectionTimeoutMs?: unknown }).connectionTimeoutMs === "number" &&
    (rawServer as { connectionTimeoutMs: number }).connectionTimeoutMs > 0
  ) {
    return (rawServer as { connectionTimeoutMs: number }).connectionTimeoutMs;
  }
  return undefined;
}

function getConnectionTimeoutMs(rawServer: unknown): number {
  return readExplicitConnectionTimeoutMs(rawServer) ?? DEFAULT_CONNECTION_TIMEOUT_MS;
}

/**
 * Per-call MCP request timeout. When `connectionTimeoutMs` is explicitly
 * configured, the operator's value applies to both the initial handshake and
 * individual tool calls. When it is unset, request timeouts fall back to the
 * MCP SDK's 60s default (rather than OpenClaw's 30s connection default), so
 * existing unconfigured servers keep the prior per-call budget. (#60967)
 */
function getRequestTimeoutMs(rawServer: unknown): number {
  return readExplicitConnectionTimeoutMs(rawServer) ?? MCP_SDK_DEFAULT_REQUEST_TIMEOUT_MS;
}

function getRequestedTransport(rawServer: unknown): string {
  if (
    !rawServer ||
    typeof rawServer !== "object" ||
    typeof (rawServer as { transport?: unknown }).transport !== "string"
  ) {
    return "";
  }
  return normalizeLowercaseStringOrEmpty((rawServer as { transport?: string }).transport);
}

function getRequestedTransportAlias(rawServer: unknown): HttpMcpTransportType | "" {
  if (
    !rawServer ||
    typeof rawServer !== "object" ||
    typeof (rawServer as { type?: unknown }).type !== "string"
  ) {
    return "";
  }
  return resolveOpenClawMcpTransportAlias((rawServer as { type?: string }).type) ?? "";
}

function resolveHttpTransportConfig(
  serverName: string,
  rawServer: unknown,
  transportType: HttpMcpTransportType,
): ResolvedHttpMcpTransportConfig | null {
  const launch = resolveHttpMcpServerLaunchConfig(rawServer, {
    transportType,
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
    kind: "http",
    transportType: launch.config.transportType,
    url: launch.config.url,
    headers: launch.config.headers,
    description: describeHttpMcpServerLaunchConfig(launch.config),
    connectionTimeoutMs: getConnectionTimeoutMs(rawServer),
    requestTimeoutMs: getRequestTimeoutMs(rawServer),
  };
}

export function resolveMcpTransportConfig(
  serverName: string,
  rawServer: unknown,
): ResolvedMcpTransportConfig | null {
  const logServerName = sanitizeForLog(serverName);
  const requestedTransport = getRequestedTransport(rawServer);
  const requestedTransportAlias = requestedTransport ? "" : getRequestedTransportAlias(rawServer);
  const effectiveTransport = requestedTransport || requestedTransportAlias;
  const stdioLaunch = resolveStdioMcpServerLaunchConfig(rawServer, {
    onDroppedEnv: (key) => {
      logWarn(
        `bundle-mcp: server "${logServerName}": env "${sanitizeForLog(key)}" is blocked for stdio startup safety and was ignored.`,
      );
    },
  });
  if (stdioLaunch.ok) {
    return {
      kind: "stdio",
      transportType: "stdio",
      command: stdioLaunch.config.command,
      args: stdioLaunch.config.args,
      env: stdioLaunch.config.env,
      cwd: stdioLaunch.config.cwd,
      description: describeStdioMcpServerLaunchConfig(stdioLaunch.config),
      connectionTimeoutMs: getConnectionTimeoutMs(rawServer),
      requestTimeoutMs: getRequestTimeoutMs(rawServer),
    };
  }

  if (
    effectiveTransport &&
    effectiveTransport !== "sse" &&
    effectiveTransport !== "streamable-http"
  ) {
    logWarn(
      `bundle-mcp: skipped server "${logServerName}" because transport "${sanitizeForLog(effectiveTransport)}" is not supported.`,
    );
    return null;
  }

  if (effectiveTransport === "streamable-http") {
    const httpTransport = resolveHttpTransportConfig(serverName, rawServer, "streamable-http");
    if (httpTransport) {
      return httpTransport;
    }
  }

  const sseTransport = resolveHttpTransportConfig(serverName, rawServer, "sse");
  if (sseTransport) {
    return sseTransport;
  }

  const httpLaunch = resolveHttpMcpServerLaunchConfig(rawServer);
  const httpReason = httpLaunch.ok ? "not an HTTP MCP server" : httpLaunch.reason;
  logWarn(
    `bundle-mcp: skipped server "${logServerName}" because ${stdioLaunch.reason} and ${httpReason}.`,
  );
  return null;
}
