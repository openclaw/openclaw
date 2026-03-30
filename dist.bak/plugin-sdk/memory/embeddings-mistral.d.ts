import type { SsrFPolicy } from "../infra/net/ssrf.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
export type MistralEmbeddingClient = {
    baseUrl: string;
    headers: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
    model: string;
};
export declare const DEFAULT_MISTRAL_EMBEDDING_MODEL = "mistral-embed";
export declare function normalizeMistralModel(model: string): string;
export declare function createMistralEmbeddingProvider(options: EmbeddingProviderOptions): Promise<{
    provider: EmbeddingProvider;
    client: MistralEmbeddingClient;
}>;
export declare function resolveMistralEmbeddingClient(options: EmbeddingProviderOptions): Promise<MistralEmbeddingClient>;
