import path from "node:path";
import type {
  EmbeddingProviderAdapter,
  EmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/embedding-providers";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  LLAMA_CPP_PROVIDER_ID,
  resolveLegacyLlamaCppModelCacheDir,
  resolveLlamaCppEmbeddingModel,
  resolveLlamaCppModelCacheDir,
} from "./defaults.js";

function readIdentityLocalOptions(options: EmbeddingProviderCreateOptions) {
  const local = options.local ?? {};
  const provider = options.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  return provider?.localService
    ? { ...local, modelCacheDir: resolveLlamaCppModelCacheDir(provider) }
    : local;
}

function createCacheKeyData(model: string, dimensions?: number): Record<string, unknown> {
  return {
    provider: "local",
    model,
    ...(dimensions !== undefined ? { outputDimensionality: dimensions } : {}),
  };
}

function resolveModelIdentity(local: EmbeddingProviderCreateOptions["local"], dimensions?: number) {
  const embeddingModel = resolveLlamaCppEmbeddingModel(local);
  const model = embeddingModel.isDefault
    ? DEFAULT_LLAMA_CPP_EMBEDDING_MODEL
    : embeddingModel.source;
  const aliases = new Set<string>();
  if (embeddingModel.isDefault) {
    aliases.add(path.resolve(embeddingModel.cacheDir, DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE));
    aliases.add(
      path.resolve(resolveLegacyLlamaCppModelCacheDir(), DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE),
    );
    aliases.add(DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE);
    if (embeddingModel.source !== model) {
      aliases.add(embeddingModel.source);
    }
  }
  return {
    model,
    cacheKeyData: createCacheKeyData(model, dimensions),
    aliases: [...aliases].map((alias) => ({
      model: alias,
      cacheKeyData: createCacheKeyData(alias, dimensions),
    })),
  };
}

export const llamaCppEmbeddingProviderAdapter: EmbeddingProviderAdapter = {
  id: "local",
  defaultModel: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  transport: "local",
  formatSetupError: (error) =>
    `Managed local embeddings are unavailable. Run \`openclaw configure\`, choose llama.cpp, and retry. ${error instanceof Error ? error.message : String(error)}`,
  resolveIndexIdentity: (options) => {
    const local = readIdentityLocalOptions(options);
    return resolveModelIdentity(local, options.dimensions);
  },
  create: async (options) => {
    const local = readIdentityLocalOptions(options);
    const { createLlamaCppEmbeddingProvider } = await import("./embedding-provider.runtime.js");
    return createLlamaCppEmbeddingProvider(
      options,
      resolveLlamaCppEmbeddingModel(local).source,
      resolveModelIdentity(local, options.dimensions),
    );
  },
};
