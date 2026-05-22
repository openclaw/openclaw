import type { SsrFPolicy } from "./ssrf-policy.js";
export declare function fetchRemoteEmbeddingVectors(params: {
    url: string;
    headers: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    body: unknown;
    errorPrefix: string;
}): Promise<number[][]>;
