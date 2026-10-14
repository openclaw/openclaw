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
  type StdioMcpServerLaunchConfig,
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

type ResolvedStdioMcpTransportConfig = ResolvedBaseMcpTransportConfig &
  StdioMcpServerLaunchConfig & { kind: "stdio"; transportType: "stdio" };

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

export function resolveMcpRequestTimeoutMs(
  rawServer: unknown,
  fallbackMs = DEFAULT_REQUEST_TIMEOUT_MS,
): number {
  return (
    clampPositiveTimerTimeoutMs(asOptionalObjectRecord(rawServer)?.requestTimeoutMs) ??
    resolvePositiveTimerTimeoutMs(fallbackMs, DEFAULT_REQUEST_TIMEOUT_MS)
  );
}

/** Resolve one MCP server's launch transport config, or null when unsupported. */
export function resolveMcpTransportConfig(
  serverName: string,
  rawServer: unknown,
  options?: { logWarnings?: boolean },
): ResolvedMcpTransportConfig | null {
  const record = asOptionalObjectRecord(rawServer);
  const common = () => ({
    connectionTimeoutMs: resolvePositiveTimerTimeoutMs(
      record?.connectionTimeoutMs,
      DEFAULT_CONNECTION_TIMEOUT_MS,
    ),
    requestTimeoutMs: resolveMcpRequestTimeoutMs(rawServer),
    supportsParallelToolCalls: record?.supportsParallelToolCalls === true,
  });
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
      ...stdioLaunch.config,
      description: describeStdioMcpServerLaunchConfig(stdioLaunch.config),
      ...common(),
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
  const oauth = record?.oauth;
  const clientCert = normalizeOptionalString(record?.clientCert);
  const clientKey = normalizeOptionalString(record?.clientKey);
  return {
    kind: "http",
    transportType: launch.config.transportType,
    url: launch.config.url,
    headers: launch.config.headers,
    ...(record?.auth === "oauth" ? { auth: "oauth" as const } : {}),
    ...(isRecord(oauth) ? { oauth: oauth as ResolvedMcpOAuthConfig } : {}),
    ...(typeof record?.sslVerify === "boolean" ? { sslVerify: record.sslVerify } : {}),
    ...(clientCert ? { clientCert } : {}),
    ...(clientKey ? { clientKey } : {}),
    description: redactSensitiveUrl(launch.config.url),
    ...common(),
  };
}
