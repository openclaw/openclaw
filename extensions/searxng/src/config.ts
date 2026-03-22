import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeSecretInput } from "openclaw/plugin-sdk/provider-auth";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

export const DEFAULT_SEARXNG_BASE_URL = "http://localhost:8080";
export const DEFAULT_SEARXNG_TIMEOUT_SECONDS = 30;

type SearXNGSearchConfig =
  | {
      apiKey?: unknown;
      baseUrl?: string;
      allowPrivateNetwork?: boolean;
    }
  | undefined;

type PluginEntryConfig = {
  webSearch?: {
    apiKey?: unknown;
    baseUrl?: string;
  };
};

export function resolveSearXNGSearchConfig(cfg?: OpenClawConfig): SearXNGSearchConfig {
  const toolsConfig = cfg?.tools?.web?.search;
  const toolsSearXNG = toolsConfig?.searxng as SearXNGSearchConfig;
  const pluginConfig = cfg?.plugins?.entries?.searxng?.config as PluginEntryConfig;
  const pluginWebSearch = pluginConfig?.webSearch;

  const merged = {
    ...(pluginWebSearch && typeof pluginWebSearch === "object" ? pluginWebSearch : {}),
    ...(toolsSearXNG && typeof toolsSearXNG === "object" ? toolsSearXNG : {}),
  } as SearXNGSearchConfig;

  if (merged && typeof merged === "object" && Object.keys(merged).length > 0) {
    return {
      ...merged,
      allowPrivateNetwork: merged.allowPrivateNetwork ?? toolsConfig?.allowPrivateNetwork,
    };
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

export function resolveSearXNGApiKey(cfg?: OpenClawConfig): string | undefined {
  const search = resolveSearXNGSearchConfig(cfg);
  return (
    normalizeConfiguredSecret(search?.apiKey, "plugins.entries.searxng.config.webSearch.apiKey") ||
    normalizeSecretInput(process.env.SEARXNG_API_KEY) ||
    undefined
  );
}

export function resolveSearXNGBaseUrl(cfg?: OpenClawConfig): string {
  const search = resolveSearXNGSearchConfig(cfg);
  const configured =
    (typeof search?.baseUrl === "string" ? search.baseUrl.trim() : "") ||
    normalizeSecretInput(process.env.SEARXNG_BASE_URL) ||
    "";
  return configured || DEFAULT_SEARXNG_BASE_URL;
}

export function resolveSearXNGAllowPrivateNetwork(cfg?: OpenClawConfig): boolean {
  const search = resolveSearXNGSearchConfig(cfg);
  return search?.allowPrivateNetwork === true;
}

export function resolveSearXNGTimeoutSeconds(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return DEFAULT_SEARXNG_TIMEOUT_SECONDS;
}
