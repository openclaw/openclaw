import { i as GeminiTextEmbeddingRequest, r as GeminiEmbeddingClient } from "../../embedding-provider-C87_JWtG.js";

//#region extensions/google/embedding-batch.d.ts
type EmbeddingBatchExecutionParams = {
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
};
type GeminiBatchRequest = {
  custom_id: string;
  request: GeminiTextEmbeddingRequest;
};
declare function runGeminiEmbeddingBatches(params: {
  gemini: GeminiEmbeddingClient;
  agentId: string;
  requests: GeminiBatchRequest[];
} & EmbeddingBatchExecutionParams): Promise<Map<string, number[]>>;
//#endregion
export { runGeminiEmbeddingBatches };