/**
 * Resolves MCP transport command, environment, and timeout configuration.
 */
import { redactSensitiveUrl } from "@openclaw/net-policy/redact-sensitive-url";
import {
  clampPositiveTimerTimeoutMs,
  resolvePositiveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveConfiguredMcpTransport } from "../config/mcp-config-normalize.js";
import { createDedupeCache } from "../infra/dedupe.js";
import { logWarn } from "../logger.js";
import { resolveHttpMcpServerLaunchConfig, type HttpMcpTransportType } from "./mcp-http.js";
import type { McpOAuthConfig } from "./mcp-oauth-provider.js";
import {
  describeStdioMcpServerLaunchConfig,
  resolveStdioMcpServerLaunchConfig,
} from "./mcp-stdio.js";

// Resolves raw MCP server config into the transport shape used by bundle MCP
// runtime startup. Stdio is preferred when launch config is valid; otherwise
// HTTP/SSE transports are attempted with normalized timeout fields.
type ResolvedBaseMcpTransportConfig = {
  description: string;
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  supportsParallelToolCalls: boolean;
};

type ResolvedStdioMcpTransportConfig = ResolvedBaseMcpTransportConfig & {
  kind: "stdio";
  transportType: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

type ResolvedMcpOAuthConfig = McpOAuthConfig & {
  identity?: "shared" | "per-requester";
  authProfileId?: unknown;
};

export type ResolvedHttpMcpTransportConfig = ResolvedBaseMcpTransportConfig & {
  kind: "http";
  transportType: HttpMcpTransportType;
  url: string;
  headers?: Record<string, string>;
  auth?: "oauth";
  oauth?: ResolvedMcpOAuthConfig;
  sslVerify?: boolean;
  clientCert?: string;
  clientKey?: string;
};

type ResolvedMcpTransportConfig = ResolvedStdioMcpTransportConfig | ResolvedHttpMcpTransportConfig;

const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_WARNED_DROPPED_STDIO_ENV_KEYS = 4096;
// Warning state spans repeated MCP transport resolutions in one gateway process;
// bounding it means evicted server/env pairs can re-warn instead of growing unbounded.
const warnedDroppedStdioEnvKeys = createDedupeCache({
  ttlMs: 0,
  maxSize: MAX_WARNED_DROPPED_STDIO_ENV_KEYS,
});

function warnDroppedStdioEnvOnce(serverName: string, key: string): void {
  const logServerName = sanitizeForLog(serverName);
  const logKey = sanitizeForLog(key);
  if (warnedDroppedStdioEnvKeys.check(JSON.stringify([serverName, key]))) {
    return;
  }
  logWarn(
    `bundle-mcp: server "${logServerName}": env "${logKey}" is blocked for stdio startup safety and was ignored.`,
  );
}

function getConnectionTimeoutMs(rawServer: unknown): number {
  return resolvePositiveTimerTimeoutMs(
    asOptionalObjectRecord(rawServer)?.connectionTimeoutMs,
    DEFAULT_CONNECTION_TIMEOUT_MS,
  );
}

export function resolveMcpRequestTimeoutMs(
  rawServer: unknown,
  fallbackMs = DEFAULT_REQUEST_TIMEOUT_MS,
): number {
  return (
    clampPositiveTimerTimeoutMs(asOptionalObjectRecord(rawServer)?.requestTimeoutMs) ??
    resolvePositiveTimerTimeoutMs(fallbackMs, DEFAULT_REQUEST_TIMEOUT_MS)
  );
}

function getBooleanField(rawServer: unknown, key: string): boolean | undefined {
  const value = asOptionalObjectRecord(rawServer)?.[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Resolve one MCP server's launch transport config, or null when unsupported. */
export function resolveMcpTransportConfig(
  serverName: string,
  rawServer: unknown,
  options?: { logWarnings?: boolean },
): ResolvedMcpTransportConfig | null {
  const logWarnings = options?.logWarnings !== false;
  const effectiveTransport = resolveConfiguredMcpTransport(rawServer);
  const stdioLaunch = resolveStdioMcpServerLaunchConfig(
    rawServer,
    logWarnings
      ? {
          onDroppedEnv: (key: string) => {
            warnDroppedStdioEnvOnce(serverName, key);
          },
        }
      : undefined,
  );
  if (stdioLaunch.ok) {
    // A command-bearing server is always treated as stdio even when HTTP-ish
    // aliases are present, matching existing MCP config precedence.
    return {
      kind: "stdio",
      transportType: "stdio",
      command: stdioLaunch.config.command,
      args: stdioLaunch.config.args,
      env: stdioLaunch.config.env,
      cwd: stdioLaunch.config.cwd,
      description: describeStdioMcpServerLaunchConfig(stdioLaunch.config),
      connectionTimeoutMs: getConnectionTimeoutMs(rawServer),
      requestTimeoutMs: resolveMcpRequestTimeoutMs(rawServer),
      supportsParallelToolCalls: getBooleanField(rawServer, "supportsParallelToolCalls") ?? false,
    };
  }

  if (
    effectiveTransport &&
    effectiveTransport !== "sse" &&
    effectiveTransport !== "streamable-http"
  ) {
    if (logWarnings) {
      logWarn(
        `bundle-mcp: skipped server "${sanitizeForLog(serverName)}" because transport "${sanitizeForLog(effectiveTransport)}" is not supported.`,
      );
    }
    return null;
  }

  const transportType = effectiveTransport === "streamable-http" ? "streamable-http" : "sse";
  const launch = resolveHttpMcpServerLaunchConfig(
    rawServer,
    logWarnings
      ? {
          transportType,
          onDroppedHeader: (key: string) => {
            logWarn(
              `bundle-mcp: server "${serverName}": header "${key}" has an unsupported value type and was ignored.`,
            );
          },
          onMalformedHeaders: () => {
            logWarn(
              `bundle-mcp: server "${serverName}": "headers" must be a JSON object; the value was ignored.`,
            );
          },
        }
      : { transportType },
  );
  if (!launch.ok) {
    if (logWarnings) {
      logWarn(
        `bundle-mcp: skipped server "${sanitizeForLog(serverName)}" because ${stdioLaunch.reason} and ${launch.reason}.`,
      );
    }
    return null;
  }
  const record = asOptionalObjectRecord(rawServer);
  const oauth = record?.oauth;
  const sslVerify = getBooleanField(rawServer, "sslVerify");
  const clientCert = normalizeOptionalString(record?.clientCert);
  const clientKey = normalizeOptionalString(record?.clientKey);
  return {
    kind: "http",
    transportType: launch.config.transportType,
    url: launch.config.url,
    headers: launch.config.headers,
    ...(record?.auth === "oauth" ? { auth: "oauth" as const } : {}),
    ...(isRecord(oauth) ? { oauth: oauth as ResolvedMcpOAuthConfig } : {}),
    ...(sslVerify !== undefined ? { sslVerify } : {}),
    ...(clientCert ? { clientCert } : {}),
    ...(clientKey ? { clientKey } : {}),
    description: redactSensitiveUrl(launch.config.url),
    connectionTimeoutMs: getConnectionTimeoutMs(rawServer),
    requestTimeoutMs: resolveMcpRequestTimeoutMs(rawServer),
    supportsParallelToolCalls: getBooleanField(rawServer, "supportsParallelToolCalls") ?? false,
  };
}
