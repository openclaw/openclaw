// Google plugin module implements embedding batch behavior.
import crypto from "node:crypto";
import {
  buildEmbeddingBatchGroupOptions,
  runEmbeddingBatchGroups,
  buildBatchHeaders,
  debugEmbeddingsLog,
  normalizeBatchBaseUrl,
  sanitizeAndNormalizeEmbedding,
  withRemoteHttpResponse,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createProviderHttpError,
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import type { GeminiEmbeddingClient, GeminiTextEmbeddingRequest } from "./embedding-provider.js";

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

type GeminiBatchStatus = {
  name?: string;
  state?: string;
  outputConfig?: { file?: string; fileId?: string };
  metadata?: {
    output?: {
      responsesFile?: string;
    };
  };
  error?: { message?: string };
};

type GeminiBatchOutputLine = {
  key?: string;
  custom_id?: string;
  request_id?: string;
  embedding?: { values?: number[] };
  response?: {
    embedding?: { values?: number[] };
    error?: { message?: string };
  };
  error?: { message?: string };
};

const GEMINI_BATCH_MAX_REQUESTS = 50000;
const GEMINI_BATCH_OUTPUT_LINE_MAX_BYTES = 4 * 1024 * 1024;
function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function getGeminiUploadUrl(baseUrl: string): string {
  if (baseUrl.includes("/v1beta")) {
    return baseUrl.replace(/\/v1beta\/?$/, "/upload/v1beta");
  }
  return `${baseUrl.replace(/\/$/, "")}/upload`;
}

function buildGeminiUploadBody(params: { jsonl: string; displayName: string }): {
  body: Blob;
  contentType: string;
} {
  const boundary = `openclaw-${hashText(params.displayName)}`;
  const jsonPart = JSON.stringify({
    file: {
      displayName: params.displayName,
      mimeType: "application/jsonl",
    },
  });
  const delimiter = `--${boundary}\r\n`;
  const closeDelimiter = `--${boundary}--\r\n`;
  const parts = [
    `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${jsonPart}\r\n`,
    `${delimiter}Content-Type: application/jsonl; charset=UTF-8\r\n\r\n${params.jsonl}\r\n`,
    closeDelimiter,
  ];
  const body = new Blob([parts.join("")], { type: "multipart/related" });
  return {
    body,
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

async function submitGeminiBatch(params: {
  gemini: GeminiEmbeddingClient;
  requests: GeminiBatchRequest[];
  agentId: string;
}): Promise<GeminiBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const jsonl = params.requests
    .map((request) =>
      JSON.stringify({
        key: request.custom_id,
        request: request.request,
      }),
    )
    .join("\n");
  const displayName = `memory-embeddings-${hashText(String(Date.now()))}`;
  const uploadPayload = buildGeminiUploadBody({ jsonl, displayName });

  const uploadUrl = `${getGeminiUploadUrl(baseUrl)}/files?uploadType=multipart`;
  debugEmbeddingsLog("memory embeddings: gemini batch upload", {
    uploadUrl,
    baseUrl,
    requests: params.requests.length,
  });
  const filePayload = await withRemoteHttpResponse({
    url: uploadUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
    init: {
      method: "POST",
      headers: {
        ...buildBatchHeaders(params.gemini, { json: false }),
        "Content-Type": uploadPayload.contentType,
      },
      body: uploadPayload.body,
    },
    onResponse: async (fileRes) => {
      if (!fileRes.ok) {
        const text = await readResponseTextLimited(fileRes);
        throw new Error(`gemini batch file upload failed: ${fileRes.status} ${text}`);
      }
      return readProviderJsonResponse<{ name?: string; file?: { name?: string } }>(
        fileRes,
        "gemini.batch-file-upload",
      );
    },
  });
  const fileId = filePayload.name ?? filePayload.file?.name;
  if (!fileId) {
    throw new Error("gemini batch file upload failed: missing file id");
  }

  const batchBody = {
    batch: {
      displayName: `memory-embeddings-${params.agentId}`,
      inputConfig: {
        file_name: fileId,
      },
    },
  };

  const batchEndpoint = `${baseUrl}/${params.gemini.modelPath}:asyncBatchEmbedContent`;
  debugEmbeddingsLog("memory embeddings: gemini batch create", {
    batchEndpoint,
    fileId,
  });
  return await withRemoteHttpResponse({
    url: batchEndpoint,
    ssrfPolicy: params.gemini.ssrfPolicy,
    init: {
      method: "POST",
      headers: buildBatchHeaders(params.gemini, { json: true }),
      body: JSON.stringify(batchBody),
    },
    onResponse: async (batchRes) => {
      if (batchRes.ok) {
        return readProviderJsonResponse<GeminiBatchStatus>(batchRes, "gemini.batch-create");
      }
      const text = await readResponseTextLimited(batchRes);
      if (batchRes.status === 404) {
        throw new Error(
          "gemini batch create failed: 404 (asyncBatchEmbedContent not available for this model/baseUrl). Disable remote.batch.enabled or switch providers.",
        );
      }
      throw new Error(`gemini batch create failed: ${batchRes.status} ${text}`);
    },
  });
}

async function fetchGeminiBatchStatus(params: {
  gemini: GeminiEmbeddingClient;
  batchName: string;
}): Promise<GeminiBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const name = params.batchName.startsWith("batches/")
    ? params.batchName
    : `batches/${params.batchName}`;
  const statusUrl = `${baseUrl}/${name}`;
  debugEmbeddingsLog("memory embeddings: gemini batch status", { statusUrl });
  return await withRemoteHttpResponse({
    url: statusUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
    init: {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        throw await createProviderHttpError(res, "gemini batch status failed");
      }
      return readProviderJsonResponse<GeminiBatchStatus>(res, "gemini.batch-status");
    },
  });
}

