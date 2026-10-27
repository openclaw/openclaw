// Synthetic auth and endpoint configuration for OpenAI image provider tests.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export function openAIImageConfig(provider: Omit<ModelProviderConfig, "models">): OpenClawConfig {
  return { models: { providers: { openai: { ...provider, models: [] } } } };
}

function createOpenAIOAuthProfile(access = "codex-access", refresh = "codex-refresh") {
  return {
    type: "oauth" as const,
    provider: "openai",
    access,
    refresh,
    expires: Date.now() + 60_000,
  };
}

export function createCodexOAuthAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      "openai:default": createOpenAIOAuthProfile(),
    },
  };
}

export function createCodexApiKeyAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      "openai:manual": {
        type: "api_key" as const,
        provider: "openai",
        key: "codex-api-key",
      },
    },
  };
}

export function createCodexTokenAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      "openai:token": {
        type: "token" as const,
        provider: "openai",
        token: "codex-token",
      },
    },
  };
}

export function createMixedCodexAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      ...createCodexTokenAuthStore().profiles,
      ...createCodexApiKeyAuthStore().profiles,
    },
  };
}

export function createMixedOpenAIAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      "openai:chatgpt": createOpenAIOAuthProfile(),
      "openai:default": {
        type: "api_key" as const,
        provider: "openai",
        key: "openai-key",
      },
    },
  };
}
