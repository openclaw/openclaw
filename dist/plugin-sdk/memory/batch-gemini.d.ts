import { type EmbeddingBatchExecutionParams } from "./batch-runner.js";
import type { GeminiEmbeddingClient } from "./embeddings-gemini.js";
export type GeminiBatchRequest = {
    custom_id: string;
    content: {
        parts: Array<{
            text: string;
        }>;
    };
    taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";
};
export type GeminiBatchStatus = {
    name?: string;
    state?: string;
    outputConfig?: {
        file?: string;
        fileId?: string;
    };
    metadata?: {
        output?: {
            responsesFile?: string;
        };
    };
    error?: {
        message?: string;
    };
};
export type GeminiBatchOutputLine = {
    key?: string;
    custom_id?: string;
    request_id?: string;
    embedding?: {
        values?: number[];
    };
    response?: {
        embedding?: {
            values?: number[];
        };
        error?: {
            message?: string;
        };
    };
    error?: {
        message?: string;
    };
};
export declare function runGeminiEmbeddingBatches(params: {
    gemini: GeminiEmbeddingClient;
    agentId: string;
    requests: GeminiBatchRequest[];
} & EmbeddingBatchExecutionParams): Promise<Map<string, number[]>>;
