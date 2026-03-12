import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export type PluginConfig = {
  apiKey: string;
  strategyAgentUrl: string;
  strategyAssistantId: string;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  taskTimeoutMs: number;
};

function readEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

const DEFAULT_STRATEGY_AGENT_URL = "http://43.128.100.43:5085";
const DEFAULT_ASSISTANT_ID = "d2310a07-b552-453c-a8bb-7b9b86de6b23";

export function resolveConfig(api: OpenClawPluginApi): PluginConfig {
  const raw = api.pluginConfig as Record<string, unknown> | undefined;

  const strategyAgentUrl =
    (typeof raw?.strategyAgentUrl === "string" ? raw.strategyAgentUrl : undefined) ??
    readEnv(["STRATEGY_AGENT_URL", "OPENFINCLAW_STRATEGY_AGENT_URL"]) ??
    DEFAULT_STRATEGY_AGENT_URL;

  const strategyAssistantId =
    (typeof raw?.strategyAssistantId === "string" ? raw.strategyAssistantId : undefined) ??
    readEnv(["STRATEGY_ASSISTANT_ID", "OPENFINCLAW_STRATEGY_ASSISTANT_ID"]) ??
    DEFAULT_ASSISTANT_ID;

  const timeoutRaw = raw?.requestTimeoutMs ?? readEnv(["OPENFINCLAW_STRATEGY_TIMEOUT_MS"]);
  const timeout = Number(timeoutRaw);

  const pollRaw = raw?.pollIntervalMs ?? readEnv(["OPENFINCLAW_FINDOO_POLL_INTERVAL_MS"]);
  const pollInterval = Number(pollRaw);

  const taskTimeoutRaw = raw?.taskTimeoutMs ?? readEnv(["OPENFINCLAW_FINDOO_TASK_TIMEOUT_MS"]);
  const taskTimeout = Number(taskTimeoutRaw);

  const apiKey =
    (typeof raw?.apiKey === "string" ? raw.apiKey : undefined) ??
    readEnv(["FINDOO_API_KEY", "OPENFINCLAW_FINDOO_API_KEY"]) ??
    "";

  return {
    apiKey,
    strategyAgentUrl: strategyAgentUrl.replace(/\/+$/, ""),
    strategyAssistantId,
    requestTimeoutMs: Number.isFinite(timeout) && timeout >= 5000 ? Math.floor(timeout) : 120_000,
    pollIntervalMs:
      Number.isFinite(pollInterval) && pollInterval >= 5000 ? Math.floor(pollInterval) : 15_000,
    taskTimeoutMs:
      Number.isFinite(taskTimeout) && taskTimeout >= 60_000 ? Math.floor(taskTimeout) : 600_000,
  };
}
