import type { SsrFPolicy } from "../infra/net/ssrf.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
export type OpenAiEmbeddingClient = {
    baseUrl: string;
    headers: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
    model: string;
};
export declare const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export declare function normalizeOpenAiModel(model: string): string;
export declare function createOpenAiEmbeddingProvider(options: EmbeddingProviderOptions): Promise<{
    provider: EmbeddingProvider;
    client: OpenAiEmbeddingClient;
}>;
export declare function resolveOpenAiEmbeddingClient(options: EmbeddingProviderOptions): Promise<OpenAiEmbeddingClient>;
