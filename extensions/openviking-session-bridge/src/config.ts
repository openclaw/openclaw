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

const DEFAULT_BASE_URL = "http://127.0.0.1:1933";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 30_000;
const DEFAULT_AGENT_ID = "default";
const DEFAULT_STATE_DIR = join(homedir(), ".openclaw", "data", "openviking-session-bridge");

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const v = process.env[envVar as string];
    if (!v) throw new Error(`Environment variable ${envVar} is not set`);
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
  const baseUrl = resolveEnvVars(rawBaseUrl).replace(/\/+$/, "");

  const rawApiKey =
    typeof cfg.apiKey === "string" ? cfg.apiKey : (process.env.OPENVIKING_API_KEY ?? "");
  const apiKey = rawApiKey ? resolveEnvVars(rawApiKey) : "";

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
