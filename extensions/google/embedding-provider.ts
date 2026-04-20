import { parseGeminiAuth } from "openclaw/plugin-sdk/image-generation-core";
import {
  buildRemoteBaseUrlPolicy,
  debugEmbeddingsLog,
  sanitizeAndNormalizeEmbedding,
  withRemoteHttpResponse,
  type EmbeddingInput,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveMemorySecretInputString } from "openclaw/plugin-sdk/memory-core-host-secret";
import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
  requireApiKey,
  resolveApiKeyForProvider,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { DEFAULT_GOOGLE_API_BASE_URL } from "./api.js";
import { resolveGoogleApiType, resolveGoogleBaseUrl } from "./env-utils.js";

export type GeminiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  modelPath: string;
  apiKeys: string[];
  outputDimensionality?: number;
  apiType: "gemini" | "openai-compatible";
};

export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const GEMINI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-004": 2048,
  "gemini-embedding-001": 2048,
  "gemini-embedding-2-preview": 8192,
};

export type GeminiTaskType = NonNullable<MemoryEmbeddingProviderCreateOptions["taskType"]>;

// --- gemini-embedding-2-preview support ---

export const GEMINI_EMBEDDING_2_MODELS = new Set([
  "gemini-embedding-2-preview",
  // Add the GA model name here once released.
]);

const GEMINI_EMBEDDING_2_DEFAULT_DIMENSIONS = 3072;
const GEMINI_EMBEDDING_2_VALID_DIMENSIONS = [768, 1536, 3072] as const;

export type GeminiTextPart = { text: string };
export type GeminiInlinePart = {
  inlineData: { mimeType: string; data: string };
};
export type GeminiPart = GeminiTextPart | GeminiInlinePart;
export type GeminiEmbeddingRequest = {
  content: { parts: GeminiPart[] };
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  model?: string;
};
export type GeminiTextEmbeddingRequest = GeminiEmbeddingRequest;

/** Builds the text-only Gemini embedding request shape used across direct and batch APIs. */
export function buildGeminiTextEmbeddingRequest(params: {
  text: string;
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  modelPath?: string;
}): GeminiTextEmbeddingRequest {
  return buildGeminiEmbeddingRequest({
    input: { text: params.text },
    taskType: params.taskType,
    outputDimensionality: params.outputDimensionality,
    modelPath: params.modelPath,
  });
}

export function buildGeminiEmbeddingRequest(params: {
  input: EmbeddingInput;
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  modelPath?: string;
}): GeminiEmbeddingRequest {
  const request: GeminiEmbeddingRequest = {
    content: {
      parts: params.input.parts?.map((part) =>
        part.type === "text"
          ? ({ text: part.text } satisfies GeminiTextPart)
          : ({
              inlineData: { mimeType: part.mimeType, data: part.data },
            } satisfies GeminiInlinePart),
      ) ?? [{ text: params.input.text }],
    },
    taskType: params.taskType,
  };
  if (params.modelPath) {
    request.model = params.modelPath;
  }
  if (params.outputDimensionality != null) {
    request.outputDimensionality = params.outputDimensionality;
  }
  return request;
}

/**
 * Returns true if the given model name is a gemini-embedding-2 variant that
 * supports `outputDimensionality` and extended task types.
 */
export function isGeminiEmbedding2Model(model: string): boolean {
  return GEMINI_EMBEDDING_2_MODELS.has(model);
}

/**
 * Validate and return the `outputDimensionality` for gemini-embedding-2 models.
 * Returns `undefined` for older models (they don't support the param).
 */
export function resolveGeminiOutputDimensionality(
  model: string,
  requested?: number,
): number | undefined {
  if (!isGeminiEmbedding2Model(model)) {
    return undefined;
  }
  if (requested == null) {
    return GEMINI_EMBEDDING_2_DEFAULT_DIMENSIONS;
  }
  const valid: readonly number[] = GEMINI_EMBEDDING_2_VALID_DIMENSIONS;
  if (!valid.includes(requested)) {
    throw new Error(
      `Invalid outputDimensionality ${requested} for ${model}. Valid values: ${valid.join(", ")}`,
    );
  }
  return requested;
}
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

