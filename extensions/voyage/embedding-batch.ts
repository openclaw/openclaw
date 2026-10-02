import {
  buildBatchHeaders,
  buildEmbeddingBatchGroupOptions,
  EMBEDDING_BATCH_ENDPOINT,
  extractBatchErrorMessage,
  formatBatchErrorDetail,
  formatUnavailableBatchError,
  postJsonWithRetry,
  resolveEmbeddingEndpointUrl,
  runEmbeddingBatches,
  type EmbeddingBatchExecutionParams,
  type EmbeddingBatchStatus,
  type ProviderBatchOutputLine,
  type RemoteEmbeddingClient,
  uploadBatchJsonlFile,
  waitForEmbeddingBatch,
  withRemoteHttpResponse,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  assertOkOrThrowProviderError,
  createProviderOperationDeadline,
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";

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

const VOYAGE_BATCH_COMPLETION_WINDOW = "12h";
const VOYAGE_BATCH_MAX_REQUESTS = 50000;
// Successful status/error-file responses are untrusted external bodies. Cap
// them at 16 MiB; non-OK diagnostics use the shared bounded provider prefix.
const VOYAGE_BATCH_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

async function fetchVoyageBatchResource<T>(params: {
  client: RemoteEmbeddingClient;
  path: string;
  label: string;
  signal?: AbortSignal;
  parse: (res: Response) => Promise<T>;
}): Promise<T> {
  return await withRemoteHttpResponse({
    url: resolveEmbeddingEndpointUrl(params.client.baseUrl, params.path),
    ssrfPolicy: params.client.ssrfPolicy,
    resolveRequestHeaders: params.client.resolveRequestHeaders,
    signal: params.signal,
    init: {
      headers: buildBatchHeaders(params.client, { json: true }),
    },
    onResponse: async (res, requestHeaders) => {
      await assertOkOrThrowProviderError(res, params.label, { requestHeaders });
      return await params.parse(res);
    },
  });
}

async function readVoyageBatchError(params: {
  client: RemoteEmbeddingClient;
  errorFileId: string;
}): Promise<string | undefined> {
  try {
    return await fetchVoyageBatchResource({
      client: params.client,
      path: `files/${params.errorFileId}/content`,
      label: "voyage.batch-error-file-content",
      parse: async (res) => {
        const bytes = await readResponseWithLimit(res, VOYAGE_BATCH_RESPONSE_MAX_BYTES, {
          onOverflow: ({ maxBytes: maxBytesLocal }) =>
            new Error(`voyage batch error file content exceeds ${maxBytesLocal} bytes`),
        });
        const text = new TextDecoder().decode(bytes);
        if (!text.trim()) {
          return undefined;
        }
        const lines = normalizeStringEntries(text.split("\n")).map(
          (line) => JSON.parse(line) as ProviderBatchOutputLine,
        );
        return formatBatchErrorDetail(extractBatchErrorMessage(lines));
      },
    });
  } catch (err) {
    return formatUnavailableBatchError(err);
  }
}

export async function runVoyageEmbeddingBatches(
  params: {
    client: RemoteEmbeddingClient;
    agentId: string;
    requests: VoyageBatchRequest[];
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  return await runEmbeddingBatches({
    provider: "voyage",
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: VOYAGE_BATCH_MAX_REQUESTS,
      debugLabel: "memory embeddings: voyage batch submit",
    }),
    submit: async (group) => {
      const { client, agentId } = params;
      const inputFileId = await uploadBatchJsonlFile({
        client,
        requests: group,
        errorPrefix: "voyage batch file upload failed",
      });
      return await postJsonWithRetry<EmbeddingBatchStatus>({
        url: resolveEmbeddingEndpointUrl(client.baseUrl, "batches"),
        headers: buildBatchHeaders(client, { json: true }),
        ssrfPolicy: client.ssrfPolicy,
        resolveRequestHeaders: client.resolveRequestHeaders,
        body: {
          input_file_id: inputFileId,
          endpoint: EMBEDDING_BATCH_ENDPOINT,
          completion_window: VOYAGE_BATCH_COMPLETION_WINDOW,
          request_params: {
            model: client.model,
            input_type: "document",
          },
          metadata: {
            source: "clawdbot-memory",
            agent: agentId,
          },
        },
        errorPrefix: "voyage batch create failed",
      });
    },
    readError: (errorFileId) => readVoyageBatchError({ client: params.client, errorFileId }),
    readOutput: (fileId, read) =>
      fetchVoyageBatchResource({
        client: params.client,
        path: `files/${fileId}/content`,
        label: "voyage.batch-file-content",
        parse: read,
      }),
    waitForBatch: async (batchInfo, pollIntervalMs, timeoutMs) => {
      const batchId = batchInfo.id;
      const client = params.client;
      const wait = params.wait;
      const debug = params.debug;
      const deadline = createProviderOperationDeadline({
        label: `voyage batch ${batchId}`,
        timeoutMs,
      });
      return await waitForEmbeddingBatch({
        provider: "voyage",
        batchId,
        wait,
        pollIntervalMs,
        timeoutMs,
        debug,
        initial: batchInfo,
        fetchStatus: (signal) =>
          fetchVoyageBatchResource({
            client,
            path: `batches/${batchId}`,
            label: "voyage.batch-status",
            signal,
            parse: (res) =>
              readProviderJsonResponse<EmbeddingBatchStatus>(res, "voyage-batch-status", {
                maxBytes: VOYAGE_BATCH_RESPONSE_MAX_BYTES,
              }),
          }),
        resolveTimeoutMs: () =>
          resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: timeoutMs }),
        waitForPoll: (delayMs) =>
          waitProviderOperationPollInterval({ deadline, pollIntervalMs: delayMs }),
        readError: async (errorFileId) => await readVoyageBatchError({ client, errorFileId }),
      });
    },
  });
}
