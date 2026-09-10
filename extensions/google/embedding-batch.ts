// Google plugin module implements embedding batch behavior.
import { createHash, randomUUID } from "node:crypto";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
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
  type MemoryEmbeddingBatchSubmissionLifecycle,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  assertOkOrThrowProviderError,
  createProviderOperationDeadline,
  createProviderHttpError,
  readProviderJsonObjectResponse,
  resolveProviderOperationTimeoutMs,
  type ProviderOperationDeadline,
} from "openclaw/plugin-sdk/provider-http";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import {
  buildGeminiBatchLifecycleLog,
  getGeminiBatchOutputFailureFields,
  getGeminiBatchState,
  type GeminiBatchLifecycleContext,
  type GeminiBatchOperation,
} from "./embedding-batch-observability.js";
import {
  sanitizeGeminiEmbedding,
  type GeminiEmbeddingClient,
  type GeminiTextEmbeddingRequest,
} from "./embedding-provider.js";
import { parseGeminiAuth } from "./gemini-auth.js";

type GeminiBatchRequest = {
  custom_id: string;
  /** Stable memory-cache identity; never sent to Google. */
  chunkHash: string;
  request: GeminiTextEmbeddingRequest;
};

function buildGeminiBatchRequestFingerprint(params: {
  gemini: GeminiEmbeddingClient;
  requests: GeminiBatchRequest[];
  groupIndex: number;
  groups: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        baseUrl: params.gemini.baseUrl,
        modelPath: params.gemini.modelPath,
        outputDimensionality: params.gemini.outputDimensionality,
        groupIndex: params.groupIndex,
        groups: params.groups,
        requests: params.requests,
      }),
    )
    .digest("hex");
}

