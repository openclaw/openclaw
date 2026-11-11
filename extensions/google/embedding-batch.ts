import {
  buildEmbeddingBatchGroupOptions,
  runEmbeddingBatchGroups,
  buildBatchHeaders,
  debugEmbeddingsLog,
  EmbeddingBatchUnavailableError,
  formatBatchErrorDetail,
  readEmbeddingBatchJsonl,
  resolveEmbeddingEndpointUrl,
  withRemoteHttpResponse,
  type EmbeddingBatchExecutionParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { sha256Hex as hashText } from "openclaw/plugin-sdk/node-crypto-runtime";
import {
  assertOkOrThrowProviderError,
  createProviderOperationDeadline,
  createProviderHttpError,
  readProviderJsonObjectResponse,
  resolveProviderOperationTimeoutMs,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import {
  isValidGeminiEmbeddingValues,
  sanitizeGeminiEmbedding,
  type GeminiEmbeddingClient,
  type GeminiEmbeddingRequest,
} from "./embedding-provider.js";
import { parseGeminiAuth } from "./gemini-auth.js";

type GeminiBatchRequest = {
  custom_id: string;
  request: GeminiEmbeddingRequest;
};

type GeminiBatchOperation = {
  name?: string;
  done?: boolean;
  metadata?: {
    state?: string;
    output?: {
      responsesFile?: string;
    };
  };
  response?: { responsesFile?: string };
  error?: { code?: number; message?: string };
};

type GeminiBatchState = "pending" | "succeeded" | "failed" | "cancelled" | "expired" | "unknown";

type GeminiBatchOutputLine = {
  // Alternate ids and direct embeddings are shipped compatible-endpoint shapes.
  key?: string;
  custom_id?: string;
  request_id?: string;
  embedding?: { values?: unknown };
  response?: {
    embedding?: { values?: unknown };
    error?: { message?: string };
  };
  error?: { message?: string };
};

const GEMINI_BATCH_MAX_REQUESTS = 50000;

function bindGeminiBatchAuth(client: GeminiEmbeddingClient): GeminiEmbeddingClient {
  const apiKey = client.apiKeys[0];
  if (!apiKey) {
    throw new Error("gemini batch requires an API key");
  }
  // Files and batch operations are credential-scoped. Keep one selected
  // credential for upload, creation, polling, and output download.
  return {
    ...client,
    headers: {
      ...parseGeminiAuth(apiKey).headers,
      ...client.headers,
    },
  };
}

function getGeminiBatchFileUrl(
  baseUrl: string,
  route: "upload" | "download",
  fileId: string,
): string {
  const base = new URL(baseUrl);
  const pathname = base.pathname.replace(/\/+$/, "");
  // Google file routes precede the API version; custom download gateways own their prefix.
  if (route === "upload" || base.origin === "https://generativelanguage.googleapis.com") {
    const version = pathname.match(/^(.*)\/(v\d+(?:alpha|beta)?)$/);
    base.pathname = version
      ? `${version[1]}/${route}/${version[2]}`
      : route === "upload"
        ? `${pathname}/upload`
        : pathname;
  }
  const endpoint =
    route === "upload"
      ? fileId
      : `${fileId.startsWith("files/") ? fileId : `files/${fileId}`}:download`;
  const url = new URL(resolveEmbeddingEndpointUrl(base.href, endpoint));
  url.searchParams.set(
    route === "upload" ? "uploadType" : "alt",
    route === "upload" ? "multipart" : "media",
  );
  return url.href;
}

function getGeminiBatchState(operation: GeminiBatchOperation): GeminiBatchState {
  // REST discovery uses BATCH_STATE_* while the public guide and SDK expose
  // JOB_STATE_* for the same operation metadata.
  const rawState = operation.metadata?.state?.replace(/^(?:BATCH|JOB)_STATE_/, "");
  if (rawState === "FAILED") {
    return "failed";
  }
  if (rawState === "CANCELLED" || rawState === "CANCELED") {
    return "cancelled";
  }
  if (rawState === "EXPIRED") {
    return "expired";
  }
  if (operation.error) {
    return "failed";
  }
  if (operation.done === false) {
    return "pending";
  }
  if (operation.done === true) {
    return "succeeded";
  }
  if (rawState === "SUCCEEDED") {
    return "succeeded";
  }
  if (rawState === "PENDING" || rawState === "RUNNING") {
    return "pending";
  }
  return "unknown";
}

function getGeminiBatchOutputFileId(operation: GeminiBatchOperation): string | undefined {
  // Google currently documents response.responsesFile while the official SDK
  // consumes metadata.output.responsesFile. Accept both raw Operation shapes.
  const responseFile = operation.response?.responsesFile;
  const metadataFile = operation.metadata?.output?.responsesFile;
  if (responseFile && metadataFile && responseFile !== metadataFile) {
    throw new Error("gemini batch operation returned conflicting output files");
  }
  return responseFile ?? metadataFile;
}

async function fetchGeminiBatchStatus(params: {
  gemini: GeminiEmbeddingClient;
  batchName: string;
  signal?: AbortSignal;
}): Promise<GeminiBatchOperation> {
  const name = params.batchName.startsWith("batches/")
    ? params.batchName
    : `batches/${params.batchName}`;
  const statusUrl = resolveEmbeddingEndpointUrl(params.gemini.baseUrl, name);
  debugEmbeddingsLog("memory embeddings: gemini batch status", { statusUrl });
  return await withRemoteHttpResponse({
    url: statusUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
    signal: params.signal,
    init: {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    },
    onResponse: async (res) => {
      await assertOkOrThrowProviderError(res, "gemini.batch-status");
      return (await readProviderJsonObjectResponse(
        res,
        "gemini.batch-status",
      )) as GeminiBatchOperation;
    },
  });
}

export async function runGeminiEmbeddingBatches(
  params: {
    gemini: GeminiEmbeddingClient;
    agentId: string;
    requests: GeminiBatchRequest[];
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  const gemini = bindGeminiBatchAuth(params.gemini);
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: GEMINI_BATCH_MAX_REQUESTS,
      debugLabel: "memory embeddings: gemini batch submit",
    }),
    runGroup: async ({ group, groupIndex, groups, byCustomId, pollIntervalMs, timeoutMs }) => {
      const agentId = params.agentId;
      const baseUrl = gemini.baseUrl;
      const jsonl = group
        .map((request) =>
          JSON.stringify({
            key: request.custom_id,
            request: request.request,
          }),
        )
        .join("\n");
      const displayName = `memory-embeddings-${hashText(String(Date.now()))}`;
      const boundary = `openclaw-${hashText(displayName)}`;
      const jsonPart = JSON.stringify({
        file: {
          displayName,
          mimeType: "application/jsonl",
        },
      });
      const delimiter = `--${boundary}\r\n`;
      const closeDelimiter = `--${boundary}--\r\n`;
      const parts = [
        `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${jsonPart}\r\n`,
        `${delimiter}Content-Type: application/jsonl; charset=UTF-8\r\n\r\n${jsonl}\r\n`,
        closeDelimiter,
      ];
      const uploadBody = new Blob([parts.join("")], { type: "multipart/related" });
      const contentType = `multipart/related; boundary=${boundary}`;

      const uploadUrl = getGeminiBatchFileUrl(baseUrl, "upload", "files");
      debugEmbeddingsLog("memory embeddings: gemini batch upload", {
        uploadUrl,
        baseUrl,
        requests: group.length,
      });
      const filePayload = await withRemoteHttpResponse({
        url: uploadUrl,
        ssrfPolicy: gemini.ssrfPolicy,
        init: {
          method: "POST",
          headers: {
            ...buildBatchHeaders(gemini, { json: false }),
            "Content-Type": contentType,
          },
          body: uploadBody,
        },
        onResponse: async (fileRes) => {
          await assertOkOrThrowProviderError(fileRes, "gemini.batch-file-upload");
          return (await readProviderJsonObjectResponse(fileRes, "gemini.batch-file-upload")) as {
            file?: { name?: string };
          };
        },
      });
      const fileId = filePayload.file?.name;
      if (!fileId) {
        throw new Error("gemini batch file upload failed: missing file id");
      }

      const batchBody = {
        batch: {
          displayName: `memory-embeddings-${agentId}`,
          inputConfig: {
            file_name: fileId,
          },
        },
      };

      const batchEndpoint = resolveEmbeddingEndpointUrl(
        baseUrl,
        `${gemini.modelPath}:asyncBatchEmbedContent`,
      );
      debugEmbeddingsLog("memory embeddings: gemini batch create", {
        batchEndpoint,
        fileId,
      });
      const batchInfo = await withRemoteHttpResponse({
        url: batchEndpoint,
        ssrfPolicy: gemini.ssrfPolicy,
        init: {
          method: "POST",
          headers: buildBatchHeaders(gemini, { json: true }),
          body: JSON.stringify(batchBody),
        },
        onResponse: async (batchRes) => {
          if (batchRes.status === 404) {
            const cause = await createProviderHttpError(batchRes, "gemini.batch-create");
            throw new EmbeddingBatchUnavailableError(
              "gemini asyncBatchEmbedContent not available for this request",
              { cause },
            );
          }
          await assertOkOrThrowProviderError(batchRes, "gemini.batch-create");
          return (await readProviderJsonObjectResponse(
            batchRes,
            "gemini.batch-create",
          )) as GeminiBatchOperation;
        },
      });
      const batchName = batchInfo.name ?? "";
      if (!batchName) {
        throw new Error("gemini batch create failed: missing batch name");
      }

      params.debug?.("memory embeddings: gemini batch created", {
        batchName,
        state: getGeminiBatchState(batchInfo),
        group: groupIndex + 1,
        groups,
        requests: group.length,
      });

      const wait = params.wait;
      const debug = params.debug;
      const waitForBatch = async (): Promise<{ outputFileId: string }> => {
        const deadline = createProviderOperationDeadline({
          label: `gemini batch ${batchName}`,
          timeoutMs,
        });
        let current: GeminiBatchOperation | undefined = batchInfo;
        while (true) {
          const operation = current
            ? current
            : await fetchGeminiBatchStatus({
                gemini,
                batchName,
                signal: AbortSignal.timeout(
                  resolveProviderOperationTimeoutMs({
                    deadline,
                    defaultTimeoutMs: timeoutMs,
                  }),
                ),
              });
          const state = getGeminiBatchState(operation);
          if (state === "succeeded") {
            const outputFileId = getGeminiBatchOutputFileId(operation);
            if (!outputFileId) {
              throw new Error(`gemini batch ${batchName} completed without output file`);
            }
            return { outputFileId };
          }
          if (state === "failed" || state === "cancelled" || state === "expired") {
            const rawMessage =
              operation.error?.message ??
              (operation.error?.code === undefined
                ? "unknown error"
                : `code ${operation.error.code}`);
            throw new Error(
              `gemini batch ${batchName} ${state}: ${formatBatchErrorDetail(rawMessage) ?? "unknown error"}`,
            );
          }
          if (!wait) {
            throw new Error(
              `gemini batch ${batchName} submitted; enable remote.batch.wait to await completion`,
            );
          }
          debug?.(`gemini batch ${batchName} ${state}; waiting up to ${pollIntervalMs}ms`);
          await waitProviderOperationPollInterval({
            deadline,
            pollIntervalMs,
          });
          current = undefined;
        }
      };
      const completed = await waitForBatch();

      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));
      const outputFileId = completed.outputFileId;
      const downloadUrl = getGeminiBatchFileUrl(gemini.baseUrl, "download", outputFileId);
      debugEmbeddingsLog("memory embeddings: gemini batch download", { downloadUrl });
      await withRemoteHttpResponse({
        url: downloadUrl,
        ssrfPolicy: gemini.ssrfPolicy,
        init: {
          headers: buildBatchHeaders(gemini, { json: true }),
        },
        onResponse: async (res) => {
          await assertOkOrThrowProviderError(res, "gemini.batch-file-content");
          const applyOutputLine = (line: GeminiBatchOutputLine): void => {
            const expectedDimensions = gemini.outputDimensionality;
            const customId = line.key ?? line.custom_id ?? line.request_id;
            // Only the first response for a submitted id may mutate results.
            if (!customId || !remaining.delete(customId)) {
              return;
            }
            const error = line.error?.message || line.response?.error?.message;
            if (error) {
              errors.push(`${customId}: ${error}`);
              return;
            }
            const values = line.embedding?.values ?? line.response?.embedding?.values;
            if (!isValidGeminiEmbeddingValues(values)) {
              const reason =
                values == null || (Array.isArray(values) && values.length === 0)
                  ? "empty"
                  : "invalid";
              errors.push(`${customId}: ${reason} embedding`);
              return;
            }
            byCustomId.set(customId, sanitizeGeminiEmbedding(values, expectedDimensions));
          };
          await readEmbeddingBatchJsonl<GeminiBatchOutputLine>(res, {
            label: "gemini.batch-file-content",
            maxRecords: remaining.size,
            onRecord: (line) => {
              applyOutputLine(line);
              return errors.length === 0 && remaining.size > 0;
            },
          });
        },
      });

      if (errors.length > 0) {
        throw new Error(
          `gemini batch ${batchName} failed: ${formatBatchErrorDetail(errors[0]) ?? "unknown error"}`,
        );
      }
      if (remaining.size > 0) {
        throw new Error(`gemini batch ${batchName} missing ${remaining.size} embedding responses`);
      }
    },
  });
}
