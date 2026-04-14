import { MODEL_APIS } from "../config/types.models.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

const GENERIC_PROVIDER_APIS = new Set<string>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

export function resolveProviderPluginLookupKey(
  providerKey: string,
  provider?: ProviderConfig,
): string {
  const api = normalizeOptionalString(provider?.api) ?? "";
  if (
    providerKey === "google-antigravity" ||
    providerKey === "google-vertex" ||
    api === "google-generative-ai"
  ) {
    return "google";
  }
  // Runtime-constructed providers (e.g. the openrouter plugin) can surface a
  // `models` value that isn't an array (see #66744). The static type says
  // `models: ModelDefinitionConfig[]`, but trusting it here crashed HTTP
  // `/v1/chat/completions` with `provider?.models?.some is not a function`.
  if (
    Array.isArray(provider?.models) &&
    provider.models.some((model) => normalizeOptionalString(model.api) === "google-generative-ai")
  ) {
    return "google";
  }
  if (
    api &&
    MODEL_APIS.includes(api as (typeof MODEL_APIS)[number]) &&
    !GENERIC_PROVIDER_APIS.has(api)
  ) {
    return api;
  }
  return providerKey;
}
