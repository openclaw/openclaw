import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export interface PluginConfig {
  backtestApiUrl: string;
  backtestApiKey: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  requestTimeoutMs: number;
}

function readEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function clamp(val: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(val) && val >= min ? Math.min(Math.floor(val), max) : fallback;
}

export function resolveConfig(api: OpenClawPluginApi): PluginConfig {
  const raw = api.pluginConfig as Record<string, unknown> | undefined;

  const backtestApiUrl =
    (typeof raw?.backtestApiUrl === "string" ? raw.backtestApiUrl : undefined) ??
    readEnv(["BACKTEST_API_URL", "FINDOO_BACKTEST_URL", "OPENFINCLAW_BACKTEST_URL"]) ??
    "http://localhost:8000";

  const backtestApiKey =
    (typeof raw?.backtestApiKey === "string" ? raw.backtestApiKey : undefined) ??
    readEnv(["BACKTEST_API_KEY", "FINDOO_BACKTEST_API_KEY"]) ??
    "";

  const pollInterval = Number(
    raw?.pollIntervalMs ?? readEnv(["FINDOO_BACKTEST_POLL_INTERVAL"]) ?? 0,
  );
  const pollTimeout = Number(raw?.pollTimeoutMs ?? readEnv(["FINDOO_BACKTEST_POLL_TIMEOUT"]) ?? 0);
  const requestTimeout = Number(
    raw?.requestTimeoutMs ?? readEnv(["FINDOO_BACKTEST_REQUEST_TIMEOUT"]) ?? 0,
  );

  return {
    backtestApiUrl: backtestApiUrl.replace(/\/+$/, ""),
    backtestApiKey,
    pollIntervalMs: clamp(pollInterval, 500, 30_000, 2_000),
    pollTimeoutMs: clamp(pollTimeout, 5_000, 600_000, 120_000),
    requestTimeoutMs: clamp(requestTimeout, 1_000, 120_000, 30_000),
  };
}
