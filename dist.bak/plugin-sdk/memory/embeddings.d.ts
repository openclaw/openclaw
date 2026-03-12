import type { OpenClawConfig } from "../config/config.js";
import { type GeminiEmbeddingClient } from "./embeddings-gemini.js";
import { type MistralEmbeddingClient } from "./embeddings-mistral.js";
import { type OpenAiEmbeddingClient } from "./embeddings-openai.js";
import { type VoyageEmbeddingClient } from "./embeddings-voyage.js";
export type { GeminiEmbeddingClient } from "./embeddings-gemini.js";
export type { MistralEmbeddingClient } from "./embeddings-mistral.js";
export type { OpenAiEmbeddingClient } from "./embeddings-openai.js";
export type { VoyageEmbeddingClient } from "./embeddings-voyage.js";
export type EmbeddingProvider = {
    id: string;
    model: string;
    maxInputTokens?: number;
    embedQuery: (text: string) => Promise<number[]>;
    embedBatch: (texts: string[]) => Promise<number[][]>;
};
export type EmbeddingProviderId = "openai" | "local" | "gemini" | "voyage" | "mistral";
export type EmbeddingProviderRequest = EmbeddingProviderId | "auto";
export type EmbeddingProviderFallback = EmbeddingProviderId | "none";
export type EmbeddingProviderResult = {
    provider: EmbeddingProvider | null;
    requestedProvider: EmbeddingProviderRequest;
    fallbackFrom?: EmbeddingProviderId;
    fallbackReason?: string;
    providerUnavailableReason?: string;
    openAi?: OpenAiEmbeddingClient;
    gemini?: GeminiEmbeddingClient;
    voyage?: VoyageEmbeddingClient;
    mistral?: MistralEmbeddingClient;
};
export type EmbeddingProviderOptions = {
    config: OpenClawConfig;
    agentDir?: string;
    provider: EmbeddingProviderRequest;
    remote?: {
        baseUrl?: string;
        apiKey?: string;
        headers?: Record<string, string>;
    };
    model: string;
    fallback: EmbeddingProviderFallback;
    local?: {
        modelPath?: string;
        modelCacheDir?: string;
    };
};
export declare const DEFAULT_LOCAL_MODEL = "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";
export declare function createEmbeddingProvider(options: EmbeddingProviderOptions): Promise<EmbeddingProviderResult>;
