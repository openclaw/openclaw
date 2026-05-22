export type ZaiEndpointId = "global" | "cn" | "coding-global" | "coding-cn";
export type ZaiDetectedEndpoint = {
    endpoint: ZaiEndpointId;
    /** Provider baseUrl to store in config. */
    baseUrl: string;
    /** Recommended default model id for that endpoint. */
    modelId: string;
    /** Human-readable note explaining the choice. */
    note: string;
};
export declare function detectZaiEndpoint(params: {
    apiKey: string;
    endpoint?: ZaiEndpointId;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
}): Promise<ZaiDetectedEndpoint | null>;
