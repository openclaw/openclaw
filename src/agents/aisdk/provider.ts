/**
 * AI SDK v6 provider management for openclaw.
 *
 * Supports two modes:
 * - "gateway": Vercel AI Gateway for unified access to all providers
 * - "direct": Provider-specific SDK packages for full control
 *
 * This module is fork-friendly: all AI SDK code lives in this separate
 * directory to avoid merge conflicts when pulling upstream updates.
 */

import type { LanguageModel } from "ai";
import type {
  AiSdkConfig,
  DirectProviderId,
  DirectProviderConfig,
  GatewayConfig,
  ModelRef,
  ResolvedModel,
} from "./types.js";

// Lazy-loaded provider factories to avoid importing unused providers
type ProviderFactory = (config: DirectProviderConfig) => {
  languageModel: (modelId: string) => LanguageModel;
};

const providerFactories: Record<DirectProviderId, () => Promise<ProviderFactory>> = {
  anthropic: async () => {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return (config) => createAnthropic({ apiKey: config.apiKey, baseURL: config.baseUrl });
  },
  openai: async () => {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return (config) => createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  },
  google: async () => {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    return (config) => createGoogleGenerativeAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  },
  "amazon-bedrock": async () => {
    const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
    return (config) =>
      createAmazonBedrock(config.options as Parameters<typeof createAmazonBedrock>[0]);
  },
  azure: async () => {
    const { createAzure } = await import("@ai-sdk/azure");
    return (config) => createAzure({ apiKey: config.apiKey, baseURL: config.baseUrl });
  },
  groq: async () => {
    const { createGroq } = await import("@ai-sdk/groq");
    return (config) => createGroq({ apiKey: config.apiKey, baseURL: config.baseUrl });
  },
  mistral: async () => {
    const { createMistral } = await import("@ai-sdk/mistral");
    return (config) => createMistral({ apiKey: config.apiKey, baseURL: config.baseUrl });
  },
  xai: async () => {
    const { createXai } = await import("@ai-sdk/xai");
    return (config) => createXai({ apiKey: config.apiKey, baseURL: config.baseUrl });
  },
  openrouter: async () => {
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    return (config) => createOpenRouter({ apiKey: config.apiKey, baseURL: config.baseUrl });
  },
  "openai-compatible": async () => {
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    return (config) => createOpenAICompatible({ baseURL: config.baseUrl ?? "", name: "custom" });
  },
};

// Cache for initialized providers
const providerCache = new Map<string, Awaited<ReturnType<ProviderFactory>>>();

/**
 * Parse a model reference into provider and model IDs.
 * @example parseModelRef("anthropic/claude-sonnet-4") => { providerId: "anthropic", modelId: "claude-sonnet-4" }
 */
export function parseModelRef(ref: string): { providerId: string; modelId: string } {
  const slashIndex = ref.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(`Invalid model reference "${ref}": expected format "provider/model-id"`);
  }
  return {
    providerId: ref.slice(0, slashIndex),
    modelId: ref.slice(slashIndex + 1),
  };
}

/**
 * Get a language model using AI Gateway.
 * AI Gateway uses the format "provider/model-id" directly.
 */
async function getGatewayModel(modelRef: string, config: GatewayConfig): Promise<ResolvedModel> {
  const { createGateway } = await import("@ai-sdk/gateway");
  const { providerId, modelId } = parseModelRef(modelRef);

  const gateway = createGateway({
    apiKey: config.apiKey ?? process.env.AI_GATEWAY_API_KEY,
    baseURL: config.baseUrl,
  });

  const model = gateway.languageModel(modelRef);

  return {
    model,
    providerId,
    modelId,
    ref: modelRef as ModelRef,
  };
}

/**
 * Get a language model using direct provider SDK.
 */
