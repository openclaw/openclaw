import type { SsrFPolicy } from "../infra/net/ssrf.js";
export type BatchHttpClientConfig = {
    baseUrl?: string;
    headers?: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
};
export declare function normalizeBatchBaseUrl(client: BatchHttpClientConfig): string;
export declare function buildBatchHeaders(client: Pick<BatchHttpClientConfig, "headers">, params: {
    json: boolean;
}): Record<string, string>;
export declare function splitBatchRequests<T>(requests: T[], maxRequests: number): T[][];
