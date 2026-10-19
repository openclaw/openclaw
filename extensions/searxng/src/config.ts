import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveProviderWebSearchPluginConfig } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";
import { resolveReadOnlyEnvSecretRef } from "openclaw/plugin-sdk/secret-ref-readonly";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const SEARXNG_BASE_URL_ENV_VAR = "SEARXNG_BASE_URL";
const SEARXNG_BASE_URL_PATH = "plugins.entries.searxng.config.webSearch.baseUrl";

function normalizeBaseUrl(value: unknown): string | undefined {
  return normalizeSecretInput(value)?.replace(/\/+$/u, "") || undefined;
}

export function resolveSearxngBaseUrl(config?: OpenClawConfig): string | undefined {
  const webSearch = resolveProviderWebSearchPluginConfig(config, "searxng");
  const resolved = resolveReadOnlyEnvSecretRef({
    value: webSearch?.baseUrl,
    path: SEARXNG_BASE_URL_PATH,
    cfg: config,
    expectedEnvId: SEARXNG_BASE_URL_ENV_VAR,
    normalizeValue: normalizeBaseUrl,
  });
  if (resolved.status === "available") {
    return resolved.value;
  }
  if (resolved.status === "blocked") {
    return undefined;
  }
  return normalizeBaseUrl(process.env[SEARXNG_BASE_URL_ENV_VAR]);
}

export function resolveSearxngCategories(config?: OpenClawConfig): string | undefined {
  return normalizeOptionalString(
    resolveProviderWebSearchPluginConfig(config, "searxng")?.categories,
  );
}

export function resolveSearxngLanguage(config?: OpenClawConfig): string | undefined {
  return normalizeOptionalString(resolveProviderWebSearchPluginConfig(config, "searxng")?.language);
}
