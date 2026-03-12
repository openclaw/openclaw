import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export type SlimConfig = {
  datahubApiUrl: string;
  datahubUsername: string;
  datahubApiKey: string | undefined;
  requestTimeoutMs: number;
};

const DEFAULT_DATAHUB_URL = "http://172.22.0.10:8088";
const DEFAULT_DATAHUB_USERNAME = "admin";

function env(keys: string[]): string | undefined {
  for (const key of keys) {
    const v = process.env[key]?.trim();
    if (v) return v;
  }
}

export function resolveConfig(api: OpenClawPluginApi): SlimConfig {
  const raw = api.pluginConfig as Record<string, unknown> | undefined;

  const datahubApiUrl =
    (typeof raw?.datahubApiUrl === "string" ? raw.datahubApiUrl : undefined) ??
    env(["DATAHUB_API_URL", "OPENFINCLAW_DATAHUB_API_URL"]) ??
    DEFAULT_DATAHUB_URL;

  const datahubUsername =
    (typeof raw?.datahubUsername === "string" ? raw.datahubUsername : undefined) ??
    env(["DATAHUB_USERNAME"]) ??
    DEFAULT_DATAHUB_USERNAME;

  const datahubApiKey =
    (typeof raw?.datahubApiKey === "string" ? raw.datahubApiKey : undefined) ??
    env(["DATAHUB_API_KEY", "DATAHUB_PASSWORD", "OPENFINCLAW_DATAHUB_PASSWORD"]) ??
    undefined;

  const t = Number(raw?.requestTimeoutMs ?? env(["OPENFINCLAW_DATAHUB_TIMEOUT_MS"]));

  return {
    datahubApiUrl: datahubApiUrl.replace(/\/+$/, ""),
    datahubUsername,
    datahubApiKey,
    requestTimeoutMs: Number.isFinite(t) && t >= 1000 ? Math.floor(t) : 30_000,
  };
}
