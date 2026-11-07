import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderWebSearchPluginConfig } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import {
  coerceSecretRef,
  normalizeSecretInputString,
  readProviderEnvValue,
  resolveNonEnvSecretRefApiKeyMarker,
} from "openclaw/plugin-sdk/secret-input";
import {
  resolveReadOnlyEnvSecretRef,
  type ReadOnlyEnvSecretRefResolution,
} from "openclaw/plugin-sdk/secret-ref-readonly";

type XaiFallbackAuth = {
  apiKey: string;
  source: string;
};
const XAI_API_KEY_ENV_VAR = "XAI_API_KEY";
const XAI_PROVIDER_ID = "xai";

export type XaiToolAuthContext = Pick<
  OpenClawPluginToolContext,
  "hasAuthForProvider" | "resolveAuthForProvider" | "resolveApiKeyForProvider"
>;

export type XaiToolAuth = NonNullable<
  Awaited<ReturnType<NonNullable<XaiToolAuthContext["resolveAuthForProvider"]>>>
>;

function readConfiguredOrManagedApiKey(value: unknown): string | undefined {
  const literal = normalizeSecretInputString(value);
  if (literal) {
    return literal;
  }
  const ref = coerceSecretRef(value);
  return ref ? resolveNonEnvSecretRefApiKeyMarker(ref.source) : undefined;
}

function readPluginXaiWebSearchApiKeyResult(cfg?: OpenClawConfig): ReadOnlyEnvSecretRefResolution {
  return resolveReadOnlyEnvSecretRef({
    value: resolveProviderWebSearchPluginConfig(cfg as Record<string, unknown> | undefined, "xai")
      ?.apiKey,
    path: "plugins.entries.xai.config.webSearch.apiKey",
    cfg,
    expectedEnvId: XAI_API_KEY_ENV_VAR,
    normalizeValue: normalizeSecretInputString,
  });
}

function resolveConfiguredXaiToolApiKeyResult(params: {
  runtimeConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
}): ReadOnlyEnvSecretRefResolution {
  const runtimePlugin = readPluginXaiWebSearchApiKeyResult(params.runtimeConfig);
  return runtimePlugin.status === "missing"
    ? readPluginXaiWebSearchApiKeyResult(params.sourceConfig)
    : runtimePlugin;
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
  return undefined;
}

export async function resolveXaiToolAuth(params: {
  runtimeConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  auth?: XaiToolAuthContext;
}): Promise<XaiToolAuth | undefined> {
  const configured = resolveConfiguredXaiToolApiKeyResult(params);
  if (configured.status === "available") {
    return { apiKey: configured.value, mode: "api-key" };
  }
  if (configured.status === "blocked") {
    return undefined;
  }
  const selected = await params.auth?.resolveAuthForProvider?.(XAI_PROVIDER_ID);
  if (selected) {
    return selected;
  }
  const apiKey = readProviderEnvValue([XAI_API_KEY_ENV_VAR]);
  return apiKey ? { apiKey, mode: "api-key" } : undefined;
}

export function isXaiToolEnabled(params: {
  enabled?: boolean;
  runtimeConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  auth?: XaiToolAuthContext;
}): boolean {
  if (params.enabled === false) {
    return false;
  }
  const configured = resolveConfiguredXaiToolApiKeyResult(params);
  if (configured.status === "available") {
    return true;
  }
  if (configured.status === "blocked") {
    return false;
  }
  return (
    params.auth?.hasAuthForProvider?.(XAI_PROVIDER_ID) === true ||
    Boolean(readProviderEnvValue([XAI_API_KEY_ENV_VAR]))
  );
}
