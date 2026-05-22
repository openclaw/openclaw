/**
 * @deprecated Z.AI provider-owned endpoint detection helper. Use the bundled
 * Z.AI plugin public API instead, or keep endpoint probing local to your
 * provider plugin.
 */
export type ZaiEndpointId = "global" | "cn" | "coding-global" | "coding-cn";
export type ZaiDetectedEndpoint = {
    endpoint: ZaiEndpointId;
    baseUrl: string;
    modelId: string;
    note: string;
};
type DetectZaiEndpoint = (params: {
    apiKey: string;
    endpoint?: ZaiEndpointId;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
}) => Promise<ZaiDetectedEndpoint | null>;
/** @deprecated Z.AI provider-owned endpoint detection helper. */
export declare const detectZaiEndpoint: DetectZaiEndpoint;
export {};
