import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/embedding-providers";
import {
  createLocalEmbeddingProvider,
  type EmbeddingInput as MemoryEmbeddingInput,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
  type MemoryEmbeddingProviderCreateResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";

type LlamaCppLocalOptions = {
  modelPath?: string;
  modelCacheDir?: string;
  contextSize?: number | "auto";
};

export type LlamaCppEmbeddingProviderRuntimeOptions = {
  nodeLlamaCppImportUrl?: string;
};

export const LLAMA_CPP_EMBEDDING_PROVIDER_ID = "local";
export const DEFAULT_LLAMA_CPP_EMBEDDING_MODEL =
  "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readLocalOptions(options: { local?: unknown }): LlamaCppLocalOptions {
  const local = options.local as LlamaCppLocalOptions | undefined;
  return local ?? {};
}

function textFromEmbeddingInput(input: EmbeddingInput): string {
  return typeof input === "string" ? input : input.text;
}

function toMemoryEmbeddingInput(input: EmbeddingInput): MemoryEmbeddingInput {
  return typeof input === "string" ? { text: input } : input;
}

function isNodeLlamaCppMissing(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as Error & { code?: unknown }).code;
  return code === "ERR_MODULE_NOT_FOUND" && err.message.includes("node-llama-cpp");
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export function formatLlamaCppSetupError(err: unknown): string {
  const detail = formatErrorMessage(err);
  const missing = isNodeLlamaCppMissing(err);
  return [
    "Local llama.cpp embeddings unavailable.",
    missing
      ? "Reason: node-llama-cpp is missing or failed to install."
      : detail
        ? `Reason: ${detail}`
        : undefined,
    missing && detail ? `Detail: ${detail}` : null,
    "To enable local GGUF embeddings:",
    "1) Install the official provider plugin: openclaw plugins install @openclaw/llama-cpp-provider",
    "2) Use Node 24 for native installs/updates.",
    "3) If you use pnpm from source: pnpm approve-builds, then pnpm rebuild node-llama-cpp.",
    'Or set agents.defaults.memorySearch.provider to a remote embedding provider such as "openai", "ollama", "lmstudio", or "voyage".',
  ]
    .filter(Boolean)
    .join("\n");
}

const requireFromPlugin = createRequire(import.meta.url);

export function resolveNodeLlamaCppImportUrl(): string {
  return pathToFileURL(requireFromPlugin.resolve("node-llama-cpp")).href;
}

function adaptMemoryEmbeddingProvider(provider: MemoryEmbeddingProvider): EmbeddingProvider {
  return {
    id: LLAMA_CPP_EMBEDDING_PROVIDER_ID,
    model: provider.model,
    maxInputTokens: provider.maxInputTokens,
    embed: async (input, callOptions) =>
      await provider.embedQuery(textFromEmbeddingInput(input), {
        signal: callOptions?.signal,
      }),
    embedBatch: async (inputs, callOptions) => {
      if (provider.embedBatchInputs) {
        return await provider.embedBatchInputs(inputs.map(toMemoryEmbeddingInput), {
          signal: callOptions?.signal,
        });
      }
      return await provider.embedBatch(inputs.map(textFromEmbeddingInput), {
        signal: callOptions?.signal,
      });
    },
    close: provider.close,
  };
}

export async function createLlamaCppEmbeddingProvider(
  options: EmbeddingProviderCreateOptions,
  runtimeOptions: LlamaCppEmbeddingProviderRuntimeOptions = {},
): Promise<EmbeddingProvider> {
  const result = await createLlamaCppMemoryEmbeddingProvider(
    buildMemoryCreateOptions(options, options.dimensions),
    runtimeOptions,
  );
  if (!result.provider) {
    throw new Error("llama.cpp local embedding provider was unavailable");
  }
  return adaptMemoryEmbeddingProvider(result.provider);
}

export async function createLlamaCppMemoryEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
  runtimeOptions: LlamaCppEmbeddingProviderRuntimeOptions = {},
): Promise<MemoryEmbeddingProviderCreateResult> {
  const createOptions = buildMemoryCreateOptions(options, options.outputDimensionality);
  const provider = await createLocalEmbeddingProvider(createOptions, {
    nodeLlamaCppImportUrl: runtimeOptions.nodeLlamaCppImportUrl ?? resolveNodeLlamaCppImportUrl(),
  });
  return {
    provider,
    runtime: createLlamaCppEmbeddingProviderRuntime(provider),
  };
}

function buildMemoryCreateOptions(
  options: MemoryEmbeddingProviderCreateOptions | EmbeddingProviderCreateOptions,
  outputDimensionality: number | undefined,
): MemoryEmbeddingProviderCreateOptions {
  const local = readLocalOptions(options);
  const modelPath = normalizeOptionalString(local.modelPath) || DEFAULT_LLAMA_CPP_EMBEDDING_MODEL;
  return {
    config: options.config,
    agentDir: options.agentDir,
    provider: LLAMA_CPP_EMBEDDING_PROVIDER_ID,
    fallback: "none",
    remote: options.remote,
    model: modelPath,
    inputType: options.inputType,
    queryInputType: options.queryInputType,
    documentInputType: options.documentInputType,
    local: {
      ...local,
      modelPath,
    },
    outputDimensionality,
  };
}

function createLlamaCppEmbeddingProviderRuntime(provider: { model: string }) {
  return {
    id: LLAMA_CPP_EMBEDDING_PROVIDER_ID,
    inlineQueryTimeoutMs: 5 * 60_000,
    inlineBatchTimeoutMs: 10 * 60_000,
    cacheKeyData: {
      provider: LLAMA_CPP_EMBEDDING_PROVIDER_ID,
      model: provider.model,
    },
  };
}

export const llamaCppEmbeddingProviderAdapter: EmbeddingProviderAdapter = {
  id: LLAMA_CPP_EMBEDDING_PROVIDER_ID,
  defaultModel: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  transport: "local",
  formatSetupError: formatLlamaCppSetupError,
  create: async (options) => {
    const provider = await createLlamaCppEmbeddingProvider(options);
    return {
      provider,
      runtime: createLlamaCppEmbeddingProviderRuntime(provider),
    };
  },
};