async function readGeminiBatchOutputFile(params: {
  gemini: GeminiEmbeddingClient;
  fileId: string;
  maxLines: number;
  onLine: (line: GeminiBatchOutputLine) => void;
}): Promise<void> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const file = params.fileId.startsWith("files/") ? params.fileId : `files/${params.fileId}`;
  const downloadUrl = `${baseUrl}/${file}:download`;
  debugEmbeddingsLog("memory embeddings: gemini batch download", { downloadUrl });
  return await withRemoteHttpResponse({
    url: downloadUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
    init: {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        throw await createProviderHttpError(res, "gemini batch file content failed");
      }
      return await readGeminiBatchOutputLines(res, {
        maxLines: params.maxLines,
        onLine: params.onLine,
      });
    },
  });
}

function parseGeminiBatchOutputLine(line: string): GeminiBatchOutputLine {
  return JSON.parse(line) as GeminiBatchOutputLine;
}

async function readGeminiBatchOutputLines(
  response: Response,
  params: {
    maxLines: number;
    onLine: (line: GeminiBatchOutputLine) => void;
  },
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineCount = 0;
  let line = "";
  let lineBytes = 0;

  const appendSegment = (segment: string) => {
    if (!segment) {
      return;
    }
    lineBytes += encoder.encode(segment).byteLength;
    if (lineBytes > GEMINI_BATCH_OUTPUT_LINE_MAX_BYTES) {
      throw new Error(
        `gemini.batch-file-content: JSONL line exceeds ${GEMINI_BATCH_OUTPUT_LINE_MAX_BYTES} bytes`,
      );
    }
    line += segment;
  };

  const emitLine = () => {
    lineCount += 1;
    if (lineCount > params.maxLines) {
      throw new Error(`gemini.batch-file-content: JSONL output exceeds ${params.maxLines} records`);
    }
    const trimmed = line.trim();
    line = "";
    lineBytes = 0;
    if (trimmed) {
      params.onLine(parseGeminiBatchOutputLine(trimmed));
    }
  };

  const consumeText = (text: string) => {
    let offset = 0;
    while (true) {
      const newline = text.indexOf("\n", offset);
      if (newline === -1) {
        appendSegment(text.slice(offset));
        return;
      }
      appendSegment(text.slice(offset, newline));
      emitLine();
      offset = newline + 1;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.byteLength > 0) {
        consumeText(decoder.decode(value, { stream: true }));
      }
    }
    consumeText(decoder.decode());
    if (line.trim()) {
      emitLine();
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function waitForGeminiBatch(params: {
  gemini: GeminiEmbeddingClient;
  batchName: string;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: GeminiBatchStatus;
}): Promise<{ outputFileId: string }> {
  const start = Date.now();
  let current: GeminiBatchStatus | undefined = params.initial;
  while (true) {
    const status =
      current ??
      (await fetchGeminiBatchStatus({
        gemini: params.gemini,
        batchName: params.batchName,
      }));
    const state = status.state ?? "UNKNOWN";
    if (["SUCCEEDED", "COMPLETED", "DONE"].includes(state)) {
      const outputFileId =
        status.outputConfig?.file ??
        status.outputConfig?.fileId ??
        status.metadata?.output?.responsesFile;
      if (!outputFileId) {
        throw new Error(`gemini batch ${params.batchName} completed without output file`);
      }
      return { outputFileId };
    }
    if (["FAILED", "CANCELLED", "CANCELED", "EXPIRED"].includes(state)) {
      const message = status.error?.message ?? "unknown error";
      throw new Error(`gemini batch ${params.batchName} ${state}: ${message}`);
    }
    if (!params.wait) {
      throw new Error(`gemini batch ${params.batchName} still ${state}; wait disabled`);
    }
    if (Date.now() - start > params.timeoutMs) {
      throw new Error(`gemini batch ${params.batchName} timed out after ${params.timeoutMs}ms`);
    }
    params.debug?.(`gemini batch ${params.batchName} ${state}; waiting ${params.pollIntervalMs}ms`);
    await new Promise((resolve) => {
      setTimeout(resolve, params.pollIntervalMs);
    });
    current = undefined;
  }
}

export async function runGeminiEmbeddingBatches(
  params: {
    gemini: GeminiEmbeddingClient;
    agentId: string;
    requests: GeminiBatchRequest[];
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: GEMINI_BATCH_MAX_REQUESTS,
      debugLabel: "memory embeddings: gemini batch submit",
    }),
    runGroup: async ({ group, groupIndex, groups, byCustomId, pollIntervalMs, timeoutMs }) => {
      const batchInfo = await submitGeminiBatch({
        gemini: params.gemini,
        requests: group,
        agentId: params.agentId,
      });
      const batchName = batchInfo.name ?? "";
      if (!batchName) {
        throw new Error("gemini batch create failed: missing batch name");
      }

      params.debug?.("memory embeddings: gemini batch created", {
        batchName,
        state: batchInfo.state,
        group: groupIndex + 1,
        groups,
        requests: group.length,
      });

      if (
        !params.wait &&
        batchInfo.state &&
        !["SUCCEEDED", "COMPLETED", "DONE"].includes(batchInfo.state)
      ) {
        throw new Error(
          `gemini batch ${batchName} submitted; enable remote.batch.wait to await completion`,
        );
      }

      const completed =
        batchInfo.state && ["SUCCEEDED", "COMPLETED", "DONE"].includes(batchInfo.state)
          ? {
              outputFileId:
                batchInfo.outputConfig?.file ??
                batchInfo.outputConfig?.fileId ??
                batchInfo.metadata?.output?.responsesFile ??
                "",
            }
          : await waitForGeminiBatch({
              gemini: params.gemini,
              batchName,
              wait: params.wait,
              pollIntervalMs,
              timeoutMs,
              debug: params.debug,
              initial: batchInfo,
            });
      if (!completed.outputFileId) {
        throw new Error(`gemini batch ${batchName} completed without output file`);
      }

      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));

      await readGeminiBatchOutputFile({
        gemini: params.gemini,
        fileId: completed.outputFileId,
        maxLines: group.length,
        onLine: (line) => {
          const customId = line.key ?? line.custom_id ?? line.request_id;
          if (!customId || !remaining.has(customId)) {
            return;
          }
          remaining.delete(customId);
          if (line.error?.message) {
            errors.push(`${customId}: ${line.error.message}`);
            return;
          }
          if (line.response?.error?.message) {
            errors.push(`${customId}: ${line.response.error.message}`);
            return;
          }
          const embedding = sanitizeAndNormalizeEmbedding(
            line.embedding?.values ?? line.response?.embedding?.values ?? [],
          );
          if (embedding.length === 0) {
            errors.push(`${customId}: empty embedding`);
            return;
          }
          byCustomId.set(customId, embedding);
        },
      });

      if (errors.length > 0) {
        throw new Error(`gemini batch ${batchName} failed: ${errors.join("; ")}`);
      }
      if (remaining.size > 0) {
        throw new Error(`gemini batch ${batchName} missing ${remaining.size} embedding responses`);
      }
    },
  });
}