async function getDirectModel(modelRef: string, config: AiSdkConfig): Promise<ResolvedModel> {
  const { providerId, modelId } = parseModelRef(modelRef);

  // Check if provider is supported
  const factoryLoader = providerFactories[providerId as DirectProviderId];
  if (!factoryLoader) {
    throw new Error(
      `Unsupported provider "${providerId}". ` +
        `Supported providers: ${Object.keys(providerFactories).join(", ")}. ` +
        `Consider using mode: "gateway" for access to more providers.`,
    );
  }

  // Get provider config
  const providerConfig = config.providers?.[providerId as DirectProviderId] ?? {};

  // Try to get API key from environment if not configured
  const apiKey = providerConfig.apiKey ?? getEnvApiKey(providerId);
  const configWithKey = { ...providerConfig, apiKey };

  // Get or create cached provider instance
  const cacheKey = `${providerId}:${JSON.stringify(configWithKey)}`;
  let provider = providerCache.get(cacheKey);
  if (!provider) {
    const factory = await factoryLoader();
    provider = factory(configWithKey);
    providerCache.set(cacheKey, provider);
  }

  const model = provider.languageModel(modelId);

  return {
    model,
    providerId,
    modelId,
    ref: modelRef as ModelRef,
  };
}

/**
 * Get API key from environment variables for a provider.
 */
function getEnvApiKey(providerId: string): string | undefined {
  const envVarMap: Record<string, string[]> = {
    anthropic: ["ANTHROPIC_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
    groq: ["GROQ_API_KEY"],
    mistral: ["MISTRAL_API_KEY"],
    xai: ["XAI_API_KEY"],
    openrouter: ["OPENROUTER_API_KEY"],
    azure: ["AZURE_API_KEY"],
  };

  const vars = envVarMap[providerId];
  if (!vars) {
    return undefined;
  }

  for (const varName of vars) {
    const value = process.env[varName];
    if (value) {
      return value;
    }
  }
  return undefined;
}

/**
 * Resolve a model reference to an AI SDK language model.
 *
 * @param modelRef - Model reference in format "provider/model-id"
 * @param config - AI SDK configuration
 * @returns Resolved model ready for use with streamText/generateText
 *
 * @example
 * const model = await resolveModel("anthropic/claude-sonnet-4", { mode: "gateway" });
 * const result = await streamText({ model: model.model, ... });
 */
export async function resolveModel(modelRef: string, config: AiSdkConfig): Promise<ResolvedModel> {
  if (config.mode === "gateway") {
    return getGatewayModel(modelRef, config.gateway ?? {});
  }
  return getDirectModel(modelRef, config);
}

/**
 * Get default AI SDK configuration.
 * Reads from environment variables and returns sensible defaults.
 */
export function getDefaultConfig(): AiSdkConfig {
  // Check for AI Gateway key first (simplest setup)
  if (process.env.AI_GATEWAY_API_KEY) {
    return {
      mode: "gateway",
      gateway: { apiKey: process.env.AI_GATEWAY_API_KEY },
      defaultModel: "anthropic/claude-sonnet-4" as ModelRef,
    };
  }

  // Fall back to direct mode, auto-detecting available providers
  return {
    mode: "direct",
    providers: {},
    defaultModel: "anthropic/claude-sonnet-4" as ModelRef,
  };
}

/**
 * Validate that the configuration is usable.
 * Returns an error message if invalid, or null if valid.
 */
export function validateConfig(config: AiSdkConfig): string | null {
  if (config.mode === "gateway") {
    if (!config.gateway?.apiKey && !process.env.AI_GATEWAY_API_KEY) {
      return "AI Gateway mode requires AI_GATEWAY_API_KEY environment variable or gateway.apiKey config";
    }
    return null;
  }

  // Direct mode: check if at least one provider has credentials
  const hasAnyKey = Object.keys(providerFactories).some(
    (provider) =>
      config.providers?.[provider as DirectProviderId]?.apiKey || getEnvApiKey(provider),
  );

  if (!hasAnyKey) {
    return "Direct mode requires at least one provider API key (e.g., ANTHROPIC_API_KEY, OPENAI_API_KEY)";
  }

  return null;
}

/**
 * List available providers based on configuration and environment.
 */
export function listAvailableProviders(config: AiSdkConfig): string[] {
  if (config.mode === "gateway") {
    // Gateway mode supports all providers through the gateway
    return ["anthropic", "openai", "google", "groq", "mistral", "xai", "amazon-bedrock", "azure"];
  }

  // Direct mode: only providers with API keys available
  return Object.keys(providerFactories).filter(
    (provider) =>
      config.providers?.[provider as DirectProviderId]?.apiKey || getEnvApiKey(provider),
  );
}
