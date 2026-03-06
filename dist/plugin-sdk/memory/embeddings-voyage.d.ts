import type { SsrFPolicy } from "../infra/net/ssrf.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
export type VoyageEmbeddingClient = {
    baseUrl: string;
    headers: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
    model: string;
};
export declare const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-4-large";
export declare function normalizeVoyageModel(model: string): string;
export declare function createVoyageEmbeddingProvider(options: EmbeddingProviderOptions): Promise<{
    provider: EmbeddingProvider;
    client: VoyageEmbeddingClient;
}>;
export declare function resolveVoyageEmbeddingClient(options: EmbeddingProviderOptions): Promise<VoyageEmbeddingClient>;
