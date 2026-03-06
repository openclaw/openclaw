import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export type PluginConfig = {
  datahubApiUrl: string;
  datahubUsername: string;
  datahubApiKey: string | undefined;
  requestTimeoutMs: number;
};

function readEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

// Built-in DataHub URL — API key must be configured by the user
const DEFAULT_DATAHUB_URL = "http://43.134.61.136:8088";
const DEFAULT_DATAHUB_USERNAME = "admin";

export function resolveConfig(api: OpenClawPluginApi): PluginConfig {
  const raw = api.pluginConfig as Record<string, unknown> | undefined;

  const datahubApiUrl =
    (typeof raw?.datahubApiUrl === "string" ? raw.datahubApiUrl : undefined) ??
    readEnv(["DATAHUB_API_URL", "OPENFINCLAW_DATAHUB_API_URL"]) ??
    DEFAULT_DATAHUB_URL;

  const datahubUsername =
    (typeof raw?.datahubUsername === "string" ? raw.datahubUsername : undefined) ??
    readEnv(["DATAHUB_USERNAME", "OPENFINCLAW_DATAHUB_USERNAME"]) ??
    DEFAULT_DATAHUB_USERNAME;

  const datahubPassword =
    (typeof raw?.datahubPassword === "string" ? raw.datahubPassword : undefined) ??
    (typeof raw?.datahubApiKey === "string" ? raw.datahubApiKey : undefined) ??
    readEnv(["DATAHUB_PASSWORD", "OPENFINCLAW_DATAHUB_PASSWORD", "DATAHUB_API_KEY"]) ??
    undefined;

  const timeoutRaw = raw?.requestTimeoutMs ?? readEnv(["OPENFINCLAW_DATAHUB_TIMEOUT_MS"]);
  const timeout = Number(timeoutRaw);

  return {
    datahubApiUrl: datahubApiUrl.replace(/\/+$/, ""),
    datahubUsername,
    datahubApiKey: datahubPassword,
    requestTimeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? Math.floor(timeout) : 30_000,
  };
}
