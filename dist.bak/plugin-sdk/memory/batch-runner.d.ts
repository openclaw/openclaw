export type EmbeddingBatchExecutionParams = {
    wait: boolean;
    pollIntervalMs: number;
    timeoutMs: number;
    concurrency: number;
    debug?: (message: string, data?: Record<string, unknown>) => void;
};
export declare function runEmbeddingBatchGroups<TRequest>(params: {
    requests: TRequest[];
    maxRequests: number;
    wait: EmbeddingBatchExecutionParams["wait"];
    pollIntervalMs: EmbeddingBatchExecutionParams["pollIntervalMs"];
    timeoutMs: EmbeddingBatchExecutionParams["timeoutMs"];
    concurrency: EmbeddingBatchExecutionParams["concurrency"];
    debugLabel: string;
    debug?: EmbeddingBatchExecutionParams["debug"];
    runGroup: (args: {
        group: TRequest[];
        groupIndex: number;
        groups: number;
        byCustomId: Map<string, number[]>;
    }) => Promise<void>;
}): Promise<Map<string, number[]>>;
export declare function buildEmbeddingBatchGroupOptions<TRequest>(params: {
    requests: TRequest[];
} & EmbeddingBatchExecutionParams, options: {
    maxRequests: number;
    debugLabel: string;
}): {
    requests: TRequest[];
    maxRequests: number;
    wait: boolean;
    pollIntervalMs: number;
    timeoutMs: number;
    concurrency: number;
    debug: ((message: string, data?: Record<string, unknown>) => void) | undefined;
    debugLabel: string;
};
