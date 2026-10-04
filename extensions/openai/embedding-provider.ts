import {
  createRemoteEmbeddingProvider,
  normalizeEmbeddingModelWithPrefixes,
  resolveRemoteEmbeddingClient,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
  type RemoteEmbeddingClient,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { OPENAI_DEFAULT_EMBEDDING_MODEL } from "./default-models.js";

export type OpenAiEmbeddingClient = RemoteEmbeddingClient & {
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
  outputDimensionality?: number;
};

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-3-small": 8192,
  "text-embedding-3-large": 8192,
  "text-embedding-ada-002": 8191,
};

function normalizeOpenAiModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: OPENAI_DEFAULT_EMBEDDING_MODEL,
    prefixes: ["openai/"],
  });
}

function isNativeOpenAiBaseUrl(baseUrl: string): boolean {
  return URL.parse(baseUrl)?.hostname.toLowerCase().replace(/\.+$/, "") === "api.openai.com";
}

export async function createOpenAiEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: OpenAiEmbeddingClient }> {
  const client = await resolveOpenAiEmbeddingClient(options);
  return {
    provider: createRemoteEmbeddingProvider({
      id: "openai",
      client,
      errorPrefix: "openai embeddings failed",
      maxInputTokens: OPENAI_MAX_INPUT_TOKENS[normalizeOpenAiModel(client.model)],
      buildRequestFields: (kind) => {
        const explicit = kind === "query" ? client.queryInputType : client.documentInputType;
        const value = explicit ?? client.inputType;
        const inputType =
          typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
        return {
          ...(typeof client.outputDimensionality === "number"
            ? { dimensions: client.outputDimensionality }
            : {}),
          ...(inputType ? { input_type: inputType } : {}),
        };
      },
    }),
    client,
  };
}

async function resolveOpenAiEmbeddingClient(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<OpenAiEmbeddingClient> {
  const originalModel = options.model;
  const client = await resolveRemoteEmbeddingClient({
    provider: options.provider ?? "openai",
    capability: "embedding",
    options,
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    normalizeModel: normalizeOpenAiModel,
  });
  // Routers expect the provider-qualified model name; only native OpenAI strips it.
  if (!isNativeOpenAiBaseUrl(client.baseUrl) && originalModel.startsWith("openai/")) {
    client.model = `openai/${normalizeOpenAiModel(originalModel)}`;
  }
  return {
    ...client,
    inputType: options.inputType,
    queryInputType: options.queryInputType,
    documentInputType: options.documentInputType,
    outputDimensionality: options.dimensions,
  };
}
