import {
  CUSTOM_LOCAL_AUTH_MARKER,
  hasConfiguredSecretInput,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER } from "./defaults.js";

export function hasLmstudioAuthorizationHeader(headers: unknown): boolean {
  return Object.entries(asOptionalRecord(headers) ?? {}).some(
    ([name, value]) =>
      name.trim().toLowerCase() === "authorization" && hasConfiguredSecretInput(value),
  );
}

export function resolveLmstudioProviderAuthMode(
  apiKey: ModelProviderConfig["apiKey"] | undefined,
): ModelProviderConfig["auth"] | undefined {
  const normalized = normalizeOptionalSecretInput(apiKey);
  if (normalized !== undefined) {
    return normalized === LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER ||
      normalized === CUSTOM_LOCAL_AUTH_MARKER
      ? undefined
      : "api-key";
  }
  return hasConfiguredSecretInput(apiKey) ? "api-key" : undefined;
}

export function shouldUseLmstudioApiKeyPlaceholder(params: {
  hasModels: boolean;
  resolvedApiKey: ModelProviderConfig["apiKey"] | undefined;
  hasAuthorizationHeader?: boolean;
}): boolean {
  return params.hasModels && !params.resolvedApiKey && !params.hasAuthorizationHeader;
}

export function resolvePersistedLmstudioApiKey(params: {
  currentApiKey: ModelProviderConfig["apiKey"] | undefined;
  explicitAuth: ModelProviderConfig["auth"] | undefined;
  fallbackApiKey: ModelProviderConfig["apiKey"] | undefined;
  preferFallbackApiKey?: boolean;
  hasModels: boolean;
  hasAuthorizationHeader?: boolean;
}): ModelProviderConfig["apiKey"] | undefined {
  if (params.explicitAuth === "api-key") {
    if (params.preferFallbackApiKey && params.fallbackApiKey !== undefined) {
      return params.fallbackApiKey;
    }
    if (resolveLmstudioProviderAuthMode(params.currentApiKey)) {
      return params.currentApiKey;
    }
    return params.fallbackApiKey;
  }
  return shouldUseLmstudioApiKeyPlaceholder({
    hasModels: params.hasModels,
    resolvedApiKey: params.currentApiKey,
    hasAuthorizationHeader: params.hasAuthorizationHeader,
  })
    ? LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER
    : undefined;
}
