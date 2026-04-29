import {
  applyEmbeddingBatchOutputLine,
  buildBatchHeaders,
  buildEmbeddingBatchGroupOptions,
  createEmbeddingBatchTimeoutBudget,
  EMBEDDING_BATCH_ENDPOINT,
  extractBatchErrorMessage,
  formatUnavailableBatchError,
  normalizeBatchBaseUrl,
  postJsonWithRetry,
  resolveBatchCompletionFromStatus,
  resolveCompletedBatchResult,
  resolveEmbeddingBatchPollSleepMs,
  resolveEmbeddingBatchTimeoutMs,
  runEmbeddingBatchGroups,
  throwIfBatchTerminalFailure,
  type EmbeddingBatchStatus,
  type BatchCompletionResult,
  type EmbeddingBatchTimeoutBudget,
  type ProviderBatchOutputLine,
  uploadBatchJsonlFile,
  withRemoteHttpResponse,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { OpenAiEmbeddingClient } from "./embedding-provider.js";

type EmbeddingBatchExecutionParams = {
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
};

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

export const OPENAI_BATCH_ENDPOINT = EMBEDDING_BATCH_ENDPOINT;
const OPENAI_BATCH_COMPLETION_WINDOW = "24h";
const OPENAI_BATCH_MAX_REQUESTS = 50000;

type OpenAiBatchDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  postJsonWithRetry: typeof postJsonWithRetry;
  uploadBatchJsonlFile: typeof uploadBatchJsonlFile;
  withRemoteHttpResponse: typeof withRemoteHttpResponse;
};

function resolveOpenAiBatchDeps(overrides: Partial<OpenAiBatchDeps> | undefined): OpenAiBatchDeps {
  return {
    now: overrides?.now ?? Date.now,
    sleep:
      overrides?.sleep ??
      (async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms))),
    postJsonWithRetry: overrides?.postJsonWithRetry ?? postJsonWithRetry,
    uploadBatchJsonlFile: overrides?.uploadBatchJsonlFile ?? uploadBatchJsonlFile,
    withRemoteHttpResponse: overrides?.withRemoteHttpResponse ?? withRemoteHttpResponse,
  };
}

function openAiBatchTimeoutMessage(budget: EmbeddingBatchTimeoutBudget, batchId?: string): string {
  return `openai batch${batchId ? ` ${batchId}` : ""} timed out after ${budget.timeoutMs}ms`;
}

function resolveOpenAiBatchTimeoutMs(
  budget: EmbeddingBatchTimeoutBudget,
  batchId?: string,
): number {
  return resolveEmbeddingBatchTimeoutMs({
    budget,
    timeoutMessage: openAiBatchTimeoutMessage(budget, batchId),
  });
}

async function submitOpenAiBatch(params: {
  openAi: OpenAiEmbeddingClient;
  requests: OpenAiBatchRequest[];
  agentId: string;
  timeoutMs: () => number;
  deps: OpenAiBatchDeps;
}): Promise<OpenAiBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.openAi);
  const inputFileId = await params.deps.uploadBatchJsonlFile({
    client: params.openAi,
    requests: params.requests,
    errorPrefix: "openai batch file upload failed",
    timeoutMs: params.timeoutMs,
  });

  return await params.deps.postJsonWithRetry<OpenAiBatchStatus>({
    url: `${baseUrl}/batches`,
    headers: buildBatchHeaders(params.openAi, { json: true }),
    ssrfPolicy: params.openAi.ssrfPolicy,
    fetchImpl: params.openAi.fetchImpl,
    timeoutMs: params.timeoutMs,
    body: {
      input_file_id: inputFileId,
      endpoint: OPENAI_BATCH_ENDPOINT,
      completion_window: OPENAI_BATCH_COMPLETION_WINDOW,
      metadata: {
        source: "openclaw-memory",
        agent: params.agentId,
      },
    },
    errorPrefix: "openai batch create failed",
  });
}

async function fetchOpenAiBatchStatus(params: {
  openAi: OpenAiEmbeddingClient;
  batchId: string;
  timeoutMs: number;
  deps: OpenAiBatchDeps;
}): Promise<OpenAiBatchStatus> {
  return await fetchOpenAiBatchResource({
    openAi: params.openAi,
    path: `/batches/${params.batchId}`,
    errorPrefix: "openai batch status",
    timeoutMs: params.timeoutMs,
    deps: params.deps,
    parse: async (res) => (await res.json()) as OpenAiBatchStatus,
  });
}

async function fetchOpenAiFileContent(params: {
  openAi: OpenAiEmbeddingClient;
  fileId: string;
  timeoutMs: number;
  deps: OpenAiBatchDeps;
}): Promise<string> {
  return await fetchOpenAiBatchResource({
    openAi: params.openAi,
    path: `/files/${params.fileId}/content`,
    errorPrefix: "openai batch file content",
    timeoutMs: params.timeoutMs,
    deps: params.deps,
    parse: async (res) => await res.text(),
  });
}

