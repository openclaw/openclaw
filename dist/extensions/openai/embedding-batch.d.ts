import { n as OpenAiEmbeddingClient } from "../../embedding-provider-BteqHNsF.js";

//#region extensions/openai/embedding-batch.d.ts
type EmbeddingBatchExecutionParams = {
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
};
type OpenAiBatchRequest = {
  custom_id: string;
  method: "POST";
  url: "/v1/embeddings";
  body: {
    model: string;
    input: string;
  };
};
declare const OPENAI_BATCH_ENDPOINT = "/v1/embeddings";
declare function runOpenAiEmbeddingBatches(params: {
  openAi: OpenAiEmbeddingClient;
  agentId: string;
  requests: OpenAiBatchRequest[];
} & EmbeddingBatchExecutionParams): Promise<Map<string, number[]>>;
//#endregion
export { OPENAI_BATCH_ENDPOINT, runOpenAiEmbeddingBatches };