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
 * Case-insensitive pairs for proxy env vars.  Used to deduplicate defaults so
 * that we never forward both `HTTPS_PROXY` and `https_proxy` simultaneously
 * (lowercase takes precedence per convention, so forwarding both would cause
 * the user's explicit uppercase override to be silently ignored).
 */
const PROXY_CASE_PAIRS: ReadonlyArray<[uppercase: string, lowercase: string]> = [
  ["HTTPS_PROXY", "https_proxy"],
  ["HTTP_PROXY", "http_proxy"],
  ["NO_PROXY", "no_proxy"],
];

/**
 * Regex that matches ALL `--inspect*` flags inside a NODE_OPTIONS string.
 * This covers `--inspect`, `--inspect-brk`, `--inspect-port=…`,
 * `--inspect-publish-uid=…`, and any future `--inspect-*` variants.
 * If the gateway process is running under a debugger these flags would cause
 * every MCP child to hang waiting for its own debugger connection.
 */
const INSPECT_FLAG_RE = /--inspect[-\w]*(=\S+)?/g;

/**
 * Collect proxy-related env vars from the current process so they can be
 * forwarded to MCP stdio child processes as lowest-priority defaults.
 *
 * Case-dedup: when the gateway has both `HTTPS_PROXY` and `https_proxy` set,
 * only the lowercase variant is forwarded.  Lowercase takes precedence per
 * convention (see `src/infra/net/proxy-env.ts`), so forwarding the lowercase
 * variant preserves the documented precedence order for MCP children.
 *
 * NODE_OPTIONS: `--inspect*` flags are stripped so that MCP child processes
 * don't hang waiting for a debugger connection when the gateway itself is
 * being debugged.
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

  // Case-insensitive dedup: when both cases are present, keep only lowercase.
  // Lowercase takes precedence per convention (src/infra/net/proxy-env.ts).
  for (const [upper, lower] of PROXY_CASE_PAIRS) {
    if (defaults[upper] !== undefined && defaults[lower] !== undefined) {
      delete defaults[upper];
    }
  }

  // Strip --inspect* flags from NODE_OPTIONS so child processes don't hang.
  if (defaults.NODE_OPTIONS !== undefined) {
    const sanitized = defaults.NODE_OPTIONS.replace(INSPECT_FLAG_RE, "")
      .trim()
      .replace(/\s{2,}/g, " ");
    if (sanitized.length === 0) {
      delete defaults.NODE_OPTIONS;
    } else {
      defaults.NODE_OPTIONS = sanitized;
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
  //
  // Cross-case dedup: if userEnv explicitly sets `https_proxy`, drop the
  // uppercase `HTTPS_PROXY` default (and vice-versa) so both aren't
  // forwarded to the child.
  const proxyDefaults = getProxyEnvDefaults();
  const userEnv = toMcpStringRecord(raw.env);
  if (userEnv) {
    for (const [upper, lower] of PROXY_CASE_PAIRS) {
      if (userEnv[lower] !== undefined) {
        delete proxyDefaults[upper];
      }
      if (userEnv[upper] !== undefined) {
        delete proxyDefaults[lower];
      }
    }
  }
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
