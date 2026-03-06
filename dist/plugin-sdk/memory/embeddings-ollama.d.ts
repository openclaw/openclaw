import type { SsrFPolicy } from "../infra/net/ssrf.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
export type OllamaEmbeddingClient = {
    baseUrl: string;
    headers: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
    model: string;
    embedBatch: (texts: string[]) => Promise<number[][]>;
};
export declare const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
export declare function createOllamaEmbeddingProvider(options: EmbeddingProviderOptions): Promise<{
    provider: EmbeddingProvider;
    client: OllamaEmbeddingClient;
}>;
