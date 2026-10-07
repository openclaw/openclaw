import path from "node:path";
import {
  getEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderAdapter,
  type EmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/embedding-providers";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
  LLAMA_CPP_PROVIDER_ID,
  resolveLegacyLlamaCppModelCacheDir,
  resolveLlamaCppEmbeddingModel,
  resolveLlamaCppModelCacheDir,
} from "./defaults.js";
import { resolveManagedLlamaCppProviderConfig } from "./managed-provider-config.js";
import {
  ensureLlamaCppModel,
  inspectLlamaServerRuntime,
  prepareManagedLlamaServer,
  reconcileManagedLlamaServer as reconcileLocalService,
  type LlamaServerRuntimeFacts,
} from "./managed-server.js";

type AcquireLocalService = OpenClawPluginApi["runtime"]["llm"]["acquireLocalService"];
type LocalServiceAwareOptions = EmbeddingProviderCreateOptions & {
  acquireLocalService?: AcquireLocalService;
};

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");

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
    ...(typeof dimensions === "number" ? { outputDimensionality: dimensions } : {}),
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

function resolveProviderPort(provider: ModelProviderConfig): number {
  const port = Number(new URL(provider.baseUrl ?? "").port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Managed llama.cpp provider baseUrl must include a loopback port.");
  }
  return port;
}

async function prepareEmbeddingServer(
  options: EmbeddingProviderCreateOptions,
  embeddingSource: string,
  embeddingModelIsDefault: boolean,
): Promise<void> {
  const provider = resolveManagedLlamaCppProviderConfig(options.config);
  const cacheDir = resolveLlamaCppModelCacheDir(provider);
  const embeddingModelPath = await ensureLlamaCppModel({
    source: embeddingSource,
    cacheDir,
    download: true,
  });
  await prepareManagedLlamaServer({
    chatModel: { mode: "preserve" },
    configuredChatModelIds: provider.models.map((model) => model.id),
    embeddingModelIsDefault,
    embeddingModelPath,
    port: resolveProviderPort(provider),
    reconcileBaseUrl: provider.baseUrl,
    localService: provider.localService,
  });
}

function wrapProvider(params: {
  provider: EmbeddingProvider;
  canonicalModel: string;
  baseUrl: string;
}): EmbeddingProvider {
  let runtimeFacts: LlamaServerRuntimeFacts | undefined;
  const refreshFacts = async (loadError?: string) => {
    runtimeFacts = await inspectLlamaServerRuntime({
      baseUrl: params.baseUrl,
      modelId: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
      loadError,
    });
  };
  const withFacts = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      const value = await operation();
      await refreshFacts();
      return value;
    } catch (error) {
      await refreshFacts(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const wrapped: EmbeddingProvider = {
    id: "local",
    model: params.canonicalModel,
    dimensions: params.provider.dimensions,
    maxInputTokens: params.provider.maxInputTokens,
    embed: (input, callOptions) => withFacts(() => params.provider.embed(input, callOptions)),
    embedBatch: (inputs, callOptions) =>
      withFacts(() => params.provider.embedBatch(inputs, callOptions)),
    close: params.provider.close,
  };
  Object.defineProperty(wrapped, LOCAL_EMBEDDING_RUNTIME_FACTS, {
    enumerable: false,
    value: () => runtimeFacts,
  });
  return wrapped;
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
    const embeddingModel = resolveLlamaCppEmbeddingModel(local);
    const identity = resolveModelIdentity(local, options.dimensions);
    await prepareEmbeddingServer(options, embeddingModel.source, embeddingModel.isDefault);
    const genericAdapter = getEmbeddingProvider("openai-compatible", options.config);
    if (!genericAdapter) {
      throw new Error("OpenAI-compatible embedding transport is unavailable.");
    }
    const acquireLocalService = (options as LocalServiceAwareOptions).acquireLocalService; // SAFETY: core runtime owns this injected option.
    const result = await genericAdapter.create({
      ...options,
      provider: LLAMA_CPP_PROVIDER_ID,
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
      remote: undefined,
      ...(acquireLocalService
        ? {
            acquireLocalService: (...[target, signal]: Parameters<AcquireLocalService>) =>
              acquireLocalService({ ...target, reconcile: reconcileLocalService }, signal),
          }
        : {}),
    });
    if (!result.provider) {
      return result;
    }
    return {
      provider: wrapProvider({
        provider: result.provider,
        canonicalModel: identity.model,
        baseUrl: resolveManagedLlamaCppProviderConfig(options.config).baseUrl ?? "",
      }),
      runtime: {
        id: "local",
        inlineQueryTimeoutMs: 5 * 60_000,
        inlineBatchTimeoutMs: 10 * 60_000,
        cacheKeyData: identity.cacheKeyData,
        ...(identity.aliases.length > 0 ? { indexIdentityAliases: identity.aliases } : {}),
      },
    };
  },
};
