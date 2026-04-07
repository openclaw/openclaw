import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInput,
} from "openclaw/plugin-sdk/secret-input";

export const DEFAULT_FATHOM_BASE_URL = "https://api.fathom.ai/external/v1";
export const DEFAULT_FATHOM_TIMEOUT_SECONDS = 30;

type PluginEntryConfig = {
  fathom?: {
    apiKey?: unknown;
    baseUrl?: string;
  };
};

export function resolveFathomPluginConfig(cfg?: OpenClawConfig): PluginEntryConfig["fathom"] {
  const pluginConfig = cfg?.plugins?.entries?.fathom?.config as PluginEntryConfig | undefined;
  const fathom = pluginConfig?.fathom;
  if (fathom && typeof fathom === "object" && !Array.isArray(fathom)) {
    return fathom;
  }
  return undefined;
}

function normalizeConfiguredSecret(value: unknown, path: string): string | undefined {
  return normalizeSecretInput(
    normalizeResolvedSecretInputString({
      value,
      path,
    }),
  );
}

export function resolveFathomApiKey(cfg?: OpenClawConfig): string | undefined {
  const fathom = resolveFathomPluginConfig(cfg);
  return (
    normalizeConfiguredSecret(fathom?.apiKey, "plugins.entries.fathom.config.fathom.apiKey") ||
    normalizeSecretInput(process.env.FATHOM_API_KEY) ||
    undefined
  );
}

export function resolveFathomBaseUrl(cfg?: OpenClawConfig): string {
  const fathom = resolveFathomPluginConfig(cfg);
  const configured =
    (typeof fathom?.baseUrl === "string" ? fathom.baseUrl.trim() : "") ||
    normalizeSecretInput(process.env.FATHOM_BASE_URL) ||
    "";
  return configured || DEFAULT_FATHOM_BASE_URL;
}

export function resolveFathomTimeoutSeconds(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return DEFAULT_FATHOM_TIMEOUT_SECONDS;
}
