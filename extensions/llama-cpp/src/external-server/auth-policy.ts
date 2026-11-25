import {
  CUSTOM_LOCAL_AUTH_MARKER,
  hasConfiguredSecretInput,
  isNonSecretApiKeyMarker,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LLAMA_APP_SERVER, LLAMA_CPP_SERVER, type LlamaServerIdentity } from "./defaults.js";

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

/** The host recognizes bundled markers; this external plugin owns its discovery marker. */
export function resolveLlamaServerRequestApiKey(
  server: LlamaServerIdentity,
  resolved: string | undefined,
): string | undefined {
  const key = resolved?.trim();
  return key && key !== server.authMarker && !isNonSecretApiKeyMarker(key) ? key : undefined;
}

export function shouldUseLlamaServerSyntheticAuth(
  providerConfig: ModelProviderConfig | undefined,
): boolean {
  const apiKey = normalizeOptionalSecretInput(providerConfig?.apiKey)?.trim();
  const hasRealApiKey =
    hasConfiguredSecretInput(providerConfig?.apiKey) &&
    apiKey !== LLAMA_CPP_SERVER.authMarker &&
    apiKey !== LLAMA_APP_SERVER.authMarker &&
    apiKey !== CUSTOM_LOCAL_AUTH_MARKER;
  return !hasRealApiKey;
}
