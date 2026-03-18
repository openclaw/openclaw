import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export type SlimConfig = {
  /** Gateway base URL (e.g., http://43.134.61.136:9080) */
  gatewayUrl: string;
  /** API Key with fch_ prefix (e.g., fch_<64-char-hex>) */
  apiKey: string | undefined;
  requestTimeoutMs: number;
};

const DEFAULT_GATEWAY_URL = "http://43.134.61.136:9080";

function env(keys: string[]): string | undefined {
  for (const key of keys) {
    const v = process.env[key]?.trim();
    if (v) return v;
  }
}

export function resolveConfig(api: OpenClawPluginApi): SlimConfig {
  const raw = api.pluginConfig as Record<string, unknown> | undefined;

  const gatewayUrl =
    (typeof raw?.gatewayUrl === "string" ? raw.gatewayUrl : undefined) ??
    env(["DATAHUB_GATEWAY_URL", "OPENFINCLAW_DATAHUB_GATEWAY_URL"]) ??
    DEFAULT_GATEWAY_URL;

  const apiKey =
    (typeof raw?.apiKey === "string" ? raw.apiKey : undefined) ??
    env(["DATAHUB_API_KEY", "OPENFINCLAW_DATAHUB_API_KEY"]) ??
    undefined;

  const t = Number(raw?.requestTimeoutMs ?? env(["OPENFINCLAW_DATAHUB_TIMEOUT_MS"]));

  return {
    gatewayUrl: gatewayUrl.replace(/\/+$/, ""),
    apiKey,
    requestTimeoutMs: Number.isFinite(t) && t >= 1000 ? Math.floor(t) : 30_000,
  };
}
