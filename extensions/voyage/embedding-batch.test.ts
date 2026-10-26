import assert from "node:assert/strict";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";
import { createStreamingResponse } from "../test-support/streaming-error-response.js";
import { runVoyageEmbeddingBatches } from "./embedding-batch.js";
import { voyageMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

type VoyageBatchOptions = Parameters<typeof runVoyageEmbeddingBatches>[0];
const batchResponses = {
  files: { id: "input-0" },
  batches: { id: "batch-0", status: "in_progress" },
  "batches/batch-0": { id: "batch-0", status: "completed", output_file_id: "output-0" },
  "files/output-0/content": {
    custom_id: "req-0",
    response: { status_code: 200, body: { data: [{ embedding: [1, 2] }] } },
  },
};

type BatchPath = keyof typeof batchResponses | "files/error-0/content";
function stubBatchFetch(overrides: Partial<Record<BatchPath, Response>> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(requestUrl(input)).pathname.replace(/^\/v1\//, "");
    assert(!["files", "batches"].includes(path) || init?.method === "POST");
    const response = Object.entries(overrides).find(([key]) => key === path)?.[1];
    const data = Object.entries(batchResponses).find(([key]) => key === path)?.[1];
    assert(response || data, `unexpected Voyage batch request: ${path}`);
    return response ?? Response.json(data);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function runBatch(overrides: Partial<VoyageBatchOptions> = {}) {
  return runVoyageEmbeddingBatches({
    client: {
      baseUrl: "https://api.voyageai.test/v1",
      headers: { authorization: "Bearer fixture-voyage" },
      model: "voyage-3",
    },
    agentId: "main",
    requests: [{ custom_id: "req-0", body: { input: "hello" } }],
    wait: true,
    pollIntervalMs: 1,
    timeoutMs: 60_000,
    concurrency: 1,
    ...overrides,
  });
}

async function serve(replies: Record<string, unknown>) {
  const received: [path: string, body: unknown][] = [];
  const server = createServer((request, response) => {
    void text(request)
      .then((body) => {
        const url = new URL(request.url ?? "", "http://localhost");
        assert.equal(url.search, `?${tenantQuery}`);
        assert.equal(request.headers.authorization, authorization);
        const path = url.pathname.replace(/^\/tenant\/v1\//, "");
        const json = request.headers["content-type"]?.includes("application/json");
        received.push([path, json && body ? JSON.parse(body) : undefined]);
        const result = replies[path];
        assert(result, `unexpected embedding endpoint: ${url.pathname}`);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(result));
      })
      .catch(() => response.destroy());
  });
  onTestFinished(() => server[Symbol.asyncDispose]());
  const port = await listenOnLoopback(server);
  return { baseUrl: `http://127.0.0.1:${port}/tenant/v1/?${tenantQuery}#local`, received };
}

const tenantQuery = "api-version=2024-10-21&tenant=beta";
const authorization = "Bearer voyage-loopback-key";
const completedWithError = { ...batchResponses["batches/batch-0"], error_file_id: "error-0" };
const batchError = {
  custom_id: "req-0",
  response: { status_code: 500, message: "provider rejected request" },
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["batches/batch-0", 200, /voyage-batch-status: JSON response exceeds \d+ bytes/],
  [
    "files/error-0/content",
    200,
    /voyage batch batch-0 completed: error file unavailable: voyage batch error file content exceeds \d+ bytes/,
  ],
  ["batches/batch-0", 500, { name: "ProviderHttpError", status: 500, statusCode: 500 }],
] as const)("bounds %s streams with HTTP %i", async (stage, status, error) => {
  const streamed = createStreamingResponse({
    status,
    chunkCount: 20,
    chunkSize: 1024 * 1024,
    headers: { "content-type": "application/json" },
  });
  stubBatchFetch({
    [stage]: streamed.response,
    ...(stage === "files/error-0/content" ? { batches: Response.json(completedWithError) } : {}),
  });
  const expected = error instanceof RegExp ? { message: expect.stringMatching(error) } : error;
  await expect(runBatch()).rejects.toMatchObject(expected);
  expect(streamed.getReadCount()).toBeLessThan(20);
  expect(streamed.wasCanceled()).toBe(true);
});

it("preserves real default requests, grouping, and configured query parameters", async () => {
  const vectors = [
    [7, 11],
    [13, 17],
  ];
  const { baseUrl, received } = await serve({
    embeddings: {
      data: vectors.map((embedding, index) => ({ index, embedding })),
    },
  });
  const { provider } = await voyageMemoryEmbeddingProviderAdapter.create({
    config: {},
    provider: "voyage",
    model: "voyage/voyage-3",
    fallback: "none",
    remote: { baseUrl, apiKey: "voyage-loopback-key" },
  });
  assert(provider, "expected configured Voyage embedding provider");
  expect(provider.maxInputTokens).toBe(32000);
  await expect(provider.embedBatch([{ text: "first" }, "second"])).resolves.toEqual(vectors);
  expect(received).toEqual([
    ["embeddings", { model: "voyage-3", input: ["first", "second"], input_type: "document" }],
  ]);
});

it.each(["output", "error"] as const)("preserves real batch %s requests", async (kind) => {
  const { baseUrl, received } = await serve({
    ...batchResponses,
    ...(kind === "error" ? { "batches/batch-0": completedWithError } : {}),
    "files/error-0/content": batchError,
  });
  const result = runBatch({
    client: {
      baseUrl,
      headers: { Authorization: authorization },
      model: "voyage-3",
      ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
    },
  });
  if (kind === "output") {
    await expect(result).resolves.toEqual(new Map([["req-0", [1, 2]]]));
  } else {
    await expect(result).rejects.toThrow(
      "voyage batch batch-0 completed: provider rejected request",
    );
  }

  const paths = ["files", "batches", "batches/batch-0", `files/${kind}-0/content`];
  expect(received.map(([path]) => path)).toEqual(paths);
  assert(received[1], "expected batch submission request");
  expect(received[1][1]).toMatchObject({
    endpoint: "/v1/embeddings",
    request_params: { model: "voyage-3", input_type: "document" },
  });
});

it("clamps polling and avoids status fetch after expiry", async ({ signal }) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const fetchMock = stubBatchFetch();
  const nowSpy = vi.spyOn(Date, "now");
  const polling = createDeferred<void>();
  const result = runBatch({
    pollIntervalMs: 2_000,
    timeoutMs: 1_000,
    debug: (message) => {
      if (message === "memory embeddings: voyage batch created") {
        nowSpy.mockReturnValueOnce(0).mockReturnValue(500);
      }
      if (message.startsWith("voyage batch batch-0 in_progress; waiting ")) {
        polling.resolve();
      }
    },
  });
  const rejection = expect(result).rejects.toThrow("voyage batch batch-0 timed out after 1000ms");
  const settled = Promise.allSettled([result, rejection]);
  try {
    // The polling owner logs immediately before arming its wait; submission may span I/O turns.
    await withinTest(
      awaitGateBeforeSettlement(polling.promise, result, "Voyage batch settled before polling"),
      signal,
    );
    nowSpy.mockReturnValue(1_000);
    await vi.advanceTimersByTimeAsync(500);
    await withinTest(rejection, signal);
    expect(fetchMock.mock.calls.some(([url]) => requestUrl(url).endsWith("/batches/batch-0"))).toBe(
      false,
    );
  } finally {
    nowSpy.mockReturnValue(1_000);
    try {
      await vi.runOnlyPendingTimersAsync();
    } finally {
      await settled;
    }
  }
});
