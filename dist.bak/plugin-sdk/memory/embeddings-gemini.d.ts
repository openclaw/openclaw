import type { SsrFPolicy } from "../infra/net/ssrf.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
export type GeminiEmbeddingClient = {
    baseUrl: string;
    headers: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
    model: string;
    modelPath: string;
    apiKeys: string[];
};
export declare const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
export declare function createGeminiEmbeddingProvider(options: EmbeddingProviderOptions): Promise<{
    provider: EmbeddingProvider;
    client: GeminiEmbeddingClient;
}>;
export declare function resolveGeminiEmbeddingClient(options: EmbeddingProviderOptions): Promise<GeminiEmbeddingClient>;
