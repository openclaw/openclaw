import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../../../../src/agents/api-key-rotation.js";
import { requireApiKey, resolveApiKeyForProvider } from "../../../../src/agents/model-auth.js";
import { parseGeminiAuth } from "../../../../src/infra/gemini-auth.js";
import {
  DEFAULT_GOOGLE_API_BASE_URL,
  normalizeGoogleApiBaseUrl,
} from "../../../../src/infra/google-api-base-url.js";
import type { SsrFPolicy } from "../../../../src/infra/net/ssrf.js";
import type { EmbeddingInput } from "./embedding-inputs.js";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import { debugEmbeddingsLog } from "./embeddings-debug.js";
import {
  buildGeminiEmbeddingRequest,
  buildGeminiTextEmbeddingRequest,
  isGeminiEmbedding2Model,
  normalizeGeminiModel,
  resolveGeminiOutputDimensionality,
} from "./embeddings-gemini-request.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";

export {
  buildGeminiEmbeddingRequest,
  buildGeminiTextEmbeddingRequest,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  GEMINI_EMBEDDING_2_MODELS,
  isGeminiEmbedding2Model,
  normalizeGeminiModel,
  resolveGeminiOutputDimensionality,
  type GeminiEmbeddingRequest,
  type GeminiInlinePart,
  type GeminiPart,
  type GeminiTaskType,
  type GeminiTextEmbeddingRequest,
  type GeminiTextPart,
} from "./embeddings-gemini-request.js";

export type GeminiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  modelPath: string;
  apiKeys: string[];
  outputDimensionality?: number;
};

const GEMINI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-004": 2048,
};
function resolveRemoteApiKey(remoteApiKey: unknown): string | undefined {
  const trimmed = resolveMemorySecretInputString({
    value: remoteApiKey,
    path: "agents.*.memorySearch.remote.apiKey",
  });
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "GOOGLE_API_KEY" || trimmed === "GEMINI_API_KEY") {
    return process.env[trimmed]?.trim();
  }
  return trimmed;
}

async function fetchGeminiEmbeddingPayload(params: {
  client: GeminiEmbeddingClient;
  endpoint: string;
  body: unknown;
}): Promise<{
  embedding?: { values?: number[] };
  embeddings?: Array<{ values?: number[] }>;
}> {
  return await executeWithApiKeyRotation({
    provider: "google",
    apiKeys: params.client.apiKeys,
    execute: async (apiKey) => {
      const authHeaders = parseGeminiAuth(apiKey);
      const headers = {
        ...authHeaders.headers,
        ...params.client.headers,
      };
      return await withRemoteHttpResponse({
        url: params.endpoint,
        ssrfPolicy: params.client.ssrfPolicy,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify(params.body),
        },
        onResponse: async (res) => {
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`gemini embeddings failed: ${res.status} ${text}`);
          }
          return (await res.json()) as {
            embedding?: { values?: number[] };
            embeddings?: Array<{ values?: number[] }>;
          };
        },
      });
    },
  });
}

function normalizeGeminiBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  const openAiIndex = trimmed.indexOf("/openai");
  if (openAiIndex > -1) {
    return normalizeGoogleApiBaseUrl(trimmed.slice(0, openAiIndex));
  }
  return normalizeGoogleApiBaseUrl(trimmed);
}

function buildGeminiModelPath(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

export async function createGeminiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: GeminiEmbeddingClient }> {
  const client = await resolveGeminiEmbeddingClient(options);
  const baseUrl = client.baseUrl.replace(/\/$/, "");
  const embedUrl = `${baseUrl}/${client.modelPath}:embedContent`;
  const batchUrl = `${baseUrl}/${client.modelPath}:batchEmbedContents`;
  const isV2 = isGeminiEmbedding2Model(client.model);
  const outputDimensionality = client.outputDimensionality;

  const embedQuery = async (text: string): Promise<number[]> => {
    if (!text.trim()) {
      return [];
    }
    const payload = await fetchGeminiEmbeddingPayload({
      client,
      endpoint: embedUrl,
      body: buildGeminiTextEmbeddingRequest({
        text,
        taskType: options.taskType ?? "RETRIEVAL_QUERY",
        outputDimensionality: isV2 ? outputDimensionality : undefined,
      }),
    });
    return sanitizeAndNormalizeEmbedding(payload.embedding?.values ?? []);
  };

  const embedBatchInputs = async (inputs: EmbeddingInput[]): Promise<number[][]> => {
    if (inputs.length === 0) {
      return [];
    }
    const payload = await fetchGeminiEmbeddingPayload({
      client,
      endpoint: batchUrl,
      body: {
        requests: inputs.map((input) =>
          buildGeminiEmbeddingRequest({
            input,
            modelPath: client.modelPath,
            taskType: options.taskType ?? "RETRIEVAL_DOCUMENT",
            outputDimensionality: isV2 ? outputDimensionality : undefined,
          }),
        ),
      },
    });
    const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : [];
    return inputs.map((_, index) => sanitizeAndNormalizeEmbedding(embeddings[index]?.values ?? []));
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    return await embedBatchInputs(
      texts.map((text) => ({
        text,
      })),
    );
  };

  return {
    provider: {
      id: "gemini",
      model: client.model,
      maxInputTokens: GEMINI_MAX_INPUT_TOKENS[client.model],
      embedQuery,
      embedBatch,
      embedBatchInputs,
    },
    client,
  };
}

export async function resolveGeminiEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<GeminiEmbeddingClient> {
  const remote = options.remote;
  const remoteApiKey = resolveRemoteApiKey(remote?.apiKey);
  const remoteBaseUrl = remote?.baseUrl?.trim();

  const apiKey = remoteApiKey
    ? remoteApiKey
    : requireApiKey(
        await resolveApiKeyForProvider({
          provider: "google",
          cfg: options.config,
          agentDir: options.agentDir,
        }),
        "google",
      );

  const providerConfig = options.config.models?.providers?.google;
  const rawBaseUrl =
    remoteBaseUrl || providerConfig?.baseUrl?.trim() || DEFAULT_GOOGLE_API_BASE_URL;
  const baseUrl = normalizeGeminiBaseUrl(rawBaseUrl);
  const ssrfPolicy = buildRemoteBaseUrlPolicy(baseUrl);
  const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
  const headers: Record<string, string> = {
    ...headerOverrides,
  };
  const apiKeys = collectProviderApiKeysForExecution({
    provider: "google",
    primaryApiKey: apiKey,
  });
  const model = normalizeGeminiModel(options.model);
  const modelPath = buildGeminiModelPath(model);
  const outputDimensionality = resolveGeminiOutputDimensionality(
    model,
    options.outputDimensionality,
  );
  debugEmbeddingsLog("memory embeddings: gemini client", {
    rawBaseUrl,
    baseUrl,
    model,
    modelPath,
    outputDimensionality,
    embedEndpoint: `${baseUrl}/${modelPath}:embedContent`,
    batchEndpoint: `${baseUrl}/${modelPath}:batchEmbedContents`,
  });
  return { baseUrl, headers, ssrfPolicy, model, modelPath, apiKeys, outputDimensionality };
}
