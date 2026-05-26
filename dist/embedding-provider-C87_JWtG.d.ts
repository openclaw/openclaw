import { o as SsrFPolicy } from "./ssrf-skjEI_i5.js";
import { Ri as MemoryEmbeddingProvider, Vi as MemoryEmbeddingProviderCreateOptions } from "./types-Vx7Jq4_-2.js";
import { m as EmbeddingInput } from "./internal-B1IX4tl2.js";
//#region extensions/google/embedding-provider.d.ts
type GeminiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  modelPath: string;
  apiKeys: string[];
  outputDimensionality?: number;
};
declare const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
type GeminiTaskType = NonNullable<MemoryEmbeddingProviderCreateOptions["taskType"]>;
declare const GEMINI_EMBEDDING_2_MODELS: Set<string>;
type GeminiTextPart = {
  text: string;
};
type GeminiInlinePart = {
  inlineData: {
    mimeType: string;
    data: string;
  };
};
type GeminiPart = GeminiTextPart | GeminiInlinePart;
type GeminiEmbeddingRequest = {
  content: {
    parts: GeminiPart[];
  };
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  model?: string;
};
type GeminiTextEmbeddingRequest = GeminiEmbeddingRequest;
/** Builds the text-only Gemini embedding request shape used across direct and batch APIs. */
declare function buildGeminiTextEmbeddingRequest(params: {
  text: string;
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  modelPath?: string;
}): GeminiTextEmbeddingRequest;
declare function buildGeminiEmbeddingRequest(params: {
  input: EmbeddingInput;
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  modelPath?: string;
}): GeminiEmbeddingRequest;
/**
 * Returns true if the given model name is a gemini-embedding-2 variant that
 * supports `outputDimensionality` and extended task types.
 */
declare function isGeminiEmbedding2Model(model: string): boolean;
/**
 * Validate and return the `outputDimensionality` for gemini-embedding-2 models.
 * Returns `undefined` for older models (they don't support the param).
 */
declare function resolveGeminiOutputDimensionality(model: string, requested?: number): number | undefined;
declare function normalizeGeminiModel(model: string): string;
declare function createGeminiEmbeddingProvider(options: MemoryEmbeddingProviderCreateOptions): Promise<{
  provider: MemoryEmbeddingProvider;
  client: GeminiEmbeddingClient;
}>;
//#endregion
export { buildGeminiEmbeddingRequest as a, isGeminiEmbedding2Model as c, GeminiTextEmbeddingRequest as i, normalizeGeminiModel as l, GEMINI_EMBEDDING_2_MODELS as n, buildGeminiTextEmbeddingRequest as o, GeminiEmbeddingClient as r, createGeminiEmbeddingProvider as s, DEFAULT_GEMINI_EMBEDDING_MODEL as t, resolveGeminiOutputDimensionality as u };