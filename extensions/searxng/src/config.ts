// Searxng helper module supports config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeSecretInput, resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";

type SearxngPluginConfig = {
  webSearch?: {
    baseUrl?: unknown;
    categories?: string;
    language?: string;
  };
};

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  return value?.replace(/\/+$/u, "") || undefined;
}

type ConfiguredBaseUrlResolution =
  | { status: "available"; value: string }
  | { status: "missing" }
  | { status: "blocked" };

function resolveConfiguredBaseUrl(
  value: unknown,
  path: string,
  config: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv,
  valueConfigured: boolean,
): ConfiguredBaseUrlResolution {
  const resolved = resolveSecretInputString({
    value,
    path,
    defaults: config?.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    const normalized = normalizeBaseUrl(normalizeSecretInput(resolved.value));
    return normalized
      ? { status: "available", value: normalized }
      : valueConfigured
        ? { status: "blocked" }
        : { status: "missing" };
  }
  if (resolved.status === "missing") {
    return valueConfigured ? { status: "blocked" } : { status: "missing" };
  }
  if (resolved.ref.source !== "env") {
    return { status: "blocked" };
  }
  const normalized = normalizeBaseUrl(normalizeSecretInput(env[resolved.ref.id]));
  return normalized ? { status: "available", value: normalized } : { status: "blocked" };
}

function resolveSearxngWebSearchConfig(
  config?: OpenClawConfig,
): SearxngPluginConfig["webSearch"] | undefined {
  const pluginConfig = config?.plugins?.entries?.searxng?.config as SearxngPluginConfig | undefined;
  const webSearch = pluginConfig?.webSearch;
  if (webSearch && typeof webSearch === "object" && !Array.isArray(webSearch)) {
    return webSearch;
  }
  return undefined;
}

export function resolveSearxngBaseUrl(
  config?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const webSearch = resolveSearxngWebSearchConfig(config);
  const hasConfiguredBaseUrl = webSearch
    ? Object.hasOwn(webSearch, "baseUrl") && webSearch.baseUrl !== undefined
    : false;
  const configured = resolveConfiguredBaseUrl(
    webSearch?.baseUrl,
    "plugins.entries.searxng.config.webSearch.baseUrl",
    config,
    env,
    hasConfiguredBaseUrl,
  );
  if (configured.status === "available") {
    return configured.value;
  }
  if (configured.status === "blocked") {
    // Explicit invalid/unavailable config is authoritative, so search execution must not route
    // through an unrelated ambient endpoint. Provider detection uses contract metadata instead.
    throw new Error(
      "Configured SearXNG base URL is unavailable or invalid. Fix plugins.entries.searxng.config.webSearch.baseUrl or remove it to use SEARXNG_BASE_URL.",
    );
  }
  return normalizeBaseUrl(normalizeSecretInput(env.SEARXNG_BASE_URL));
}

export function resolveSearxngCategories(config?: OpenClawConfig): string | undefined {
  return normalizeTrimmedString(resolveSearxngWebSearchConfig(config)?.categories);
}

export function resolveSearxngLanguage(config?: OpenClawConfig): string | undefined {
  return normalizeTrimmedString(resolveSearxngWebSearchConfig(config)?.language);
}
