import type { MullusiConfig } from "mullusi/plugin-sdk/plugin-entry";
import {
  coerceSecretRef,
  resolveNonEnvSecretRefApiKeyMarker,
} from "mullusi/plugin-sdk/provider-auth";
import {
  readProviderEnvValue,
  readConfiguredSecretString,
  resolveProviderWebSearchPluginConfig,
} from "mullusi/plugin-sdk/provider-web-search";
import { normalizeSecretInputString } from "mullusi/plugin-sdk/secret-input";

export type XaiFallbackAuth = {
  apiKey: string;
  source: string;
};

function readConfiguredOrManagedApiKey(value: unknown): string | undefined {
  const literal = normalizeSecretInputString(value);
  if (literal) {
    return literal;
  }
  const ref = coerceSecretRef(value);
  return ref ? resolveNonEnvSecretRefApiKeyMarker(ref.source) : undefined;
}

function readLegacyGrokFallbackAuth(cfg?: MullusiConfig): XaiFallbackAuth | undefined {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  const grok = (search as Record<string, unknown>).grok;
  const apiKey = readConfiguredOrManagedApiKey(
    grok && typeof grok === "object" ? (grok as Record<string, unknown>).apiKey : undefined,
  );
  return apiKey ? { apiKey, source: "tools.web.search.grok.apiKey" } : undefined;
}

export function readLegacyGrokApiKey(cfg?: MullusiConfig): string | undefined {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  const grok = (search as Record<string, unknown>).grok;
  return readConfiguredSecretString(
    grok && typeof grok === "object" ? (grok as Record<string, unknown>).apiKey : undefined,
    "tools.web.search.grok.apiKey",
  );
}

export function readPluginXaiWebSearchApiKey(cfg?: MullusiConfig): string | undefined {
  return readConfiguredSecretString(
    resolveProviderWebSearchPluginConfig(cfg as Record<string, unknown> | undefined, "xai")?.apiKey,
    "plugins.entries.xai.config.webSearch.apiKey",
  );
}

export function resolveFallbackXaiAuth(cfg?: MullusiConfig): XaiFallbackAuth | undefined {
  const pluginApiKey = readConfiguredOrManagedApiKey(
    resolveProviderWebSearchPluginConfig(cfg as Record<string, unknown> | undefined, "xai")?.apiKey,
  );
  if (pluginApiKey) {
    return {
      apiKey: pluginApiKey,
      source: "plugins.entries.xai.config.webSearch.apiKey",
    };
  }
  return readLegacyGrokFallbackAuth(cfg);
}

export function resolveFallbackXaiApiKey(cfg?: MullusiConfig): string | undefined {
  return readPluginXaiWebSearchApiKey(cfg) ?? readLegacyGrokApiKey(cfg);
}

export function resolveXaiToolApiKey(params: {
  runtimeConfig?: MullusiConfig;
  sourceConfig?: MullusiConfig;
}): string | undefined {
  return (
    resolveFallbackXaiApiKey(params.runtimeConfig) ??
    resolveFallbackXaiApiKey(params.sourceConfig) ??
    readProviderEnvValue(["XAI_API_KEY"])
  );
}

export function isXaiToolEnabled(params: {
  enabled?: boolean;
  runtimeConfig?: MullusiConfig;
  sourceConfig?: MullusiConfig;
}): boolean {
  if (params.enabled === false) {
    return false;
  }
  return Boolean(resolveXaiToolApiKey(params));
}
