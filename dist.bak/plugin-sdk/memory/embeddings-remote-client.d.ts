import type { SsrFPolicy } from "../infra/net/ssrf.js";
import type { EmbeddingProviderOptions } from "./embeddings.js";
export type RemoteEmbeddingProviderId = "openai" | "voyage" | "mistral";
export declare function resolveRemoteEmbeddingBearerClient(params: {
    provider: RemoteEmbeddingProviderId;
    options: EmbeddingProviderOptions;
    defaultBaseUrl: string;
}): Promise<{
    baseUrl: string;
    headers: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
}>;
