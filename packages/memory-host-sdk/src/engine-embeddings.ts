// Real workspace contract for memory embedding providers and batch helpers.

export {
  EmbeddingBatchUnavailableError,
  extractBatchErrorMessage,
  formatBatchErrorDetail,
  formatUnavailableBatchError,
  isEmbeddingBatchUnavailableError,
} from "./host/batch-error-utils.js";
export { postJsonWithRetry } from "./host/batch-http.js";
export { readEmbeddingBatchJsonl } from "./host/batch-output.js";
export {
  EMBEDDING_BATCH_ENDPOINT,
  type EmbeddingBatchStatus,
  type ProviderBatchOutputLine,
} from "./host/batch-provider-common.js";
export {
  buildEmbeddingBatchGroupOptions,
  runEmbeddingBatchGroups,
  runEmbeddingBatches,
  type EmbeddingBatchExecutionParams,
} from "./host/batch-runner.js";
export {
  resolveBatchCompletionFromStatus,
  throwIfBatchTerminalFailure,
  waitForEmbeddingBatch,
} from "./host/batch-status.js";
export { uploadBatchJsonlFile } from "./host/batch-upload.js";
export { buildBatchHeaders, normalizeBatchBaseUrl } from "./host/batch-utils.js";
export {
  isMissingEmbeddingApiKeyError,
  mapBatchEmbeddingsByIndex,
  sanitizeEmbeddingCacheHeaders,
} from "./host/embedding-provider-adapter-utils.js";
export { sanitizeAndNormalizeEmbedding } from "./host/embedding-vectors.js";
export { debugEmbeddingsLog } from "./host/embeddings-debug.js";
export { normalizeEmbeddingModelWithPrefixes } from "./host/embeddings-model-normalize.js";
export {
  embeddingProviderOwnsDestination,
  resolveEmbeddingEndpointUrl,
  resolveRemoteEmbeddingBearerClient,
} from "./host/embeddings-remote-client.js";
export {
  createRemoteEmbeddingProvider,
  resolveRemoteEmbeddingClient,
  type RemoteEmbeddingClient,
} from "./host/embeddings-remote-provider.js";
export {
  estimateStructuredEmbeddingInputBytes,
  estimateUtf8Bytes,
} from "./host/embedding-input-limits.js";
export {
  formatEmbeddingModelInput,
  formatEmbeddingTaskText,
  hasNonTextEmbeddingParts,
  resolveEmbeddingInputFormatVersion,
  type EmbeddingInput,
} from "./host/embedding-inputs.js";
export { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "./host/remote-http.js";
export { classifyMemoryMultimodalPath } from "./host/multimodal.js";
