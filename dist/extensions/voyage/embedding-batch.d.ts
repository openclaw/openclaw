import { D as EmbeddingBatchExecutionParams, N as postJsonWithRetry, r as withRemoteHttpResponse, y as uploadBatchJsonlFile } from "../../memory-core-host-engine-embeddings-C18-b9Ua.js";
import { n as VoyageEmbeddingClient } from "../../embedding-provider-BAeM-Ntk.js";

//#region extensions/voyage/embedding-batch.d.ts
/**
 * Voyage Batch API Input Line format.
 * See: https://docs.voyageai.com/docs/batch-inference
 */
type VoyageBatchRequest = {
  custom_id: string;
  body: {
    input: string | string[];
  };
};
type VoyageBatchDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  postJsonWithRetry: typeof postJsonWithRetry;
  uploadBatchJsonlFile: typeof uploadBatchJsonlFile;
  withRemoteHttpResponse: typeof withRemoteHttpResponse;
};
declare function runVoyageEmbeddingBatches(params: {
  client: VoyageEmbeddingClient;
  agentId: string;
  requests: VoyageBatchRequest[];
  deps?: Partial<VoyageBatchDeps>;
} & EmbeddingBatchExecutionParams): Promise<Map<string, number[]>>;
//#endregion
export { runVoyageEmbeddingBatches };