export function normalizeGeminiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_GEMINI_EMBEDDING_MODEL;
  }
  const withoutPrefix = trimmed.replace(/^models\//, "");
  if (withoutPrefix.startsWith("gemini/")) {
    return withoutPrefix.slice("gemini/".length);
  }
  if (withoutPrefix.startsWith("google/")) {
    return withoutPrefix.slice("google/".length);
  }
  return withoutPrefix;
}

async function fetchGeminiEmbeddingPayload(params: {
  client: GeminiEmbeddingClient;
  endpoint: string;
  body: unknown;
}): Promise<{
  embedding?: { values?: number[] };
  embeddings?: Array<{ values?: number[] }>;
  data?: Array<{ embedding?: number[] }>; // OpenAI format
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
      // For OpenAI-compatible endpoints, we use Bearer token
      if (params.client.apiType === "openai-compatible") {
        headers["Authorization"] = `Bearer ${apiKey}`;
        delete headers["x-goog-api-key"];
      }

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
            data?: Array<{ embedding?: number[] }>;
          };
        },
      });
    },
  });
}

function buildGeminiModelPath(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

export async function createGeminiEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: GeminiEmbeddingClient }> {
  const client = await resolveGeminiEmbeddingClient(options);
  const baseUrl = client.baseUrl.replace(/\/$/, "");
  const isOpenAICompatible = client.apiType === "openai-compatible";

  const embedUrl = isOpenAICompatible
    ? `${baseUrl}/embeddings`
    : `${baseUrl}/${client.modelPath}:embedContent`;
  const batchUrl = isOpenAICompatible
    ? `${baseUrl}/embeddings`
    : `${baseUrl}/${client.modelPath}:batchEmbedContents`;

  const isV2 = isGeminiEmbedding2Model(client.model);
  const outputDimensionality = client.outputDimensionality;

  const embedQuery = async (text: string): Promise<number[]> => {
    if (!text.trim()) {
      return [];
    }
    const body = isOpenAICompatible
      ? { model: client.model, input: text }
      : buildGeminiTextEmbeddingRequest({
          text,
          taskType: options.taskType ?? "RETRIEVAL_QUERY",
          outputDimensionality: isV2 ? outputDimensionality : undefined,
        });

    const payload = await fetchGeminiEmbeddingPayload({
      client,
      endpoint: embedUrl,
      body,
    });

    if (isOpenAICompatible) {
      return sanitizeAndNormalizeEmbedding(payload.data?.[0]?.embedding ?? []);
    }
    return sanitizeAndNormalizeEmbedding(payload.embedding?.values ?? []);
  };

  const embedBatchInputs = async (inputs: EmbeddingInput[]): Promise<number[][]> => {
    if (inputs.length === 0) {
      return [];
    }

    if (isOpenAICompatible) {
      const payload = await fetchGeminiEmbeddingPayload({
        client,
        endpoint: batchUrl,
        body: {
          model: client.model,
          input: inputs.map((input) => input.text),
        },
      });
      const data = Array.isArray(payload.data) ? payload.data : [];
      return inputs.map((_, index) => sanitizeAndNormalizeEmbedding(data[index]?.embedding ?? []));
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
  options: MemoryEmbeddingProviderCreateOptions,
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
  const googleBaseUrl = resolveGoogleBaseUrl(remoteBaseUrl || normalizeOptionalString(providerConfig?.baseUrl));
  const baseUrl = googleBaseUrl.replace(/\/$/, "");
  
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

  const apiType = resolveGoogleApiType(baseUrl, (providerConfig as Record<string, unknown> | undefined)?.apiType as string | undefined);

  debugEmbeddingsLog("memory embeddings: gemini client", {
    baseUrl,
    model,
    modelPath,
    outputDimensionality,
    apiType,
    embedEndpoint:
      apiType === "openai-compatible"
        ? `${baseUrl}/embeddings`
        : `${baseUrl}/${modelPath}:embedContent`,
    batchEndpoint:
      apiType === "openai-compatible"
        ? `${baseUrl}/embeddings`
        : `${baseUrl}/${modelPath}:batchEmbedContents`,
  });
  return { baseUrl, headers, ssrfPolicy, model, modelPath, apiKeys, outputDimensionality, apiType };
}
