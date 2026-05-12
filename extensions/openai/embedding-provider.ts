import {
  fetchRemoteEmbeddingVectors,
  resolveRemoteEmbeddingClient,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { OPENAI_DEFAULT_EMBEDDING_MODEL } from "./default-models.js";

export type OpenAiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  model: string;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
  outputDimensionality?: number;
};

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_EMBEDDING_MODEL = OPENAI_DEFAULT_EMBEDDING_MODEL;
const OPENAI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-3-small": 8192,
  "text-embedding-3-large": 8192,
  "text-embedding-ada-002": 8191,
};

function normalizeOpenAiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_OPENAI_EMBEDDING_MODEL;
  }
  return trimmed.startsWith("openai/") ? trimmed.slice("openai/".length) : trimmed;
}

export async function createOpenAiEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: OpenAiEmbeddingClient }> {
  const client = await resolveOpenAiEmbeddingClient(options);
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;

  const resolveInputType = (kind: "query" | "document"): string | undefined => {
    const explicit = kind === "query" ? client.queryInputType : client.documentInputType;
    const value = explicit ?? client.inputType;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };

  const embed = async (input: string[], kind: "query" | "document"): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    const inputType = resolveInputType(kind);
    return await fetchRemoteEmbeddingVectors({
      url,
      headers: client.headers,
      ssrfPolicy: client.ssrfPolicy,
      fetchImpl: client.fetchImpl,
      body: {
        model: client.model,
        input,
        ...(typeof client.outputDimensionality === "number"
          ? { dimensions: client.outputDimensionality }
          : {}),
        ...(inputType ? { input_type: inputType } : {}),
      },
      errorPrefix: "openai embeddings failed",
    });
  };

  return {
    provider: {
      id: "openai",
      model: client.model,
      ...(typeof OPENAI_MAX_INPUT_TOKENS[client.model] === "number"
        ? { maxInputTokens: OPENAI_MAX_INPUT_TOKENS[client.model] }
        : {}),
      embedQuery: async (text) => {
        const [vec] = await embed([text], "query");
        return vec ?? [];
      },
      embedBatch: async (texts) => await embed(texts, "document"),
    },
    client,
  };
}

async function resolveOpenAiEmbeddingClient(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<OpenAiEmbeddingClient> {
  // Honour the caller-provided custom provider ID so the remote client looks
  // up `models.providers[<id>]` for the user's custom `baseUrl`, API key, and
  // headers. The adapter still defaults to `"openai"` when nothing custom is
  // configured; this only differs when memory-search was pointed at an
  // OpenAI-compatible custom provider entry such as `bailian-embedding`.
  // See #47884.
  const client = await resolveRemoteEmbeddingClient({
    provider: options.provider ?? "openai",
    options,
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    normalizeModel: normalizeOpenAiModel,
  });
  return {
    ...client,
    inputType: options.inputType,
    queryInputType: options.queryInputType,
    documentInputType: options.documentInputType,
    outputDimensionality: options.outputDimensionality,
  };
}
