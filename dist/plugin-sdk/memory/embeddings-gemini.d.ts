import type { SsrFPolicy } from "../infra/net/ssrf.js";
import type { EmbeddingInput } from "./embedding-inputs.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
export type GeminiEmbeddingClient = {
    baseUrl: string;
    headers: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
    model: string;
    modelPath: string;
    apiKeys: string[];
    outputDimensionality?: number;
};
export declare const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
export declare const GEMINI_EMBEDDING_2_MODELS: Set<string>;
export type GeminiTaskType = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" | "SEMANTIC_SIMILARITY" | "CLASSIFICATION" | "CLUSTERING" | "QUESTION_ANSWERING" | "FACT_VERIFICATION";
export type GeminiTextPart = {
    text: string;
};
export type GeminiInlinePart = {
    inlineData: {
        mimeType: string;
        data: string;
    };
};
export type GeminiPart = GeminiTextPart | GeminiInlinePart;
export type GeminiEmbeddingRequest = {
    content: {
        parts: GeminiPart[];
    };
    taskType: GeminiTaskType;
    outputDimensionality?: number;
    model?: string;
};
export type GeminiTextEmbeddingRequest = GeminiEmbeddingRequest;
/** Builds the text-only Gemini embedding request shape used across direct and batch APIs. */
export declare function buildGeminiTextEmbeddingRequest(params: {
    text: string;
    taskType: GeminiTaskType;
    outputDimensionality?: number;
    modelPath?: string;
}): GeminiTextEmbeddingRequest;
export declare function buildGeminiEmbeddingRequest(params: {
    input: EmbeddingInput;
    taskType: GeminiTaskType;
    outputDimensionality?: number;
    modelPath?: string;
}): GeminiEmbeddingRequest;
/**
 * Returns true if the given model name is a gemini-embedding-2 variant that
 * supports `outputDimensionality` and extended task types.
 */
export declare function isGeminiEmbedding2Model(model: string): boolean;
/**
 * Validate and return the `outputDimensionality` for gemini-embedding-2 models.
 * Returns `undefined` for older models (they don't support the param).
 */
export declare function resolveGeminiOutputDimensionality(model: string, requested?: number): number | undefined;
export declare function normalizeGeminiModel(model: string): string;
export declare function createGeminiEmbeddingProvider(options: EmbeddingProviderOptions): Promise<{
    provider: EmbeddingProvider;
    client: GeminiEmbeddingClient;
}>;
export declare function resolveGeminiEmbeddingClient(options: EmbeddingProviderOptions): Promise<GeminiEmbeddingClient>;
