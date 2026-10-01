import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { GOOGLE_GEMINI_CLI_PROVIDER_ID } from "./gemini-cli-auth-home.js";
import { formatGoogleOauthApiKey } from "./oauth-token-shared.js";
import { createGoogleGeminiCliProvider } from "./provider-contract-api.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";

export function buildGoogleGeminiCliProvider(): ProviderPlugin {
  return {
    ...createGoogleGeminiCliProvider(),
    resolveDynamicModel: (ctx) =>
      resolveGoogleGeminiForwardCompatModel({
        providerId: GOOGLE_GEMINI_CLI_PROVIDER_ID,
        ctx,
      }),
    ...GOOGLE_GEMINI_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
    formatApiKey: formatGoogleOauthApiKey,
  };
}
