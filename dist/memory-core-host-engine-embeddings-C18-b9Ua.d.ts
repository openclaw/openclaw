import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { l as SecretInput } from "./types.secrets-tbFW-hY6.js";
import { a as fetchWithSsrFGuard } from "./fetch-guard-BgaCy73h.js";
import { l as shouldUseEnvHttpProxyForUrl } from "./proxy-env-B03GKDkG.js";
import { m as EmbeddingInput, t as MemoryChunk } from "./internal-B1IX4tl2.js";

//#region packages/memory-host-sdk/src/host/embeddings.types.d.ts
type EmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string, options?: EmbeddingProviderCallOptions) => Promise<number[]>;
  embedBatch: (texts: string[], options?: EmbeddingProviderCallOptions) => Promise<number[][]>;
  embedBatchInputs?: (inputs: EmbeddingInput[], options?: EmbeddingProviderCallOptions) => Promise<number[][]>;
  close?: () => Promise<void> | void;
};
type EmbeddingProviderCallOptions = {
  signal?: AbortSignal;
};
type EmbeddingProviderRequest = string;
type EmbeddingProviderFallback = string;
type GeminiTaskType = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" | "SEMANTIC_SIMILARITY" | "CLASSIFICATION" | "CLUSTERING" | "QUESTION_ANSWERING" | "FACT_VERIFICATION";
type EmbeddingProviderOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  provider?: EmbeddingProviderRequest;
  remote?: {
    baseUrl?: string;
    apiKey?: SecretInput;
    headers?: Record<string, string>;
  };
  model: string;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
  fallback?: EmbeddingProviderFallback;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
    /**
     * Context size passed to node-llama-cpp `createEmbeddingContext`.
     * Default: 4096, chosen to cover typical memory-search chunks (128–512 tokens)
     * while keeping non-weight VRAM bounded.
     * Set `"auto"` to let node-llama-cpp use the model's trained maximum — not
     * recommended for 8B+ models (e.g. Qwen3-Embedding-8B: up to 40 960 tokens → ~32 GB VRAM).
     */
    contextSize?: number | "auto";
  }; /** Provider-specific output vector dimensions for supported embedding families. */
  outputDimensionality?: number; /** Gemini: override the default task type sent with embedding requests. */
  taskType?: GeminiTaskType;
};
//#endregion
//#region packages/memory-host-sdk/src/host/embedding-defaults.d.ts
declare const DEFAULT_LOCAL_MODEL = "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";
//#endregion
//#region packages/memory-host-sdk/src/host/embeddings.d.ts
declare function createLocalEmbeddingProvider(options: EmbeddingProviderOptions): Promise<EmbeddingProvider>;
//#endregion
//#region packages/memory-host-sdk/src/host/batch-error-utils.d.ts
type BatchOutputErrorLike = {
  error?: {
    message?: string;
  };
  response?: {
    body?: string | {
      error?: {
        message?: string;
      };
    };
  };
};
declare function extractBatchErrorMessage(lines: BatchOutputErrorLike[]): string | undefined;
declare function formatUnavailableBatchError(err: unknown): string | undefined;
//#endregion
//#region packages/memory-host-sdk/src/host/retry-utils.d.ts
type RetryConfig = {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
};
type RetryInfo = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  err: unknown;
  label?: string;
};
type RetryOptions = RetryConfig & {
  label?: string;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  retryAfterMs?: (err: unknown) => number | undefined;
  onRetry?: (info: RetryInfo) => void;
};
declare function retryAsync<T>(fn: () => Promise<T>, attemptsOrOptions?: number | RetryOptions, initialDelayMs?: number): Promise<T>;
//#endregion
//#region packages/memory-host-sdk/src/host/ssrf-policy.d.ts
type SsrFPolicy = {
  allowPrivateNetwork?: boolean;
  dangerouslyAllowPrivateNetwork?: boolean;
  allowRfc2544BenchmarkRange?: boolean;
  allowIpv6UniqueLocalRange?: boolean;
  allowedHostnames?: string[];
  hostnameAllowlist?: string[];
};
//#endregion
//#region packages/memory-host-sdk/src/host/batch-http.d.ts
declare function postJsonWithRetry<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  retryImpl?: typeof retryAsync;
  body: unknown;
  errorPrefix: string;
}): Promise<T>;
//#endregion
//#region packages/memory-host-sdk/src/host/batch-output.d.ts
type EmbeddingBatchOutputLine = {
  custom_id?: string;
  error?: {
    message?: string;
  };
  response?: {
    status_code?: number;
    body?: {
      data?: Array<{
        embedding?: number[];
      }>;
      error?: {
        message?: string;
      };
    } | string;
  };
};
declare function applyEmbeddingBatchOutputLine(params: {
  line: EmbeddingBatchOutputLine;
  remaining: Set<string>;
  errors: string[];
  byCustomId: Map<string, number[]>;
}): void;
//#endregion
//#region packages/memory-host-sdk/src/host/batch-provider-common.d.ts
type ProviderBatchOutputLine = EmbeddingBatchOutputLine;
declare const EMBEDDING_BATCH_ENDPOINT = "/v1/embeddings";
//#endregion
//#region packages/memory-host-sdk/src/host/batch-runner.d.ts
type EmbeddingBatchExecutionParams = {
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
};
declare function runEmbeddingBatchGroups<TRequest>(params: {
  requests: TRequest[];
  maxRequests: number;
  wait: EmbeddingBatchExecutionParams["wait"];
  pollIntervalMs: EmbeddingBatchExecutionParams["pollIntervalMs"];
  timeoutMs: EmbeddingBatchExecutionParams["timeoutMs"];
  concurrency: EmbeddingBatchExecutionParams["concurrency"];
  debugLabel: string;
  debug?: EmbeddingBatchExecutionParams["debug"];
  runGroup: (args: {
    group: TRequest[];
    groupIndex: number;
    groups: number;
    byCustomId: Map<string, number[]>;
  }) => Promise<void>;
}): Promise<Map<string, number[]>>;
declare function buildEmbeddingBatchGroupOptions<TRequest>(params: {
  requests: TRequest[];
} & EmbeddingBatchExecutionParams, options: {
  maxRequests: number;
  debugLabel: string;
}): {
  requests: TRequest[];
  maxRequests: number;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug: ((message: string, data?: Record<string, unknown>) => void) | undefined;
  debugLabel: string;
};
//#endregion
//#region packages/memory-host-sdk/src/host/batch-status.d.ts
type BatchStatusLike = {
  id?: string;
  status?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
};
type BatchCompletionResult = {
  outputFileId: string;
  errorFileId?: string;
};
declare function resolveBatchCompletionFromStatus(params: {
  provider: string;
  batchId: string;
  status: BatchStatusLike;
}): BatchCompletionResult;
declare function throwIfBatchTerminalFailure(params: {
  provider: string;
  status: BatchStatusLike;
  readError: (errorFileId: string) => Promise<string | undefined>;
}): Promise<void>;
declare function resolveCompletedBatchResult(params: {
  provider: string;
  status: BatchStatusLike;
  wait: boolean;
  waitForBatch: () => Promise<BatchCompletionResult>;
}): Promise<BatchCompletionResult>;
//#endregion
//#region packages/memory-host-sdk/src/host/batch-utils.d.ts
type BatchHttpClientConfig = {
  baseUrl?: string;
  headers?: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
};
declare function normalizeBatchBaseUrl(client: BatchHttpClientConfig): string;
declare function buildBatchHeaders(client: Pick<BatchHttpClientConfig, "headers">, params: {
  json: boolean;
}): Record<string, string>;
//#endregion
//#region packages/memory-host-sdk/src/host/batch-upload.d.ts
declare function uploadBatchJsonlFile(params: {
  client: BatchHttpClientConfig;
  requests: unknown[];
  errorPrefix: string;
}): Promise<string>;
//#endregion
//#region packages/memory-host-sdk/src/host/embedding-chunk-limits.d.ts
declare function enforceEmbeddingMaxInputTokens(provider: EmbeddingProvider, chunks: MemoryChunk[], hardMaxInputTokens?: number): MemoryChunk[];
//#endregion
//#region packages/memory-host-sdk/src/host/embedding-provider-adapter-utils.d.ts
declare function isMissingEmbeddingApiKeyError(err: unknown): boolean;
declare function sanitizeEmbeddingCacheHeaders(headers: Record<string, string>, excludedHeaderNames: string[]): Array<[string, string]>;
declare function mapBatchEmbeddingsByIndex(byCustomId: Map<string, number[]>, count: number): number[][];
//#endregion
//#region packages/memory-host-sdk/src/host/embedding-vectors.d.ts
declare function sanitizeAndNormalizeEmbedding(vec: number[]): number[];
//#endregion
//#region packages/memory-host-sdk/src/host/embeddings-debug.d.ts
declare function debugEmbeddingsLog(message: string, meta?: Record<string, unknown>): void;
//#endregion
//#region packages/memory-host-sdk/src/host/embeddings-model-normalize.d.ts
declare function normalizeEmbeddingModelWithPrefixes(params: {
  model: string;
  defaultModel: string;
  prefixes: string[];
}): string;
//#endregion
//#region packages/memory-host-sdk/src/host/embeddings-remote-client.d.ts
type RemoteEmbeddingProviderId = string;
declare function resolveRemoteEmbeddingBearerClient(params: {
  provider: RemoteEmbeddingProviderId;
  options: EmbeddingProviderOptions;
  defaultBaseUrl: string;
}): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
}>;
//#endregion
//#region packages/memory-host-sdk/src/host/embeddings-remote-provider.d.ts
type RemoteEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  model: string;
};
declare function createRemoteEmbeddingProvider(params: {
  id: string;
  client: RemoteEmbeddingClient;
  errorPrefix: string;
  maxInputTokens?: number;
}): EmbeddingProvider;
declare function resolveRemoteEmbeddingClient(params: {
  provider: RemoteEmbeddingProviderId;
  options: EmbeddingProviderOptions;
  defaultBaseUrl: string;
  normalizeModel: (model: string) => string;
}): Promise<RemoteEmbeddingClient>;
//#endregion
//#region packages/memory-host-sdk/src/host/embeddings-remote-fetch.d.ts
declare function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  body: unknown;
  errorPrefix: string;
}): Promise<number[][]>;
//#endregion
//#region packages/memory-host-sdk/src/host/embedding-input-limits.d.ts
declare function estimateUtf8Bytes(text: string): number;
declare function estimateStructuredEmbeddingInputBytes(input: EmbeddingInput): number;
//#endregion
//#region packages/memory-host-sdk/src/host/remote-http.d.ts
declare const buildRemoteBaseUrlPolicy: (baseUrl: string) => SsrFPolicy | undefined;
declare function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  fetchWithSsrFGuardImpl?: typeof fetchWithSsrFGuard;
  shouldUseEnvHttpProxyForUrlImpl?: typeof shouldUseEnvHttpProxyForUrl;
  auditContext?: string;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T>;
