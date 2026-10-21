import {
  getEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderCreateOptions,
  type EmbeddingProviderCreateResult,
  type EmbeddingProviderIndexIdentity,
} from "openclaw/plugin-sdk/embedding-providers";
import { sanitizeAndNormalizeEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_CONTEXT_SIZE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
  LLAMA_CPP_PROVIDER_ID,
  resolveLlamaCppModelCacheDir,
} from "./defaults.js";
import { resolveManagedLlamaCppProviderConfig } from "./managed-provider-config.js";
import {
  inspectLlamaServerRuntime,
  type LlamaServerRuntimeFacts,
} from "./managed-server-inspection.js";
import {
  ensureLlamaCppModel,
  prepareManagedLlamaServer,
  reconcileManagedLlamaServer as reconcileLocalService,
} from "./managed-server.js";
import { resolveLlamaCppMediaModels } from "./media-config.js";

type AcquireLocalService = OpenClawPluginApi["runtime"]["llm"]["acquireLocalService"];
type LocalServiceAwareOptions = EmbeddingProviderCreateOptions & {
  acquireLocalService?: AcquireLocalService;
};

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");

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
): Promise<void> {
  const provider = resolveManagedLlamaCppProviderConfig(options.config);
  const mediaModels = resolveLlamaCppMediaModels(provider);
  const cacheDir = resolveLlamaCppModelCacheDir(provider);
  const embeddingModelPath = await ensureLlamaCppModel({
    source: embeddingSource,
    cacheDir,
    download: true,
  });
  await prepareManagedLlamaServer({
    chatModel: { mode: "preserve" },
    configuredChatModelIds: provider.models.map((model) => model.id),
    ...(mediaModels ? { mediaModels: [] } : {}),
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
  dimensions?: number;
}): EmbeddingProvider {
  const normalize = (vector: number[]): number[] => {
    if (params.dimensions !== undefined && vector.length < params.dimensions) {
      throw Object.assign(
        new Error(
          `Local embeddings expected ${params.dimensions} dimensions, got ${vector.length}; reduce or remove memory.search.outputDimensionality or request dimensions.`,
        ),
        {
          code: "INVALID_EMBEDDING_RESPONSE",
          expectedDimensions: params.dimensions,
          actualDimensions: vector.length,
        },
      );
    }
    // Preserve local GGUF projection: truncate before restoring unit length.
    return sanitizeAndNormalizeEmbedding(
      params.dimensions === undefined ? vector : vector.slice(0, params.dimensions),
    );
  };
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
    dimensions: params.dimensions,
    // Reserve BOS/EOS, a possible SentencePiece prefix, and the causal context boundary.
    maxInputTokens: params.provider.maxInputTokens ?? DEFAULT_LLAMA_CPP_EMBEDDING_CONTEXT_SIZE - 4,
    embed: (input, callOptions) =>
      withFacts(async () => normalize(await params.provider.embed(input, callOptions))),
    embedBatch: (inputs, callOptions) =>
      withFacts(async () => (await params.provider.embedBatch(inputs, callOptions)).map(normalize)),
    close: params.provider.close,
  };
  Object.defineProperty(wrapped, LOCAL_EMBEDDING_RUNTIME_FACTS, {
    enumerable: false,
    value: () => runtimeFacts,
  });
  return wrapped;
}

export async function createLlamaCppEmbeddingProvider(
  options: EmbeddingProviderCreateOptions,
  embeddingSource: string,
  identity: EmbeddingProviderIndexIdentity,
): Promise<EmbeddingProviderCreateResult> {
  if (
    options.dimensions !== undefined &&
    (!Number.isInteger(options.dimensions) || options.dimensions <= 0)
  ) {
    throw new Error("Local embeddings dimensions must be a positive integer.");
  }
  await prepareEmbeddingServer(options, embeddingSource);
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
    // The local wrapper owns projection; llama-server always returns native vectors.
    dimensions: undefined,
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
      dimensions: options.dimensions,
    }),
    runtime: {
      id: "local",
      inlineQueryTimeoutMs: 5 * 60_000,
      inlineBatchTimeoutMs: 10 * 60_000,
      cacheKeyData: identity.cacheKeyData,
      ...((identity.aliases?.length ?? 0) > 0 ? { indexIdentityAliases: identity.aliases } : {}),
    },
  };
}
