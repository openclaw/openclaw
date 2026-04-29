import { createInterface } from "node:readline";
import { Readable } from "node:stream";
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
  type EmbeddingBatchExecutionParams,
  type EmbeddingBatchStatus,
  type BatchCompletionResult,
  type EmbeddingBatchTimeoutBudget,
  type ProviderBatchOutputLine,
  uploadBatchJsonlFile,
  withRemoteHttpResponse,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { VoyageEmbeddingClient } from "./embedding-provider.js";

/**
 * Voyage Batch API Input Line format.
 * See: https://docs.voyageai.com/docs/batch-inference
 */
export type VoyageBatchRequest = {
  custom_id: string;
  body: {
    input: string | string[];
  };
};

export type VoyageBatchStatus = EmbeddingBatchStatus;
export type VoyageBatchOutputLine = ProviderBatchOutputLine;

export const VOYAGE_BATCH_ENDPOINT = EMBEDDING_BATCH_ENDPOINT;
const VOYAGE_BATCH_COMPLETION_WINDOW = "12h";
const VOYAGE_BATCH_MAX_REQUESTS = 50000;

type VoyageBatchDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  postJsonWithRetry: typeof postJsonWithRetry;
  uploadBatchJsonlFile: typeof uploadBatchJsonlFile;
  withRemoteHttpResponse: typeof withRemoteHttpResponse;
};

