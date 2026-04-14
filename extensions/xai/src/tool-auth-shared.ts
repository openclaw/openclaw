import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  coerceSecretRef,
  resolveNonEnvSecretRefApiKeyMarker,
} from "openclaw/plugin-sdk/provider-auth";
import {
  readProviderEnvValue,
  resolveProviderWebSearchPluginConfig,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  normalizeSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";

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

function readLegacyGrokFallbackAuth(cfg?: OpenClawConfig): XaiFallbackAuth | undefined {
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

function readConfiguredRuntimeApiKey(value: unknown, path: string): string | undefined {
  const resolved = resolveSecretInputString({
    value,
    path,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    return resolved.value;
  }
  if (resolved.status !== "configured_unavailable" || resolved.ref.source !== "env") {
    return undefined;
  }
  return normalizeSecretInputString(process.env[resolved.ref.id]);
}

export function readLegacyGrokApiKey(cfg?: OpenClawConfig): string | undefined {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  const grok = (search as Record<string, unknown>).grok;
  return readConfiguredRuntimeApiKey(
    grok && typeof grok === "object" ? (grok as Record<string, unknown>).apiKey : undefined,
    "tools.web.search.grok.apiKey",
  );
}

export function readPluginXaiWebSearchApiKey(cfg?: OpenClawConfig): string | undefined {
  return readConfiguredRuntimeApiKey(
    resolveProviderWebSearchPluginConfig(cfg as Record<string, unknown> | undefined, "xai")?.apiKey,
    "plugins.entries.xai.config.webSearch.apiKey",
  );
}

export function resolveFallbackXaiAuth(cfg?: OpenClawConfig): XaiFallbackAuth | undefined {
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

export function resolveFallbackXaiApiKey(cfg?: OpenClawConfig): string | undefined {
  return readPluginXaiWebSearchApiKey(cfg) ?? readLegacyGrokApiKey(cfg);
}

export function resolveXaiToolApiKey(params: {
  runtimeConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
}): string | undefined {
  return (
    resolveFallbackXaiApiKey(params.runtimeConfig) ??
    resolveFallbackXaiApiKey(params.sourceConfig) ??
    readProviderEnvValue(["XAI_API_KEY"])
  );
}

export function isXaiToolEnabled(params: {
  enabled?: boolean;
  runtimeConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
}): boolean {
  if (params.enabled === false) {
    return false;
  }
  return Boolean(resolveXaiToolApiKey(params));
}
