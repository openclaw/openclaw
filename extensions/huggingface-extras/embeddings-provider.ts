// Hugging Face Inference Providers embeddings adapter.
//
// Routes through Scaleway's OpenAI-compatible `/v1/embeddings` endpoint
// because Scaleway is the inference provider that hosts Qwen3-Embedding-8B
// (the strongest open multilingual embedding currently on HF). Other
// embedding models on the same Scaleway route (e.g. `bge-multilingual-gemma2`)
// are accessible by overriding `memorySearch.model`.
//
// We expose this as a `MemoryEmbeddingProviderAdapter` so it plugs into the
// existing `agents.defaults.memorySearch.provider` config slot. The adapter
// returns an `EmbeddingProvider`-shaped object with `embedQuery` /
// `embedBatch` methods that openclaw's memory search and dreaming pipelines
// already know how to drive.

import {
  HUGGINGFACE_SCALEWAY_BASE_URL,
  PROVIDER_ID,
  resolveApiKeyForProvider,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderAdapter,
  type MemoryEmbeddingProviderCreateOptions,
  type MemoryEmbeddingProviderCreateResult,
} from "./api.js";

const DEFAULT_MODEL = "qwen3-embedding-8b";

// Scaleway has its own short ids; the user may type either the friendly HF
// repo id or the short Scaleway id. We translate well-known repo ids on the
// way out so users can configure either form.
const REPO_ID_ALIASES: Readonly<Record<string, string>> = {
  "qwen/qwen3-embedding-8b": "qwen3-embedding-8b",
  "baai/bge-multilingual-gemma2": "bge-multilingual-gemma2",
};

function normalizeModel(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return DEFAULT_MODEL;
  }
  const alias = REPO_ID_ALIASES[trimmed.toLowerCase()];
  return alias ?? trimmed;
}

type EmbeddingsApiResponse = {
  object?: string;
  model?: string;
  data?: Array<{
    object?: string;
    index?: number;
    embedding?: number[];
  }>;
  error?: string | { message?: string };
};

function extractError(status: number, body: EmbeddingsApiResponse | string): string {
  if (typeof body === "string") {
    return body || `huggingface-extras embeddings request failed with status ${status}`;
  }
  if (body.error) {
    if (typeof body.error === "string") {
      return body.error;
    }
    if (typeof body.error.message === "string") {
      return body.error.message;
    }
  }
  return `huggingface-extras embeddings request failed with status ${status}`;
}

async function postEmbeddings(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  inputs: string[];
}): Promise<number[][]> {
  const url = `${params.baseUrl}/v1/embeddings`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      input: params.inputs,
    }),
  });

  let body: EmbeddingsApiResponse | string;
  const text = await response.text().catch(() => "");
  try {
    body = JSON.parse(text) as EmbeddingsApiResponse;
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new Error(extractError(response.status, body));
  }
  if (typeof body === "string" || !body.data) {
    throw new Error("huggingface-extras embeddings response is missing `data` array");
  }

  // Preserve input ordering: Scaleway returns entries in input order but the
  // OpenAI spec only guarantees order via the `index` field, so we sort
  // defensively before stripping the wrapper.
  const sorted = body.data.toSorted((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors: number[][] = [];
  for (const entry of sorted) {
    if (!Array.isArray(entry.embedding)) {
      throw new Error("huggingface-extras embeddings response entry is missing `embedding`");
    }
    vectors.push(entry.embedding);
  }
  return vectors;
}

function buildProvider(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
}): MemoryEmbeddingProvider {
  return {
    id: PROVIDER_ID,
    model: params.model,
    embedQuery: async (text: string) => {
      const vectors = await postEmbeddings({ ...params, inputs: [text] });
      const first = vectors[0];
      if (!first) {
        throw new Error("huggingface-extras embeddings returned no vectors for query");
      }
      return first;
    },
    embedBatch: async (texts: string[]) => {
      if (texts.length === 0) {
        return [];
      }
      return postEmbeddings({ ...params, inputs: texts });
    },
  };
}

async function createMemoryEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<MemoryEmbeddingProviderCreateResult> {
  const auth = await resolveApiKeyForProvider({
    provider: PROVIDER_ID,
    cfg: options.config,
    agentDir: options.agentDir,
  });
  const apiKey = auth?.apiKey;
  if (!apiKey) {
    throw new Error(
      "huggingface-extras embeddings: HF API key not configured. Set HUGGINGFACE_HUB_TOKEN/HF_TOKEN or run `openclaw onboard --auth-choice huggingface-extras-api-key`.",
    );
  }
  const baseUrl = options.remote?.baseUrl?.trim() || HUGGINGFACE_SCALEWAY_BASE_URL;
  const model = normalizeModel(options.model);
  return {
    provider: buildProvider({ apiKey, baseUrl, model }),
    runtime: {
      id: PROVIDER_ID,
      cacheKeyData: {
        provider: PROVIDER_ID,
        model,
        baseUrl,
      },
    },
  };
}

export const huggingFaceExtrasMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: PROVIDER_ID,
  defaultModel: DEFAULT_MODEL,
  transport: "remote",
  create: createMemoryEmbeddingProvider,
};