function resolveVoyageBatchDeps(overrides: Partial<VoyageBatchDeps> | undefined): VoyageBatchDeps {
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

function voyageBatchTimeoutMessage(budget: EmbeddingBatchTimeoutBudget, batchId?: string): string {
  return `voyage batch${batchId ? ` ${batchId}` : ""} timed out after ${budget.timeoutMs}ms`;
}

function resolveVoyageBatchTimeoutMs(
  budget: EmbeddingBatchTimeoutBudget,
  batchId?: string,
): number {
  return resolveEmbeddingBatchTimeoutMs({
    budget,
    timeoutMessage: voyageBatchTimeoutMessage(budget, batchId),
  });
}

async function assertVoyageResponseOk(res: Response, context: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${context}: ${res.status} ${text}`);
  }
}

function buildVoyageBatchRequest<T>(params: {
  client: VoyageEmbeddingClient;
  path: string;
  timeoutMs: number;
  onResponse: (res: Response) => Promise<T>;
}) {
  const baseUrl = normalizeBatchBaseUrl(params.client);
  return {
    url: `${baseUrl}/${params.path}`,
    ssrfPolicy: params.client.ssrfPolicy,
    timeoutMs: params.timeoutMs,
    init: {
      headers: buildBatchHeaders(params.client, { json: true }),
    },
    onResponse: params.onResponse,
  };
}

async function submitVoyageBatch(params: {
  client: VoyageEmbeddingClient;
  requests: VoyageBatchRequest[];
  agentId: string;
  timeoutMs: () => number;
  deps: VoyageBatchDeps;
}): Promise<VoyageBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.client);
  const inputFileId = await params.deps.uploadBatchJsonlFile({
    client: params.client,
    requests: params.requests,
    errorPrefix: "voyage batch file upload failed",
    timeoutMs: params.timeoutMs,
  });

  // 2. Create batch job using Voyage Batches API
  return await params.deps.postJsonWithRetry<VoyageBatchStatus>({
    url: `${baseUrl}/batches`,
    headers: buildBatchHeaders(params.client, { json: true }),
    ssrfPolicy: params.client.ssrfPolicy,
    timeoutMs: params.timeoutMs,
    body: {
      input_file_id: inputFileId,
      endpoint: VOYAGE_BATCH_ENDPOINT,
      completion_window: VOYAGE_BATCH_COMPLETION_WINDOW,
      request_params: {
        model: params.client.model,
        input_type: "document",
      },
      metadata: {
        source: "clawdbot-memory",
        agent: params.agentId,
      },
    },
    errorPrefix: "voyage batch create failed",
  });
}

async function fetchVoyageBatchStatus(params: {
  client: VoyageEmbeddingClient;
  batchId: string;
  timeoutMs: number;
  deps: VoyageBatchDeps;
}): Promise<VoyageBatchStatus> {
  return await params.deps.withRemoteHttpResponse(
    buildVoyageBatchRequest({
      client: params.client,
      path: `batches/${params.batchId}`,
      timeoutMs: params.timeoutMs,
      onResponse: async (res) => {
        await assertVoyageResponseOk(res, "voyage batch status failed");
        return (await res.json()) as VoyageBatchStatus;
      },
    }),
  );
}

async function readVoyageBatchError(params: {
  client: VoyageEmbeddingClient;
  errorFileId: string;
  batchId: string;
  budget: EmbeddingBatchTimeoutBudget;
  deps: VoyageBatchDeps;
}): Promise<string | undefined> {
  try {
    return await params.deps.withRemoteHttpResponse(
      buildVoyageBatchRequest({
        client: params.client,
        path: `files/${params.errorFileId}/content`,
        timeoutMs: resolveVoyageBatchTimeoutMs(params.budget, params.batchId),
        onResponse: async (res) => {
          await assertVoyageResponseOk(res, "voyage batch error file content failed");
          const text = await res.text();
          if (!text.trim()) {
            return undefined;
          }
          const lines = text
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line) as VoyageBatchOutputLine);
          return extractBatchErrorMessage(lines);
        },
      }),
    );
  } catch (err) {
    return formatUnavailableBatchError(err);
  }
}

async function waitForVoyageBatch(params: {
  client: VoyageEmbeddingClient;
  batchId: string;
  wait: boolean;
  pollIntervalMs: number;
  budget: EmbeddingBatchTimeoutBudget;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: VoyageBatchStatus;
  deps: VoyageBatchDeps;
}): Promise<BatchCompletionResult> {
  let current: VoyageBatchStatus | undefined = params.initial;
  while (true) {
    const status =
      current ??
      (await fetchVoyageBatchStatus({
        client: params.client,
        batchId: params.batchId,
        timeoutMs: resolveVoyageBatchTimeoutMs(params.budget, params.batchId),
        deps: params.deps,
      }));
    const state = status.status ?? "unknown";
    if (state === "completed") {
      return resolveBatchCompletionFromStatus({
        provider: "voyage",
        batchId: params.batchId,
        status,
      });
    }
    await throwIfBatchTerminalFailure({
      provider: "voyage",
      status: { ...status, id: params.batchId },
      readError: async (errorFileId) =>
        await readVoyageBatchError({
          client: params.client,
          errorFileId,
          batchId: params.batchId,
          budget: params.budget,
          deps: params.deps,
        }),
    });
    if (!params.wait) {
      throw new Error(`voyage batch ${params.batchId} still ${state}; wait disabled`);
    }
    params.debug?.(`voyage batch ${params.batchId} ${state}; waiting ${params.pollIntervalMs}ms`);
    const sleepMs = resolveEmbeddingBatchPollSleepMs({
      budget: params.budget,
      pollIntervalMs: params.pollIntervalMs,
      timeoutMessage: voyageBatchTimeoutMessage(params.budget, params.batchId),
    });
    await params.deps.sleep(sleepMs);
    current = undefined;
  }
}

export async function runVoyageEmbeddingBatches(
  params: {
    client: VoyageEmbeddingClient;
    agentId: string;
    requests: VoyageBatchRequest[];
    deps?: Partial<VoyageBatchDeps>;
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  const deps = resolveVoyageBatchDeps(params.deps);
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: VOYAGE_BATCH_MAX_REQUESTS,
      debugLabel: "memory embeddings: voyage batch submit",
    }),
    runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
      const budget = createEmbeddingBatchTimeoutBudget({
        timeoutMs: params.timeoutMs,
        now: deps.now,
      });
      const batchInfo = await submitVoyageBatch({
        client: params.client,
        requests: group,
        agentId: params.agentId,
        timeoutMs: () => resolveVoyageBatchTimeoutMs(budget),
        deps,
      });
      if (!batchInfo.id) {
        throw new Error("voyage batch create failed: missing batch id");
      }
      const batchId = batchInfo.id;

      params.debug?.("memory embeddings: voyage batch created", {
        batchId: batchInfo.id,
        status: batchInfo.status,
        group: groupIndex + 1,
        groups,
        requests: group.length,
      });

      const completed = await resolveCompletedBatchResult({
        provider: "voyage",
        status: batchInfo,
        wait: params.wait,
        waitForBatch: async () =>
          await waitForVoyageBatch({
            client: params.client,
            batchId,
            wait: params.wait,
            pollIntervalMs: params.pollIntervalMs,
            budget,
            debug: params.debug,
            initial: batchInfo,
            deps,
          }),
      });

      const baseUrl = normalizeBatchBaseUrl(params.client);
      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));

      await deps.withRemoteHttpResponse({
        url: `${baseUrl}/files/${completed.outputFileId}/content`,
        ssrfPolicy: params.client.ssrfPolicy,
        timeoutMs: resolveVoyageBatchTimeoutMs(budget, batchId),
        init: {
          headers: buildBatchHeaders(params.client, { json: true }),
        },
        onResponse: async (contentRes) => {
          if (!contentRes.ok) {
            const text = await contentRes.text();
            throw new Error(`voyage batch file content failed: ${contentRes.status} ${text}`);
          }

          if (!contentRes.body) {
            return;
          }
          const reader = createInterface({
            input: Readable.fromWeb(
              contentRes.body as unknown as import("stream/web").ReadableStream,
            ),
            terminal: false,
          });

          for await (const rawLine of reader) {
            if (!rawLine.trim()) {
              continue;
            }
            const line = JSON.parse(rawLine) as VoyageBatchOutputLine;
            applyEmbeddingBatchOutputLine({ line, remaining, errors, byCustomId });
          }
        },
      });

      if (errors.length > 0) {
        throw new Error(`voyage batch ${batchInfo.id} failed: ${errors.join("; ")}`);
      }
      if (remaining.size > 0) {
        throw new Error(
          `voyage batch ${batchInfo.id} missing ${remaining.size} embedding responses`,
        );
      }
    },
  });
}
