import { type EmbeddingBatchStatus, type ProviderBatchOutputLine } from "./batch-provider-common.js";
import { type EmbeddingBatchExecutionParams } from "./batch-runner.js";
import type { VoyageEmbeddingClient } from "./embeddings-voyage.js";
/**
 * Voyage Batch API Input Line format.
 * See: https://docs.voyageai.com/docs/batch-inference
 */
export type VoyageBatchRequest = {
    custom_id: string;
    body: {
        input: string | string[];
    };
};
export type VoyageBatchStatus = EmbeddingBatchStatus;
export type VoyageBatchOutputLine = ProviderBatchOutputLine;
export declare const VOYAGE_BATCH_ENDPOINT = "/v1/embeddings";
export declare function runVoyageEmbeddingBatches(params: {
    client: VoyageEmbeddingClient;
    agentId: string;
    requests: VoyageBatchRequest[];
} & EmbeddingBatchExecutionParams): Promise<Map<string, number[]>>;
