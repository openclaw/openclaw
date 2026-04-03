import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeSecretInput } from "openclaw/plugin-sdk/provider-auth";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

export const YOU_SEARCH_BASE_URL = "https://ydc-index.io";
export const YOU_RESEARCH_BASE_URL = "https://api.you.com";

export const DEFAULT_SEARCH_TIMEOUT_SECONDS = 30;
export const DEFAULT_CONTENTS_TIMEOUT_SECONDS = 60;

// Research API has effort-aware timeouts
export const RESEARCH_EFFORT_TIMEOUT_SECONDS: Record<string, number> = {
  lite: 60,
  standard: 120,
  deep: 360,
  exhaustive: 600,
};

type YouSearchConfig =
  | {
      apiKey?: unknown;
    }
  | undefined;

type PluginEntryConfig = {
  webSearch?: {
    apiKey?: unknown;
  };
};

export function resolveYouSearchConfig(cfg?: OpenClawConfig): YouSearchConfig {
  const pluginConfig = cfg?.plugins?.entries?.you?.config as PluginEntryConfig;
  const pluginWebSearch = pluginConfig?.webSearch;
  if (pluginWebSearch && typeof pluginWebSearch === "object" && !Array.isArray(pluginWebSearch)) {
    return pluginWebSearch;
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

export function resolveYouApiKey(cfg?: OpenClawConfig): string | undefined {
  const search = resolveYouSearchConfig(cfg);
  return (
    normalizeConfiguredSecret(search?.apiKey, "plugins.entries.you.config.webSearch.apiKey") ||
    normalizeSecretInput(process.env.YDC_API_KEY) ||
    undefined
  );
}

export function resolveSearchTimeoutSeconds(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return DEFAULT_SEARCH_TIMEOUT_SECONDS;
}

export function resolveContentsTimeoutSeconds(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return DEFAULT_CONTENTS_TIMEOUT_SECONDS;
}

export function resolveResearchTimeoutSeconds(effort: string, override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return RESEARCH_EFFORT_TIMEOUT_SECONDS[effort] ?? RESEARCH_EFFORT_TIMEOUT_SECONDS.standard;
}
