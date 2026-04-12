import { isMcpConfigRecord, toMcpStringArray, toMcpStringRecord } from "./mcp-config-shared.js";

type StdioMcpServerLaunchConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

type StdioMcpServerLaunchResult =
  | { ok: true; config: StdioMcpServerLaunchConfig }
  | { ok: false; reason: string };

/**
 * Env var keys that should be propagated from the gateway process to MCP stdio
 * child processes.  The MCP SDK intentionally restricts env inheritance (on
 * Linux it only forwards HOME, LOGNAME, PATH, SHELL, TERM, USER).  Without
 * explicit propagation, proxy configuration and NODE_OPTIONS preloads that the
 * gateway relies on are silently lost in child processes.
 *
 * Both upper- and lower-case variants are included because Node/undici honour
 * both (lower-case takes precedence per convention).
 */
const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_OPTIONS",
] as const;

/**
 * Collect proxy-related env vars from the current process so they can be
 * forwarded to MCP stdio child processes as lowest-priority defaults.
 *
 * @internal — exported for testing only.
 */
export function getProxyEnvDefaults(): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== "") {
      defaults[key] = value;
    }
  }
  return defaults;
}

export function resolveStdioMcpServerLaunchConfig(raw: unknown): StdioMcpServerLaunchResult {
  if (!isMcpConfigRecord(raw)) {
    return { ok: false, reason: "server config must be an object" };
  }
  if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
    if (typeof raw.url === "string" && raw.url.trim().length > 0) {
      return {
        ok: false,
        reason: "not a stdio server (has url)",
      };
    }
    return { ok: false, reason: "its command is missing" };
  }
  const cwd =
    typeof raw.cwd === "string" && raw.cwd.trim().length > 0
      ? raw.cwd
      : typeof raw.workingDirectory === "string" && raw.workingDirectory.trim().length > 0
        ? raw.workingDirectory
        : undefined;

  // Merge proxy/NODE_OPTIONS env vars from the gateway process as
  // lowest-priority defaults. User-configured env values always win.
  const proxyDefaults = getProxyEnvDefaults();
  const userEnv = toMcpStringRecord(raw.env);
  const hasProxyDefaults = Object.keys(proxyDefaults).length > 0;
  const mergedEnv = hasProxyDefaults || userEnv ? { ...proxyDefaults, ...userEnv } : undefined;

  return {
    ok: true,
    config: {
      command: raw.command,
      args: toMcpStringArray(raw.args),
      env: mergedEnv,
      cwd,
    },
  };
}

export function describeStdioMcpServerLaunchConfig(config: StdioMcpServerLaunchConfig): string {
  const args =
    Array.isArray(config.args) && config.args.length > 0 ? ` ${config.args.join(" ")}` : "";
  const cwd = config.cwd ? ` (cwd=${config.cwd})` : "";
  return `${config.command}${args}${cwd}`;
}

export type { StdioMcpServerLaunchConfig, StdioMcpServerLaunchResult };
