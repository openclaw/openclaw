import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

export type OVSessionBridgeConfig = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  agentId: string;
  timeoutMs: number;
  /** Maximum wall-clock ms for a synchronous /done flush before giving up. */
  flushTimeoutMs: number;
  stateDir: string;
  /** Commit (extract memories) on final flush. Default true. */
  commitOnFlush: boolean;
};

// ── Schema type (structural subset of OpenClawPluginConfigSchema) ────────────
// We define it locally so config.ts stays free of SDK imports.  The shape is
// structurally compatible with OpenClawPluginConfigSchema from the SDK.

type SafeParseResult =
  | { success: true; data?: unknown }
  | {
      success: false;
      error: { issues?: Array<{ path: Array<string | number>; message: string }> };
    };

type PluginConfigUiHint = {
  label?: string;
  help?: string;
  tags?: string[];
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
};

export type OVPluginConfigSchema = {
  safeParse?: (value: unknown) => SafeParseResult;
  uiHints?: Record<string, PluginConfigUiHint>;
  jsonSchema?: Record<string, unknown>;
};

// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "http://127.0.0.1:1933";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 30_000;
const DEFAULT_AGENT_ID = "default";
const DEFAULT_STATE_DIR = join(homedir(), ".openclaw", "data", "openviking-session-bridge");

/**
 * Substitute `${VAR}` placeholders from process.env.
 *
 * Behaviour on missing variable:
 *  - strict=false (default): leaves the placeholder intact (e.g. "${MY_VAR}").
 *    The plugin loads successfully; the raw placeholder surfaces as an obviously
 *    wrong value at the first API call, which is logged clearly.
 *  - strict=true: throws immediately — use only when the caller knows the plugin
 *    is enabled and the value is required.
 */
function resolveEnvVars(value: string, strict = false): string {
  return value.replace(/\$\{([^}]+)\}/g, (original, envVar: string) => {
    const v = process.env[envVar];
    if (v == null || v === "") {
      if (strict) throw new Error(`Environment variable ${envVar} is not set`);
      return original; // leave placeholder intact — surfaced on first API call
    }
    return v;
  });
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function parseOVSessionBridgeConfig(raw: unknown): OVSessionBridgeConfig {
  const cfg =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const enabled = cfg.enabled === true; // default: false (must explicitly opt in)

  const rawBaseUrl =
    typeof cfg.baseUrl === "string" && cfg.baseUrl.trim()
      ? cfg.baseUrl.trim()
      : (process.env.OPENVIKING_BASE_URL ?? process.env.OPENVIKING_URL ?? DEFAULT_BASE_URL);
  // Lenient resolution: a missing env var leaves the placeholder, which surfaces
  // as an HTTP error on first use rather than crashing the plugin at load time.
  const baseUrl = resolveEnvVars(rawBaseUrl, false).replace(/\/+$/, "");

  const rawApiKey =
    typeof cfg.apiKey === "string" ? cfg.apiKey : (process.env.OPENVIKING_API_KEY ?? "");
  // apiKey: lenient — a missing env var yields "" (unauthenticated). The first
  // authenticated call will fail with a clear 401 rather than crashing at load.
  const apiKey = rawApiKey ? resolveEnvVars(rawApiKey, false) : "";

  const agentId =
    typeof cfg.agentId === "string" && cfg.agentId.trim() ? cfg.agentId.trim() : DEFAULT_AGENT_ID;

  const timeoutMs = Math.max(1_000, toNumber(cfg.timeoutMs, DEFAULT_TIMEOUT_MS));
  const flushTimeoutMs = Math.max(5_000, toNumber(cfg.flushTimeoutMs, DEFAULT_FLUSH_TIMEOUT_MS));

  const rawStateDir =
    typeof cfg.stateDir === "string" && cfg.stateDir.trim()
      ? cfg.stateDir.trim().replace(/^~/, homedir())
      : DEFAULT_STATE_DIR;
  const stateDir = resolvePath(rawStateDir);

  const commitOnFlush = cfg.commitOnFlush !== false;

  return { enabled, baseUrl, apiKey, agentId, timeoutMs, flushTimeoutMs, stateDir, commitOnFlush };
}

/**
 * Build the runtime plugin config schema for the session bridge.
 *
 * The returned object is structurally compatible with OpenClawPluginConfigSchema
 * from the SDK; it matches the shape declared in openclaw.plugin.json and
 * provides `safeParse` so OpenClaw can validate user-supplied config at load time.
 */
export function buildOVPluginConfigSchema(): OVPluginConfigSchema {
  return {
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        baseUrl: { type: "string" },
        apiKey: { type: "string" },
        agentId: { type: "string" },
        timeoutMs: { type: "number" },
        flushTimeoutMs: { type: "number" },
        stateDir: { type: "string" },
        commitOnFlush: { type: "boolean" },
      },
    },
    uiHints: {
      enabled: {
        label: "Enabled",
        help: "Enable or disable the OpenViking session bridge (default: false)",
      },
      baseUrl: {
        label: "OpenViking Base URL",
        placeholder: "http://127.0.0.1:1933",
        help: "HTTP URL of the running OpenViking server",
      },
      apiKey: {
        label: "OpenViking API Key",
        sensitive: true,
        placeholder: "${OPENVIKING_API_KEY}",
        help: "Optional API key for OpenViking server",
      },
      agentId: {
        label: "Agent ID",
        placeholder: "default",
        help: "Agent identifier sent to OpenViking (X-OpenViking-Agent header)",
      },
      timeoutMs: {
        label: "Request Timeout (ms)",
        placeholder: "15000",
        advanced: true,
      },
      flushTimeoutMs: {
        label: "Flush Timeout (ms)",
        placeholder: "30000",
        help: "Maximum time to wait for a synchronous flush (e.g. /done command)",
        advanced: true,
      },
      stateDir: {
        label: "State Directory",
        placeholder: "~/.openclaw/data/openviking-session-bridge",
        help: "Directory for checkpoint files",
        advanced: true,
      },
      commitOnFlush: {
        label: "Commit On Flush",
        help: "Commit (extract memories from) the OV session at session_end. Default: true",
        advanced: true,
      },
    },
    safeParse(value: unknown): SafeParseResult {
      if (value === undefined || value === null) {
        return { success: true, data: value };
      }
      if (typeof value !== "object" || Array.isArray(value)) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "config must be an object" }] },
        };
      }
      const cfg = value as Record<string, unknown>;
      const issues: Array<{ path: Array<string | number>; message: string }> = [];

      const BOOL_FIELDS = ["enabled", "commitOnFlush"] as const;
      const NUM_FIELDS = ["timeoutMs", "flushTimeoutMs"] as const;
      const STR_FIELDS = ["baseUrl", "apiKey", "agentId", "stateDir"] as const;

      for (const k of BOOL_FIELDS) {
        if (k in cfg && typeof cfg[k] !== "boolean") {
          issues.push({ path: [k], message: `${k} must be a boolean` });
        }
      }
      for (const k of NUM_FIELDS) {
        if (k in cfg && (typeof cfg[k] !== "number" || !Number.isFinite(cfg[k] as number))) {
          issues.push({ path: [k], message: `${k} must be a finite number` });
        }
      }
      for (const k of STR_FIELDS) {
        if (k in cfg && typeof cfg[k] !== "string") {
          issues.push({ path: [k], message: `${k} must be a string` });
        }
      }

      if (issues.length > 0) {
        return { success: false, error: { issues } };
      }
      return { success: true, data: value };
    },
  };
}