async function fetchOpenAiBatchResource<T>(params: {
  openAi: OpenAiEmbeddingClient;
  path: string;
  errorPrefix: string;
  timeoutMs: number;
  deps: OpenAiBatchDeps;
  parse: (res: Response) => Promise<T>;
}): Promise<T> {
  const baseUrl = normalizeBatchBaseUrl(params.openAi);
  return await params.deps.withRemoteHttpResponse({
    url: `${baseUrl}${params.path}`,
    ssrfPolicy: params.openAi.ssrfPolicy,
    fetchImpl: params.openAi.fetchImpl,
    timeoutMs: params.timeoutMs,
    init: {
      headers: buildBatchHeaders(params.openAi, { json: true }),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${params.errorPrefix} failed: ${res.status} ${text}`);
      }
      return await params.parse(res);
    },
  });
}

function parseOpenAiBatchOutput(text: string): OpenAiBatchOutputLine[] {
  if (!text.trim()) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OpenAiBatchOutputLine);
}

async function readOpenAiBatchError(params: {
  openAi: OpenAiEmbeddingClient;
  errorFileId: string;
  batchId: string;
  budget: EmbeddingBatchTimeoutBudget;
  deps: OpenAiBatchDeps;
}): Promise<string | undefined> {
  try {
    const content = await fetchOpenAiFileContent({
      openAi: params.openAi,
      fileId: params.errorFileId,
      timeoutMs: resolveOpenAiBatchTimeoutMs(params.budget, params.batchId),
      deps: params.deps,
    });
    const lines = parseOpenAiBatchOutput(content);
    return extractBatchErrorMessage(lines);
  } catch (err) {
    return formatUnavailableBatchError(err);
  }
}

async function waitForOpenAiBatch(params: {
  openAi: OpenAiEmbeddingClient;
  batchId: string;
  wait: boolean;
  pollIntervalMs: number;
  budget: EmbeddingBatchTimeoutBudget;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: OpenAiBatchStatus;
  deps: OpenAiBatchDeps;
}): Promise<BatchCompletionResult> {
  let current: OpenAiBatchStatus | undefined = params.initial;
  while (true) {
    const status =
      current ??
      (await fetchOpenAiBatchStatus({
        openAi: params.openAi,
        batchId: params.batchId,
        timeoutMs: resolveOpenAiBatchTimeoutMs(params.budget, params.batchId),
        deps: params.deps,
      }));
    const state = status.status ?? "unknown";
    if (state === "completed") {
      return resolveBatchCompletionFromStatus({
        provider: "openai",
        batchId: params.batchId,
        status,
      });
    }
    await throwIfBatchTerminalFailure({
      provider: "openai",
      status: { ...status, id: params.batchId },
      readError: async (errorFileId) =>
        await readOpenAiBatchError({
          openAi: params.openAi,
          errorFileId,
          batchId: params.batchId,
          budget: params.budget,
          deps: params.deps,
        }),
    });
    if (!params.wait) {
      throw new Error(`openai batch ${params.batchId} still ${state}; wait disabled`);
    }
    params.debug?.(`openai batch ${params.batchId} ${state}; waiting ${params.pollIntervalMs}ms`);
    const sleepMs = resolveEmbeddingBatchPollSleepMs({
      budget: params.budget,
      pollIntervalMs: params.pollIntervalMs,
      timeoutMessage: openAiBatchTimeoutMessage(params.budget, params.batchId),
    });
    await params.deps.sleep(sleepMs);
    current = undefined;
  }
}

export async function runOpenAiEmbeddingBatches(
  params: {
    openAi: OpenAiEmbeddingClient;
    agentId: string;
    requests: OpenAiBatchRequest[];
    deps?: Partial<OpenAiBatchDeps>;
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  const deps = resolveOpenAiBatchDeps(params.deps);
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: OPENAI_BATCH_MAX_REQUESTS,
      debugLabel: "memory embeddings: openai batch submit",
    }),
    runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
      const budget = createEmbeddingBatchTimeoutBudget({
        timeoutMs: params.timeoutMs,
        now: deps.now,
      });
      const batchInfo = await submitOpenAiBatch({
        openAi: params.openAi,
        requests: group,
        agentId: params.agentId,
        timeoutMs: () => resolveOpenAiBatchTimeoutMs(budget),
        deps,
      });
      if (!batchInfo.id) {
        throw new Error("openai batch create failed: missing batch id");
      }
      const batchId = batchInfo.id;

      params.debug?.("memory embeddings: openai batch created", {
        batchId: batchInfo.id,
        status: batchInfo.status,
        group: groupIndex + 1,
        groups,
        requests: group.length,
      });

      const completed = await resolveCompletedBatchResult({
        provider: "openai",
        status: batchInfo,
        wait: params.wait,
        waitForBatch: async () =>
          await waitForOpenAiBatch({
            openAi: params.openAi,
            batchId,
            wait: params.wait,
            pollIntervalMs: params.pollIntervalMs,
            budget,
            debug: params.debug,
            initial: batchInfo,
            deps,
          }),
      });

      const content = await fetchOpenAiFileContent({
        openAi: params.openAi,
        fileId: completed.outputFileId,
        timeoutMs: resolveOpenAiBatchTimeoutMs(budget, batchId),
        deps,
      });
      const outputLines = parseOpenAiBatchOutput(content);
      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));

      for (const line of outputLines) {
        applyEmbeddingBatchOutputLine({ line, remaining, errors, byCustomId });
      }

      if (errors.length > 0) {
        throw new Error(`openai batch ${batchInfo.id} failed: ${errors.join("; ")}`);
      }
      if (remaining.size > 0) {
        throw new Error(
          `openai batch ${batchInfo.id} missing ${remaining.size} embedding responses`,
        );
      }
    },
  });
}
