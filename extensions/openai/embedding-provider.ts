// Openai provider module implements model/runtime integration.
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

/**
 * Query instruction templates for models that require instruction-aware embeddings.
 * Mirrors the behavior already implemented in the Ollama adapter.
 */
const QUERY_INSTRUCTION_TEMPLATES = [
  {
    prefix: "qwen3-embedding",
    template:
      "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:{query}",
  },
  {
    prefix: "nomic-embed-text",
    template: "search_query: {query}",
  },
  {
    prefix: "mxbai-embed-large",
    template: "Represent this sentence for searching relevant passages: {query}",
  },
] as const;

function normalizeOpenAiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_OPENAI_EMBEDDING_MODEL;
  }
  return trimmed.startsWith("openai/") ? trimmed.slice("openai/".length) : trimmed;
}

/** Whether the embedding base URL points to the native OpenAI API endpoint. */
function isNativeOpenAiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/, "") === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * Apply query instruction template for models that require it (e.g. Qwen3-Embedding).
 * Returns the original query if no matching template is found.
 */
function applyQueryInstructionTemplate(model: string, queryText: string): string {
  const normalizedModel = model.trim().toLowerCase();
  const match = QUERY_INSTRUCTION_TEMPLATES.find(({ prefix }) =>
    normalizedModel.startsWith(prefix),
  );
  return match ? match.template.replace("{query}", () => queryText) : queryText;
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

  const embed = async (
    input: string[],
    kind: "query" | "document",
    signal?: AbortSignal,
  ): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    const inputType = resolveInputType(kind);
    return await fetchRemoteEmbeddingVectors({
      url,
      headers: client.headers,
      ssrfPolicy: client.ssrfPolicy,
      fetchImpl: client.fetchImpl,
      signal,
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
      ...(typeof OPENAI_MAX_INPUT_TOKENS[normalizeOpenAiModel(client.model)] === "number"
        ? { maxInputTokens: OPENAI_MAX_INPUT_TOKENS[normalizeOpenAiModel(client.model)] }
        : {}),
      embedQuery: async (text, optionsValue) => {
        // Apply query instruction template for models that need it (Qwen3-Embedding, etc.)
        const prefixed = applyQueryInstructionTemplate(client.model, text);
        const [vec] = await embed([prefixed], "query", optionsValue?.signal);
        return vec ?? [];
      },
      embedBatch: async (texts, optionsLocal) =>
        await embed(texts, "document", optionsLocal?.signal),
    },
    client,
  };
}

async function resolveOpenAiEmbeddingClient(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<OpenAiEmbeddingClient> {
  const originalModel = options.model;
  const client = await resolveRemoteEmbeddingClient({
    provider: options.provider ?? "openai",
    options,
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    normalizeModel: normalizeOpenAiModel,
  });
  // Non-native OpenAI routers (e.g. Requesty) expect the provider-qualified
  // model name ("openai/text-embedding-3-small") in embedding requests.
  // Strip the prefix only when talking to the native OpenAI API.
  if (!isNativeOpenAiBaseUrl(client.baseUrl) && originalModel.startsWith("openai/")) {
    client.model = `openai/${normalizeOpenAiModel(originalModel)}`;
  }
  return {
    ...client,
    inputType: options.inputType,
    queryInputType: options.queryInputType,
    documentInputType: options.documentInputType,
    outputDimensionality: options.outputDimensionality,
  };
}
