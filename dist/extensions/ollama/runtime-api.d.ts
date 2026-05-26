import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { o as SsrFPolicy } from "../../ssrf-skjEI_i5.js";
import { a as createConfiguredOllamaCompatNumCtxWrapper, c as createOllamaStreamFn, d as resolveOllamaBaseUrlForRun, f as resolveOllamaCompatNumCtxEnabled, i as convertToOllamaMessages, l as isOllamaCompatProvider, m as wrapOllamaCompatNumCtx, n as buildAssistantMessage, o as createConfiguredOllamaCompatStreamWrapper, p as shouldInjectOllamaCompatNumCtx, r as buildOllamaChatRequest, s as createConfiguredOllamaStreamFn, t as OLLAMA_NATIVE_BASE_URL, u as parseNdjsonStream } from "../../stream-CI_Rrbq3.js";

//#region extensions/ollama/src/embedding-provider.d.ts
type OllamaEmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string, options?: {
    signal?: AbortSignal;
  }) => Promise<number[]>;
  embedBatch: (texts: string[], options?: {
    signal?: AbortSignal;
  }) => Promise<number[][]>;
};
type OllamaEmbeddingOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  provider?: string;
  remote?: {
    baseUrl?: string;
    apiKey?: unknown;
    headers?: Record<string, string>;
  };
  model: string;
  fallback?: string;
  local?: unknown;
  outputDimensionality?: number;
  taskType?: unknown;
};
type OllamaEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};
declare const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
declare function createOllamaEmbeddingProvider(options: OllamaEmbeddingOptions): Promise<{
  provider: OllamaEmbeddingProvider;
  client: OllamaEmbeddingClient;
}>;
//#endregion
export { DEFAULT_OLLAMA_EMBEDDING_MODEL, OLLAMA_NATIVE_BASE_URL, type OllamaEmbeddingClient, type OllamaEmbeddingProvider, buildAssistantMessage, buildOllamaChatRequest, convertToOllamaMessages, createConfiguredOllamaCompatNumCtxWrapper, createConfiguredOllamaCompatStreamWrapper, createConfiguredOllamaStreamFn, createOllamaEmbeddingProvider, createOllamaStreamFn, isOllamaCompatProvider, parseNdjsonStream, resolveOllamaBaseUrlForRun, resolveOllamaCompatNumCtxEnabled, shouldInjectOllamaCompatNumCtx, wrapOllamaCompatNumCtx };