type GeminiBatchOutputLine = {
  // Alternate ids and direct embeddings are shipped compatible-endpoint shapes.
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
const log = createSubsystemLogger("memory/embeddings/gemini-batch");

function readGeminiBatchErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  // SAFETY: the object guard above makes optional status-field reads safe.
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const value = candidate.status ?? candidate.statusCode;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function isDefinitiveGeminiBatchCreateRejection(error: unknown): boolean {
  if (error instanceof EmbeddingBatchUnavailableError) {
    return true;
  }
  const status = readGeminiBatchErrorStatus(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

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

function createGeminiBatchStageSignal(params: {
  deadline: ProviderOperationDeadline;
  timeoutMs: number;
  signal?: AbortSignal;
}): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(
    resolveProviderOperationTimeoutMs({
      deadline: params.deadline,
      defaultTimeoutMs: params.timeoutMs,
    }),
  );
  return params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
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

function getGeminiBatchOutputFileId(operation: GeminiBatchOperation): string | undefined {
  // Prefer the canonical top-level Batch output. Legacy Operation aliases can
  // lag behind the terminal Batch fields, so they are fallback-only.
  const outputFile = operation.output?.responsesFile;
  const responseFile = operation.response?.responsesFile;
  const metadataFile = operation.metadata?.output?.responsesFile;
  if (!outputFile && responseFile && metadataFile && responseFile !== metadataFile) {
    throw new Error("gemini batch operation returned conflicting output files");
  }
  return outputFile ?? responseFile ?? metadataFile;
}

function buildGeminiUploadBody(params: { jsonl: string; displayName: string }): {
  body: Blob;
  contentType: string;
} {
  const boundary = `openclaw-${randomUUID()}`;
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
  requestFingerprint: string;
  deadline: ProviderOperationDeadline;
  timeoutMs: number;
  signal?: AbortSignal;
  submissionLifecycle?: MemoryEmbeddingBatchSubmissionLifecycle;
}): Promise<{ operation: GeminiBatchOperation; submissionId: string }> {
  const baseUrl = params.gemini.baseUrl;
  const jsonl = params.requests
    .map((request) =>
      JSON.stringify({
        key: request.custom_id,
        request: request.request,
      }),
    )
    .join("\n");
  // Google exposes no create idempotency key. Keep a provider-safe,
  // content-independent id for durable operator correlation.
  const submissionId = `openclaw-memory-${randomUUID()}`;
  const displayName = submissionId;
  const uploadPayload = buildGeminiUploadBody({ jsonl, displayName });

  const uploadUrl = getGeminiBatchFileUrl(baseUrl, "upload", "files");
  debugEmbeddingsLog("memory embeddings: gemini batch upload", {
    uploadUrl,
    baseUrl,
    requests: params.requests.length,
  });
  const uploadSignal = createGeminiBatchStageSignal(params);
  const filePayload = await withRemoteHttpResponse({
    url: uploadUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
    signal: uploadSignal,
    init: {
      method: "POST",
      headers: {
        ...buildBatchHeaders(params.gemini, { json: false }),
        "Content-Type": uploadPayload.contentType,
      },
      body: uploadPayload.body,
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
      displayName,
      inputConfig: {
        file_name: fileId,
      },
    },
  };

  const batchEndpoint = resolveEmbeddingEndpointUrl(
    baseUrl,
    `${params.gemini.modelPath}:asyncBatchEmbedContent`,
  );
  debugEmbeddingsLog("memory embeddings: gemini batch create", {
    batchEndpoint,
    fileId,
  });
  await params.submissionLifecycle?.started({
    submissionId,
    requestFingerprint: params.requestFingerprint,
    manifest: params.requests.map((request) => ({
      customId: request.custom_id,
      chunkHash: request.chunkHash,
    })),
  });
  let createOperationStarted = false;
  try {
    // Signal creation can itself throw after the durable reservation. Keep it
    // inside the cleanup boundary so a request that never starts is released.
    const createSignal = createGeminiBatchStageSignal(params);
    createSignal.throwIfAborted();
    createOperationStarted = true;
    const operation = await withRemoteHttpResponse({
      url: batchEndpoint,
      ssrfPolicy: params.gemini.ssrfPolicy,
      signal: createSignal,
      init: {
        method: "POST",
        headers: buildBatchHeaders(params.gemini, { json: true }),
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
    const batchName = operation.name;
    if (!batchName) {
      throw new Error("gemini batch create failed: missing batch name");
    }
    await params.submissionLifecycle?.accepted({ submissionId, batchName });
    return { operation, submissionId };
  } catch (error) {
    if (!createOperationStarted || isDefinitiveGeminiBatchCreateRejection(error)) {
      await params.submissionLifecycle?.rejected({ submissionId });
    }
    throw error;
  }
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

function applyGeminiBatchOutputLine(params: {
  line: GeminiBatchOutputLine;
  remaining: Set<string>;
  errors: string[];
  byCustomId: Map<string, number[]>;
  expectedDimensions?: number;
}): void {
  const customId = params.line.key ?? params.line.custom_id ?? params.line.request_id;
  // Only the first response for a submitted id may mutate results.
  if (!customId || !params.remaining.delete(customId)) {
    return;
  }
  const error = params.line.error?.message || params.line.response?.error?.message;
  if (error) {
    params.errors.push(`${customId}: ${error}`);
    return;
  }
  const embedding = sanitizeGeminiEmbedding(
    params.line.embedding?.values ?? params.line.response?.embedding?.values ?? [],
    params.expectedDimensions,
  );
  if (embedding.length === 0) {
    params.errors.push(`${customId}: empty embedding`);
    return;
  }
  params.byCustomId.set(customId, embedding);
}

async function fetchGeminiBatchOutput(params: {
  gemini: GeminiEmbeddingClient;
  fileId: string;
  remaining: Set<string>;
  errors: string[];
  byCustomId: Map<string, number[]>;
  signal?: AbortSignal;
}): Promise<void> {
  const downloadUrl = getGeminiBatchFileUrl(params.gemini.baseUrl, "download", params.fileId);
  debugEmbeddingsLog("memory embeddings: gemini batch download", { downloadUrl });
  await withRemoteHttpResponse({
    url: downloadUrl,
    ssrfPolicy: params.gemini.ssrfPolicy,
    signal: params.signal,
    init: {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    },
    onResponse: async (res) => {
      await assertOkOrThrowProviderError(res, "gemini.batch-file-content");
      await readEmbeddingBatchJsonl<GeminiBatchOutputLine>(res, {
        label: "gemini.batch-file-content",
        maxRecords: params.remaining.size,
        onRecord: (line) => {
          applyGeminiBatchOutputLine({
            line,
            remaining: params.remaining,
            errors: params.errors,
            byCustomId: params.byCustomId,
            expectedDimensions: params.gemini.outputDimensionality,
          });
          return params.remaining.size > 0;
        },
      });
    },
  });
}

async function waitForGeminiBatch(params: {
  gemini: GeminiEmbeddingClient;
  batchName: string;
  lifecycle: GeminiBatchLifecycleContext;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  deadline: ProviderOperationDeadline;
  signal?: AbortSignal;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: GeminiBatchOperation;
}): Promise<{ outputFileId: string; operation: GeminiBatchOperation }> {
  let current: GeminiBatchOperation | undefined = params.initial;
  while (true) {
    const operation = current
      ? current
      : await fetchGeminiBatchStatus({
          gemini: params.gemini,
          batchName: params.batchName,
          signal: createGeminiBatchStageSignal(params),
        });
    const state = getGeminiBatchState(operation);
    if (state === "succeeded") {
      const terminalLog = buildGeminiBatchLifecycleLog(params.lifecycle, operation, state);
      log.info("memory embeddings: gemini batch completed", terminalLog);
      const outputFileId = getGeminiBatchOutputFileId(operation);
      if (!outputFileId) {
        log.warn("memory embeddings: gemini batch output metadata unusable", {
          ...terminalLog,
          failureKind: "missing-output-file",
        });
        throw new Error(`gemini batch ${params.batchName} completed without output file`);
      }
      return { outputFileId, operation };
    }
    if (state === "failed" || state === "cancelled" || state === "expired") {
      const rawMessage =
        operation.error?.message ??
        (operation.error?.code === undefined ? "unknown error" : `code ${operation.error.code}`);
      log.warn("memory embeddings: gemini batch terminal failure", {
        ...buildGeminiBatchLifecycleLog(params.lifecycle, operation, state),
        ...(typeof operation.error?.code === "number" && Number.isInteger(operation.error.code)
          ? { providerErrorCode: operation.error.code }
          : {}),
      });
      throw new Error(
        `gemini batch ${params.batchName} ${state}: ${formatBatchErrorDetail(rawMessage) ?? "unknown error"}`,
      );
    }
    if (!params.wait) {
      throw new Error(
        `gemini batch ${params.batchName} submitted; enable remote.batch.wait to await completion`,
      );
    }
    params.debug?.(
      `gemini batch ${params.batchName} ${state}; waiting up to ${params.pollIntervalMs}ms`,
    );
    const waitMs = resolveProviderOperationTimeoutMs({
      deadline: params.deadline,
      defaultTimeoutMs: params.pollIntervalMs,
    });
    await sleepWithAbort(waitMs, params.signal);
    current = undefined;
  }
}

async function recoverAcceptedGeminiBatches(params: {
  gemini: GeminiEmbeddingClient;
  submissionLifecycle?: MemoryEmbeddingBatchSubmissionLifecycle;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  debug?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<Map<string, number[]>> {
  const accepted = await params.submissionLifecycle?.listAccepted?.();
  const publishRecovered = params.submissionLifecycle?.publishRecovered;
  if (!accepted || accepted.length === 0 || !publishRecovered) {
    return new Map();
  }

  const recoveredByHash = new Map<string, number[]>();
  for (const submission of accepted) {
    const deadline = createProviderOperationDeadline({
      label: `gemini batch ${submission.batchName} recovery`,
      timeoutMs: params.timeoutMs,
    });
    const initial = await fetchGeminiBatchStatus({
      gemini: params.gemini,
      batchName: submission.batchName,
      signal: createGeminiBatchStageSignal({
        deadline,
        timeoutMs: params.timeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
      }),
    });
    const lifecycle: GeminiBatchLifecycleContext = {
      batchName: submission.batchName,
      group: 1,
      groups: 1,
      submittedRequests: submission.manifest.length,
      startedAtMs: Date.now(),
    };
    const completed = await waitForGeminiBatch({
      gemini: params.gemini,
      batchName: submission.batchName,
      lifecycle,
      wait: params.wait,
      pollIntervalMs: params.pollIntervalMs,
      timeoutMs: params.timeoutMs,
      deadline,
      ...(params.signal ? { signal: params.signal } : {}),
      debug: params.debug,
      initial,
    });
    const remaining = new Set(submission.manifest.map((entry) => entry.customId));
    const errors: string[] = [];
    const byCustomId = new Map<string, number[]>();
    await fetchGeminiBatchOutput({
      gemini: params.gemini,
      fileId: completed.outputFileId,
      remaining,
      errors,
      byCustomId,
      signal: createGeminiBatchStageSignal({
        deadline,
        timeoutMs: params.timeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
      }),
    });
    if (errors.length > 0) {
      throw new Error(
        `gemini batch ${submission.batchName} recovery failed: ${formatBatchErrorDetail(errors[0]) ?? "unknown error"}`,
      );
    }
    if (remaining.size > 0) {
      throw new Error(
        `gemini batch ${submission.batchName} recovery is missing ${remaining.size} embedding responses`,
      );
    }
    const recovered = await publishRecovered({
      submissionId: submission.submissionId,
      entries: [...byCustomId].map(([customId, embedding]) => ({ customId, embedding })),
    });
    for (const entry of recovered) {
      recoveredByHash.set(entry.chunkHash, entry.embedding);
    }
    params.debug?.("memory embeddings: gemini durable batch output recovered", {
      batchName: submission.batchName,
      requests: submission.manifest.length,
      recovered: recovered.length,
    });
  }
  return recoveredByHash;
}

export async function runGeminiEmbeddingBatches(
  params: {
    gemini: GeminiEmbeddingClient;
    agentId: string;
    requests: GeminiBatchRequest[];
    submissionLifecycle?: MemoryEmbeddingBatchSubmissionLifecycle;
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  if (!params.wait) {
    throw new Error(
      "gemini native embedding batches require remote.batch.wait=true to avoid orphaned jobs",
    );
  }
  const gemini = bindGeminiBatchAuth(params.gemini);
  const recoveredByHash = await recoverAcceptedGeminiBatches({
    gemini,
    wait: params.wait,
    pollIntervalMs: params.pollIntervalMs,
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.debug ? { debug: params.debug } : {}),
    ...(params.submissionLifecycle ? { submissionLifecycle: params.submissionLifecycle } : {}),
  });
  const byCustomId = new Map<string, number[]>();
  const pendingRequests: GeminiBatchRequest[] = [];
  for (const request of params.requests) {
    const recovered = recoveredByHash.get(request.chunkHash);
    if (recovered) {
      byCustomId.set(request.custom_id, recovered);
    } else {
      pendingRequests.push(request);
    }
  }
  if (pendingRequests.length === 0) {
    return byCustomId;
  }
  const completed = await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(
      { ...params, requests: pendingRequests },
      {
        maxRequests: GEMINI_BATCH_MAX_REQUESTS,
        debugLabel: "memory embeddings: gemini batch submit",
      },
    ),
    runGroup: async ({
      group,
      groupIndex,
      groups,
      byCustomId,
      pollIntervalMs,
      timeoutMs,
      signal,
    }) => {
      const deadline = createProviderOperationDeadline({
        label: "gemini embedding batch",
        timeoutMs,
      });
      const startedAtMs = Date.now();
      const requestFingerprint = buildGeminiBatchRequestFingerprint({
        gemini,
        requests: group,
        groupIndex,
        groups,
      });
      const resumed = await params.submissionLifecycle?.resumeAccepted?.({ requestFingerprint });
      let batchInfo: GeminiBatchOperation;
      let batchName: string;
      if (resumed) {
        batchName = resumed.batchName;
        batchInfo = await fetchGeminiBatchStatus({
          gemini,
          batchName,
          signal: createGeminiBatchStageSignal({
            deadline,
            timeoutMs,
            ...(signal ? { signal } : {}),
          }),
        });
      } else {
        const submitted = await submitGeminiBatch({
          gemini,
          requests: group,
          requestFingerprint,
          deadline,
          timeoutMs,
          ...(signal ? { signal } : {}),
          ...(params.submissionLifecycle
            ? { submissionLifecycle: params.submissionLifecycle }
            : {}),
        });
        batchInfo = submitted.operation;
        batchName = batchInfo.name ?? "";
        if (!batchName) {
          throw new Error("gemini batch create failed: missing batch name");
        }
      }
      deadline.label = `gemini batch ${batchName}`;

      const lifecycle: GeminiBatchLifecycleContext = {
        batchName,
        group: groupIndex + 1,
        groups,
        submittedRequests: group.length,
        startedAtMs,
      };

      const lifecycleAction = resumed ? "resumed" : "created";
      params.debug?.(`memory embeddings: gemini batch ${lifecycleAction}`, {
        batchName,
        state: getGeminiBatchState(batchInfo),
        group: groupIndex + 1,
        groups,
        requests: group.length,
        ...(resumed ? { submissionId: resumed.submissionId } : {}),
      });
      log.info(
        `memory embeddings: gemini batch ${lifecycleAction}`,
        buildGeminiBatchLifecycleLog(lifecycle, batchInfo),
      );

      const completed = await waitForGeminiBatch({
        gemini,
        batchName,
        lifecycle,
        wait: params.wait,
        pollIntervalMs,
        timeoutMs,
        deadline,
        ...(signal ? { signal } : {}),
        debug: params.debug,
        initial: batchInfo,
      });

      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));
      const downloadSignal = createGeminiBatchStageSignal({
        deadline,
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
      try {
        await fetchGeminiBatchOutput({
          gemini,
          fileId: completed.outputFileId,
          remaining,
          errors,
          byCustomId,
          signal: downloadSignal,
        });
      } catch (error) {
        log.warn("memory embeddings: gemini batch output reconciliation failed", {
          ...buildGeminiBatchLifecycleLog(lifecycle, completed.operation, "succeeded"),
          returnedEmbeddings: group.length - remaining.size - errors.length,
          unreconciledResponses: remaining.size,
          outputErrors: errors.length,
          ...getGeminiBatchOutputFailureFields(error),
        });
        throw error;
      }

      const outputLog = {
        ...buildGeminiBatchLifecycleLog(lifecycle, completed.operation, "succeeded"),
        returnedEmbeddings: group.length - remaining.size - errors.length,
        missingResponses: remaining.size,
        outputErrors: errors.length,
      };
      if (errors.length > 0 || remaining.size > 0) {
        log.warn("memory embeddings: gemini batch output reconciliation failed", outputLog);
      } else {
        log.info("memory embeddings: gemini batch output reconciled", outputLog);
      }

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
  for (const [customId, embedding] of completed) {
    byCustomId.set(customId, embedding);
  }
  return byCustomId;
}
