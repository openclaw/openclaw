import {
  CUSTOM_LOCAL_AUTH_MARKER,
  hasConfiguredSecretInput,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER } from "./defaults.js";

export function hasLmstudioAuthorizationHeader(headers: unknown): boolean {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return false;
  }
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.trim().toLowerCase() !== "authorization") {
      continue;
    }
    if (hasConfiguredSecretInput(headerValue)) {
      return true;
    }
  }
  return false;
}

export function resolveLmstudioProviderAuthMode(
  apiKey: ModelProviderConfig["apiKey"] | undefined,
): ModelProviderConfig["auth"] | undefined {
  const normalized = normalizeOptionalSecretInput(apiKey);
  if (normalized !== undefined) {
    const trimmed = normalized.trim();
    if (
      !trimmed ||
      trimmed === LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER ||
      trimmed === CUSTOM_LOCAL_AUTH_MARKER
    ) {
      return undefined;
    }
    return "api-key";
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

export function shouldUseLmstudioSyntheticAuth(
  providerConfig: ModelProviderConfig | undefined,
): boolean {
  const hasModels = Array.isArray(providerConfig?.models) && providerConfig.models.length > 0;
  // Runtime synthetic auth is independent from explicit Authorization headers.
  // LM Studio can authenticate entirely through models.providers.lmstudio.headers.Authorization,
  // and removing the provider-owned marker lets core fall back to generic local no-auth behavior.
  return hasModels && !resolveLmstudioProviderAuthMode(providerConfig?.apiKey);
}
