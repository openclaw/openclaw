/**
 * TrustedRouter model provider builder.
 */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildTrustedRouterCatalogModels, TRUSTEDROUTER_BASE_URL } from "./models.js";

/** Builds the TrustedRouter OpenAI-compatible model provider config. */
export function buildTrustedRouterProvider(): ModelProviderConfig {
  return {
    baseUrl: TRUSTEDROUTER_BASE_URL,
    api: "openai-completions",
    models: buildTrustedRouterCatalogModels(),
  };
}
