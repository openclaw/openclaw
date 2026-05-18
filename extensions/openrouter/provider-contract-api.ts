import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

export function createOpenrouterProvider(): ProviderPlugin {
  return {
    id: "openrouter",
    label: "OpenRouter",
    docsPath: "/providers/models",
    envVars: ["OPENROUTER_API_KEY"],
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        label: "OpenRouter API key",
        hint: "API key",
        run: async () => ({ profiles: [] }),
        wizard: {
          choiceId: "openrouter-api-key",
          choiceLabel: "OpenRouter API key",
          groupId: "openrouter",
          groupLabel: "OpenRouter",
          groupHint: "API key",
          onboardingScopes: ["text-inference", "music-generation"],
        },
      },
    ],
  };
}

export function createTrustedRouterProvider(): ProviderPlugin {
  return {
    id: "trustedrouter",
    label: "TrustedRouter.com",
    docsPath: "/providers/trustedrouter",
    envVars: ["TRUSTEDROUTER_API_KEY"],
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        label: "TrustedRouter.com API key",
        hint: "E2EE OpenRouter-compatible API key",
        run: async () => ({ profiles: [] }),
        wizard: {
          choiceId: "trustedrouter-api-key",
          choiceLabel: "TrustedRouter.com API key",
          choiceHint: "End-to-end encrypted OpenRouter-compatible router",
          groupId: "openrouter",
          groupLabel: "OpenRouter-compatible routers",
          groupHint: "API key",
          onboardingScopes: ["text-inference"],
        },
      },
    ],
  };
}
