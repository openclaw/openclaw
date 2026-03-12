import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { type RemoteEmbeddingProviderId } from "./embeddings-remote-client.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
export type RemoteEmbeddingClient = {
    baseUrl: string;
    headers: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
    model: string;
};
export declare function createRemoteEmbeddingProvider(params: {
    id: string;
    client: RemoteEmbeddingClient;
    errorPrefix: string;
    maxInputTokens?: number;
}): EmbeddingProvider;
export declare function resolveRemoteEmbeddingClient(params: {
    provider: RemoteEmbeddingProviderId;
    options: EmbeddingProviderOptions;
    defaultBaseUrl: string;
    normalizeModel: (model: string) => string;
}): Promise<RemoteEmbeddingClient>;
