import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { canResolveEnvSecretRefInReadOnlyPath } from "openclaw/plugin-sdk/extension-shared";
import { normalizeSecretInput, resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";

export const DEFAULT_TINYFISH_BASE_URL = "https://agent.tinyfish.ai";
export const DEFAULT_TINYFISH_SEARCH_TIMEOUT_SECONDS = 30;
export const DEFAULT_TINYFISH_FETCH_TIMEOUT_SECONDS = 60;
const TINYFISH_API_KEY_ENV_VAR = "TINYFISH_API_KEY";

type PluginEntryConfig =
  | {
      webSearch?: {
        apiKey?: unknown;
        baseUrl?: string;
      };
      webFetch?: {
        apiKey?: unknown;
        baseUrl?: string;
      };
    }
  | undefined;

type ConfiguredSecretResolution =
  | { status: "available"; value: string }
  | { status: "missing" }
  | { status: "blocked" };

function resolvePluginConfig(cfg?: OpenClawConfig): PluginEntryConfig {
  return cfg?.plugins?.entries?.tinyfish?.config as PluginEntryConfig;
}

function resolveConfiguredSecret(
  value: unknown,
  path: string,
  cfg?: OpenClawConfig,
): ConfiguredSecretResolution {
  const resolved = resolveSecretInputString({
    value,
    path,
    defaults: cfg?.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    const normalized = normalizeSecretInput(resolved.value);
    return normalized ? { status: "available", value: normalized } : { status: "missing" };
  }
  if (resolved.status === "missing") {
    return { status: "missing" };
  }
  if (resolved.ref.source !== "env") {
    return { status: "blocked" };
  }
  const envVarName = resolved.ref.id.trim();
  if (envVarName !== TINYFISH_API_KEY_ENV_VAR) {
    return { status: "blocked" };
  }
  if (
    !canResolveEnvSecretRefInReadOnlyPath({
      cfg,
      provider: resolved.ref.provider,
      id: envVarName,
    })
  ) {
    return { status: "blocked" };
  }
  const envValue = normalizeSecretInput(process.env[envVarName]);
  return envValue ? { status: "available", value: envValue } : { status: "missing" };
}

export function resolveTinyFishApiKey(cfg?: OpenClawConfig): string | undefined {
  const pluginConfig = resolvePluginConfig(cfg);
  const configuredCandidates: Array<{ value: unknown; path: string }> = [
    {
      value: pluginConfig?.webSearch?.apiKey,
      path: "plugins.entries.tinyfish.config.webSearch.apiKey",
    },
    {
      value: pluginConfig?.webFetch?.apiKey,
      path: "plugins.entries.tinyfish.config.webFetch.apiKey",
    },
  ];
  let blockedConfiguredSecret = false;
  for (const candidate of configuredCandidates) {
    const resolved = resolveConfiguredSecret(candidate.value, candidate.path, cfg);
    if (resolved.status === "available") {
      return resolved.value;
    }
    if (resolved.status === "blocked") {
      blockedConfiguredSecret = true;
    }
  }
  if (blockedConfiguredSecret) {
    return undefined;
  }
  return normalizeSecretInput(process.env[TINYFISH_API_KEY_ENV_VAR]) || undefined;
}

export function resolveTinyFishBaseUrl(cfg?: OpenClawConfig): string {
  const pluginConfig = resolvePluginConfig(cfg);
  const configured =
    (typeof pluginConfig?.webSearch?.baseUrl === "string"
      ? pluginConfig.webSearch.baseUrl.trim()
      : "") ||
    (typeof pluginConfig?.webFetch?.baseUrl === "string"
      ? pluginConfig.webFetch.baseUrl.trim()
      : "") ||
    "";
  return configured || DEFAULT_TINYFISH_BASE_URL;
}

export function resolveTinyFishSearchTimeoutSeconds(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return DEFAULT_TINYFISH_SEARCH_TIMEOUT_SECONDS;
}

export function resolveTinyFishFetchTimeoutSeconds(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return DEFAULT_TINYFISH_FETCH_TIMEOUT_SECONDS;
}
