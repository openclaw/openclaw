// Tavily helper module supports config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePositiveTimeoutSeconds } from "openclaw/plugin-sdk/provider-web-search";
import {
  normalizeSecretInput,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";
export const DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS = 30;
export const DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS = 60;

type TavilySearchConfig =
  | {
      apiKey?: unknown;
      baseUrl?: string;
    }
  | undefined;

type PluginEntryConfig = {
  webSearch?: {
    apiKey?: unknown;
    baseUrl?: string;
  };
};

export function resolveTavilySearchConfig(cfg?: OpenClawConfig): TavilySearchConfig {
  const pluginConfig = cfg?.plugins?.entries?.tavily?.config as PluginEntryConfig;
  const pluginWebSearch = pluginConfig?.webSearch;
  if (pluginWebSearch && typeof pluginWebSearch === "object" && !Array.isArray(pluginWebSearch)) {
    return pluginWebSearch;
  }
  return undefined;
}

type SecretResolution =
  | { kind: "available"; value: string }
  | { kind: "allow_env_fallback" }
  | { kind: "blocked"; ref: NonNullable<ReturnType<typeof resolveSecretInputString>["ref"]> };

/**
 * Resolves the configured apiKey with inspect-mode SecretRef handling.
 *
 * - available: the secret resolved successfully → use it.
 * - allow_env_fallback: no apiKey configured, or an env-source SecretRef
 *   could not be resolved by the config snapshot (the runtime may still
 *   have the variable in process.env) → caller should try process.env.
 * - blocked: a non-env SecretRef (file, exec) is explicitly configured
 *   but unavailable → caller should NOT fall back to process.env.
 */
function normalizeConfiguredSecret(
  value: unknown,
  path: string,
): SecretResolution {
  const resolution = resolveSecretInputString({
    value,
    path,
    mode: "inspect",
  });
  if (resolution.status === "available") {
    return { kind: "available", value: normalizeSecretInput(resolution.value) };
  }
  if (resolution.status === "missing") {
    return { kind: "allow_env_fallback" };
  }
  // configured_unavailable: a SecretRef exists but cannot be resolved.
  if (resolution.ref?.source === "env") {
    return { kind: "allow_env_fallback" };
  }
  return { kind: "blocked", ref: resolution.ref! };
}

export function resolveTavilyApiKey(cfg?: OpenClawConfig): string | undefined {
  const search = resolveTavilySearchConfig(cfg);
  const resolved = normalizeConfiguredSecret(
    search?.apiKey,
    "plugins.entries.tavily.config.webSearch.apiKey",
  );
  if (resolved.kind === "available") {
    return resolved.value || undefined;
  }
  if (resolved.kind === "blocked") {
    // A non-env SecretRef was explicitly configured but is unavailable.
    // Do not fall back to process.env — this would silently replace an
    // explicit operator configuration.
    return undefined;
  }
  // allow_env_fallback: no apiKey configured, or env SecretRef unresolved
  return normalizeSecretInput(process.env.TAVILY_API_KEY) || undefined;
}

export function resolveTavilyBaseUrl(cfg?: OpenClawConfig): string {
  const search = resolveTavilySearchConfig(cfg);
  const configured =
    (normalizeOptionalString(search?.baseUrl) ?? "") ||
    normalizeSecretInput(process.env.TAVILY_BASE_URL) ||
    "";
  return configured || DEFAULT_TAVILY_BASE_URL;
}

export function resolveTavilySearchTimeoutSeconds(override?: number): number {
  return resolvePositiveTimeoutSeconds(override, DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS);
}

export function resolveTavilyExtractTimeoutSeconds(override?: number): number {
  return resolvePositiveTimeoutSeconds(override, DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS);
}