//#endregion
//#region src/plugin-sdk/memory-core-host-engine-embeddings.d.ts
type EmbeddingBatchStatus = {
  id?: string;
  status?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
};
//#endregion
export { EMBEDDING_BATCH_ENDPOINT as A, BatchCompletionResult as C, EmbeddingBatchExecutionParams as D, throwIfBatchTerminalFailure as E, formatUnavailableBatchError as F, createLocalEmbeddingProvider as I, DEFAULT_LOCAL_MODEL as L, applyEmbeddingBatchOutputLine as M, postJsonWithRetry as N, buildEmbeddingBatchGroupOptions as O, extractBatchErrorMessage as P, normalizeBatchBaseUrl as S, resolveCompletedBatchResult as T, sanitizeEmbeddingCacheHeaders as _, estimateUtf8Bytes as a, BatchHttpClientConfig as b, createRemoteEmbeddingProvider as c, resolveRemoteEmbeddingBearerClient as d, normalizeEmbeddingModelWithPrefixes as f, mapBatchEmbeddingsByIndex as g, isMissingEmbeddingApiKeyError as h, estimateStructuredEmbeddingInputBytes as i, ProviderBatchOutputLine as j, runEmbeddingBatchGroups as k, resolveRemoteEmbeddingClient as l, sanitizeAndNormalizeEmbedding as m, buildRemoteBaseUrlPolicy as n, fetchRemoteEmbeddingVectors as o, debugEmbeddingsLog as p, withRemoteHttpResponse as r, RemoteEmbeddingClient as s, EmbeddingBatchStatus as t, RemoteEmbeddingProviderId as u, enforceEmbeddingMaxInputTokens as v, resolveBatchCompletionFromStatus as w, buildBatchHeaders as x, uploadBatchJsonlFile as y };