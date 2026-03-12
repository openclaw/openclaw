import { type EmbeddingBatchStatus, type ProviderBatchOutputLine } from "./batch-provider-common.js";
import { type EmbeddingBatchExecutionParams } from "./batch-runner.js";
import type { OpenAiEmbeddingClient } from "./embeddings-openai.js";
export type OpenAiBatchRequest = {
    custom_id: string;
    method: "POST";
    url: "/v1/embeddings";
    body: {
        model: string;
        input: string;
    };
};
export type OpenAiBatchStatus = EmbeddingBatchStatus;
export type OpenAiBatchOutputLine = ProviderBatchOutputLine;
export declare const OPENAI_BATCH_ENDPOINT = "/v1/embeddings";
export declare function runOpenAiEmbeddingBatches(params: {
    openAi: OpenAiEmbeddingClient;
    agentId: string;
    requests: OpenAiBatchRequest[];
} & EmbeddingBatchExecutionParams): Promise<Map<string, number[]>>;
