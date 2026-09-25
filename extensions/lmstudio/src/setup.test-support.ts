import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-setup";
import {
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
  LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
} from "./defaults.js";
import { discoverLmstudioProvider } from "./setup.js";

export function createModel(): ModelDefinitionConfig {
  return {
    id: "qwen3-8b-instruct",
    name: "Qwen3 8B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 8192,
  };
}

export function buildConfig(
  provider: Partial<ModelProviderConfig> = {
    apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    api: "openai-completions",
  },
  config: Omit<OpenClawConfig, "models"> = {},
): OpenClawConfig {
  return {
    ...config,
    models: {
      providers: {
        lmstudio: {
          baseUrl: LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
          models: [],
          ...provider,
        },
      },
    },
  };
}

export function buildDiscoveryContext(params?: {
  config?: OpenClawConfig;
  apiKey?: string;
  discoveryApiKey?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderCatalogContext {
  return {
    config: params?.config ?? ({} as OpenClawConfig),
    env: params?.env ?? {},
    resolveProviderApiKey: () => ({
      apiKey: params?.apiKey,
      discoveryApiKey: params?.discoveryApiKey,
    }),
    resolveProviderAuth: () => ({
      apiKey: params?.apiKey,
      discoveryApiKey: params?.discoveryApiKey,
      mode: "none" as const,
      source: "none" as const,
    }),
  };
}

export function runDiscovery(
  provider: Partial<ModelProviderConfig>,
  context: Omit<NonNullable<Parameters<typeof buildDiscoveryContext>[0]>, "config"> = {},
) {
  return discoverLmstudioProvider(
    buildDiscoveryContext({ config: buildConfig(provider), ...context }),
  );
}
