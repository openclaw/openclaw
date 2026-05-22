import type { EmbeddingProviderOptions } from "./embeddings.types.js";
import type { SsrFPolicy } from "./ssrf-policy.js";
export type RemoteEmbeddingProviderId = string;
export declare function resolveRemoteEmbeddingBearerClient(params: {
    provider: RemoteEmbeddingProviderId;
    options: EmbeddingProviderOptions;
    defaultBaseUrl: string;
}): Promise<{
    baseUrl: string;
    headers: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
}>;
