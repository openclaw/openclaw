import {
  CUSTOM_LOCAL_AUTH_MARKER,
  hasConfiguredSecretInput,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LLAMA_CPP_LOCAL_AUTH_MARKER } from "../defaults.js";

export function hasLlamaServerAuthorizationHeader(headers: unknown): boolean {
  const record = asOptionalRecord(headers);
  if (!record) {
    return false;
  }
  return Object.entries(record).some(
    ([name, value]) =>
      name.trim().toLowerCase() === "authorization" && hasConfiguredSecretInput(value),
  );
}

export function shouldUseLlamaServerSyntheticAuth(
  providerConfig: ModelProviderConfig | undefined,
): boolean {
  const apiKey = normalizeOptionalSecretInput(providerConfig?.apiKey)?.trim();
  const hasRealApiKey =
    hasConfiguredSecretInput(providerConfig?.apiKey) &&
    apiKey !== LLAMA_CPP_LOCAL_AUTH_MARKER &&
    apiKey !== CUSTOM_LOCAL_AUTH_MARKER;
  return !hasRealApiKey;
}
