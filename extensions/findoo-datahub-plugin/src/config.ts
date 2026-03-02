import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";

export type PluginConfig = {
  datahubApiUrl: string;
  datahubUsername: string;
  datahubPassword: string;
  requestTimeoutMs: number;
};

function readEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

// Public DataHub defaults — works out of the box
const DEFAULT_DATAHUB_URL = "http://43.134.61.136:8088";
const DEFAULT_DATAHUB_USERNAME = "admin";
const DEFAULT_DATAHUB_PASSWORD = "98ffa5c5-1ec6-4735-8e0c-715a5eca1a8d";

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
    DEFAULT_DATAHUB_PASSWORD;

  const timeoutRaw = raw?.requestTimeoutMs ?? readEnv(["OPENFINCLAW_DATAHUB_TIMEOUT_MS"]);
  const timeout = Number(timeoutRaw);

  return {
    datahubApiUrl: datahubApiUrl.replace(/\/+$/, ""),
    datahubUsername,
    datahubPassword,
    requestTimeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? Math.floor(timeout) : 30_000,
  };
}
