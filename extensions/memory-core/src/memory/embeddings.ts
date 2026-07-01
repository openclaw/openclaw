// Memory Core plugin module implements embeddings behavior.
import {
  getEmbeddingProvider,
  type EmbeddingProviderAdapter,
  type EmbeddingProvider as GenericEmbeddingProvider,
  type EmbeddingProviderRuntime as GenericEmbeddingProviderRuntime,
} from "openclaw/plugin-sdk/embedding-providers";
import {
  getMemoryEmbeddingProvider as getLegacyMemoryEmbeddingProvider,
  listMemoryEmbeddingProviders,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderAdapter,
  type MemoryEmbeddingProviderCreateOptions,
  type MemoryEmbeddingProviderRuntime,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { formatErrorMessage } from "../dreaming-shared.js";

export type EmbeddingProvider = MemoryEmbeddingProvider;
export type EmbeddingProviderId = string;
export type EmbeddingProviderRequest = string;
type EmbeddingProviderFallback = string;
export type EmbeddingProviderRuntime = MemoryEmbeddingProviderRuntime;

export type EmbeddingProviderResult = {
  provider: EmbeddingProvider | null;
  requestedProvider: EmbeddingProviderRequest;
  fallbackFrom?: string;
  fallbackReason?: string;
  providerUnavailableReason?: string;
  runtime?: EmbeddingProviderRuntime;
};

type CreateEmbeddingProviderOptions = MemoryEmbeddingProviderCreateOptions & {
  provider: EmbeddingProviderRequest;
  fallback: EmbeddingProviderFallback;
};

const LOCAL_LLAMA_CPP_PROVIDER_ID = "local";

function createMissingLlamaCppProviderError(): Error {
  return new Error(
    [
      "Unknown memory embedding provider: local.",
      "Local GGUF embeddings are provided by the official llama.cpp provider plugin.",
      "Install it with: openclaw plugins install @openclaw/llama-cpp-provider",
      "Then restart OpenClaw and retry: openclaw memory status --deep",
    ].join("\n"),
  );
}

function adaptGenericEmbeddingProvider(
  provider: GenericEmbeddingProvider,
): MemoryEmbeddingProvider {
  return {
    id: provider.id,
    model: provider.model,
    ...(typeof provider.maxInputTokens === "number"
      ? { maxInputTokens: provider.maxInputTokens }
      : {}),
    embedQuery: async (text, options) =>
      await provider.embed(text, {
        ...options,
        inputType: "query",
      }),
    embedBatch: async (texts, options) =>
      await provider.embedBatch(texts, {
        ...options,
        inputType: "document",
      }),
    embedBatchInputs: async (inputs, options) =>
      await provider.embedBatch(inputs, {
        ...options,
        inputType: "document",
      }),
    ...(provider.close ? { close: provider.close } : {}),
  };
}

function adaptGenericRuntime(
  runtime: GenericEmbeddingProviderRuntime | undefined,
): MemoryEmbeddingProviderRuntime | undefined {
  if (!runtime) {
    return undefined;
  }
  return {
    id: runtime.id,
    ...(runtime.cacheKeyData ? { cacheKeyData: runtime.cacheKeyData } : {}),
    ...(runtime.indexIdentityAliases?.length
      ? { indexIdentityAliases: runtime.indexIdentityAliases }
      : {}),
    ...(typeof runtime.inlineQueryTimeoutMs === "number"
      ? { inlineQueryTimeoutMs: runtime.inlineQueryTimeoutMs }
      : {}),
    ...(typeof runtime.inlineBatchTimeoutMs === "number"
      ? { inlineBatchTimeoutMs: runtime.inlineBatchTimeoutMs }
      : {}),
  };
}

function adaptGenericEmbeddingAdapter(
  adapter: EmbeddingProviderAdapter,
): MemoryEmbeddingProviderAdapter {
  const resolveIndexIdentity = adapter.resolveIndexIdentity;
  return {
    id: adapter.id,
    ...(adapter.defaultModel ? { defaultModel: adapter.defaultModel } : {}),
    ...(adapter.transport ? { transport: adapter.transport } : {}),
    ...(adapter.authProviderId ? { authProviderId: adapter.authProviderId } : {}),
    ...(adapter.formatSetupError ? { formatSetupError: adapter.formatSetupError } : {}),
    ...(resolveIndexIdentity
      ? {
          resolveIndexIdentity: (options: MemoryEmbeddingProviderCreateOptions) =>
            resolveIndexIdentity({
              ...options,
              ...(typeof options.outputDimensionality === "number"
                ? { dimensions: options.outputDimensionality }
                : {}),
            }),
        }
      : {}),
    create: async (options) => {
      const result = await adapter.create({
        ...options,
        ...(typeof options.outputDimensionality === "number"
          ? { dimensions: options.outputDimensionality }
          : {}),
      });
      return {
        provider: result.provider ? adaptGenericEmbeddingProvider(result.provider) : null,
        runtime: adaptGenericRuntime(result.runtime),
      };
    },
  };
}

function formatProviderError(adapter: MemoryEmbeddingProviderAdapter, err: unknown): string {
  return adapter.formatSetupError?.(err) ?? formatErrorMessage(err);
}

function shouldContinueAutoSelection(
  adapter: MemoryEmbeddingProviderAdapter,
  err: unknown,
): boolean {
  return adapter.shouldContinueAutoSelection?.(err) ?? false;
}

function listAutoSelectAdapters(): MemoryEmbeddingProviderAdapter[] {
  return listMemoryEmbeddingProviders()
    .filter((adapter) => typeof adapter.autoSelectPriority === "number")
    .toSorted(
      (a, b) =>
        (a.autoSelectPriority ?? Number.MAX_SAFE_INTEGER) -
        (b.autoSelectPriority ?? Number.MAX_SAFE_INTEGER),
    );
}

function getAdapter(
  id: string,
  config?: MemoryEmbeddingProviderCreateOptions["config"],
): MemoryEmbeddingProviderAdapter {
  const adapter = getLegacyMemoryEmbeddingProvider(id, config);
  if (adapter) {
    return adapter;
  }
  const genericAdapter = getEmbeddingProvider(id, config);
  if (genericAdapter) {
    return adaptGenericEmbeddingAdapter(genericAdapter);
  }
  if (id === LOCAL_LLAMA_CPP_PROVIDER_ID) {
    throw createMissingLlamaCppProviderError();
  }
  throw new Error(`Unknown memory embedding provider: ${id}`);
}

function resolveProviderModel(
  adapter: MemoryEmbeddingProviderAdapter,
  requestedModel: string,
): string {
  const trimmed = requestedModel.trim();
  if (trimmed) {
    return trimmed;
  }
  return adapter.defaultModel ?? "";
}

export function resolveEmbeddingProviderFallbackModel(
  providerId: string,
  fallbackSourceModel: string,
  config?: MemoryEmbeddingProviderCreateOptions["config"],
): string {
  const adapter =
    getLegacyMemoryEmbeddingProvider(providerId, config) ??
    getEmbeddingProvider(providerId, config);
  return adapter?.defaultModel ?? fallbackSourceModel;
}

export function resolveEmbeddingProviderAdapterId(
  providerId: string,
  config?: MemoryEmbeddingProviderCreateOptions["config"],
): string | undefined {
  try {
    return getAdapter(providerId, config).id;
  } catch {
    return undefined;
  }
}

export function resolveEmbeddingProviderAdapterTransport(
  providerId: string,
  config?: MemoryEmbeddingProviderCreateOptions["config"],
): MemoryEmbeddingProviderAdapter["transport"] {
  try {
    return getAdapter(providerId, config).transport;
  } catch {
    return undefined;
  }
}

export function resolveEmbeddingProviderIndexIdentity(options: CreateEmbeddingProviderOptions) {
  if (options.provider === "auto") {
    const autoAdapters = listAutoSelectAdapters();
    if (autoAdapters.length > 0) {
      const autoAdapter = autoAdapters[0];
      const model = resolveProviderModel(autoAdapter, options.model);
      const identity = autoAdapter.resolveIndexIdentity?.({
        ...options,
        provider: autoAdapter.id,
        model,
      });
      if (identity) {
        return {
          provider: { id: autoAdapter.id, model: identity.model },
          cacheKeyData: identity.cacheKeyData,
          aliases: identity.aliases,
        };
      }
    }
    return undefined;
  }
  const provider = options.provider;
  try {
    const adapter = getAdapter(provider, options.config);
    const model = resolveProviderModel(adapter, options.model);
    const identity = adapter.resolveIndexIdentity?.({
      ...options,
      provider,
      model,
    });
    return identity
      ? {
          provider: { id: adapter.id, model: identity.model },
          cacheKeyData: identity.cacheKeyData,
          aliases: identity.aliases,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function createWithAdapter(
  adapter: MemoryEmbeddingProviderAdapter,
  options: CreateEmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const result = await adapter.create({
    ...options,
    model: resolveProviderModel(adapter, options.model),
  });
  return {
    provider: result.provider,
    requestedProvider: options.provider,
    runtime: result.runtime,
  };
}

export async function createEmbeddingProvider(
  options: CreateEmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  if (options.provider === "auto") {
    const reasons: string[] = [];
    for (const adapter of listAutoSelectAdapters()) {
      try {
        const result = await createWithAdapter(adapter, {
          ...options,
          provider: adapter.id,
        });
        return {
          ...result,
          requestedProvider: "auto",
        };
      } catch (err) {
        const message = formatProviderError(adapter, err);
        if (shouldContinueAutoSelection(adapter, err)) {
          reasons.push(message);
          continue;
        }
        const wrapped = new Error(message) as Error & { cause?: unknown };
        wrapped.cause = err;
        throw wrapped;
      }
    }
    return {
      provider: null,
      requestedProvider: "auto",
      providerUnavailableReason:
        reasons.length > 0 ? reasons.join("\n\n") : "No embeddings provider available.",
    };
  }

  const provider = options.provider;
  const primaryAdapter = getAdapter(provider, options.config);
  try {
    return await createWithAdapter(primaryAdapter, {
      ...options,
      provider,
    });
  } catch (primaryErr) {
    const reason = formatProviderError(primaryAdapter, primaryErr);
    if (options.fallback && options.fallback !== "none" && options.fallback !== provider) {
      const fallbackAdapter = getAdapter(options.fallback, options.config);
      try {
        const fallbackResult = await createWithAdapter(fallbackAdapter, {
          ...options,
          provider: options.fallback,
        });
        return {
          ...fallbackResult,
          requestedProvider: provider,
          fallbackFrom: provider,
          fallbackReason: reason,
        };
      } catch (fallbackErr) {
        const fallbackReason = formatProviderError(fallbackAdapter, fallbackErr);
        const wrapped = new Error(
          `${reason}\n\nFallback to ${options.fallback} failed: ${fallbackReason}`,
        ) as Error & { cause?: unknown };
        wrapped.cause = primaryErr;
        throw wrapped;
      }
    }
    const wrapped = new Error(reason) as Error & { cause?: unknown };
    wrapped.cause = primaryErr;
    throw wrapped;
  }
}
