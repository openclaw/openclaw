import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createStreamingResponse } from "../test-support/streaming-error-response.js";
import { runVoyageEmbeddingBatches } from "./embedding-batch.js";
import { voyageMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

type VoyageBatchOptions = Parameters<typeof runVoyageEmbeddingBatches>[0];
type BatchStage = "upload" | "create" | "status" | "output" | "error";

function resolveBatchStage(url: string, init?: RequestInit): BatchStage {
  const routes = [
    ["upload", "/files", "POST"],
    ["create", "/batches", "POST"],
    ["status", "/batches/batch-0"],
    ["output", "/files/output-0/content"],
    ["error", "/files/error-0/content"],
  ] as const;
  const route = routes.find(
    ([, path, method]) => url.endsWith(path) && (!method || init?.method === method),
  );
  assert(route, `unexpected Voyage batch request: ${url}`);
  return route[0];
}

const batchResponses = {
  upload: { id: "input-0" },
  create: { id: "batch-0", status: "in_progress" },
  status: { id: "batch-0", status: "completed", output_file_id: "output-0" },
  output: {
    custom_id: "req-0",
    response: { status_code: 200, body: { data: [{ embedding: [1, 2] }] } },
  },
};

function fetchInputUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function stubBatchFetch(overrides: Partial<Record<BatchStage, Response>> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = fetchInputUrl(input);
    const stage = resolveBatchStage(url, init);
    const response = overrides[stage];
    const data = stage === "error" ? undefined : batchResponses[stage];
    assert(response || data, "unexpected Voyage batch stage");
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

type ReceivedRequest = { url: string; authorization: string | undefined; body?: unknown };

async function serve(replies: Record<string, unknown>) {
  const received: ReceivedRequest[] = [];
  const server = createServer((request, response) => {
    void text(request)
      .then((body) => {
        const entry = {
          url: request.url ?? "",
          authorization: request.headers.authorization,
          body:
            body && request.headers["content-type"]?.includes("application/json")
              ? JSON.parse(body)
              : undefined,
        };
        received.push(entry);
        const url = new URL(entry.url, "http://localhost");
        const result = url.search === `?${tenantQuery}` ? replies[url.pathname] : undefined;
        response.writeHead(result === undefined ? 404 : 200, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify(result ?? { error: "unexpected embedding endpoint" }));
      })
      .catch(() => response.destroy());
  });
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "expected loopback TCP address");
  return { baseUrl: `http://127.0.0.1:${address.port}/tenant/v1/?${tenantQuery}#local`, received };
}

const tenantQuery = "api-version=2024-10-21&tenant=beta";
const authorization = "Bearer voyage-loopback-key";
const completedWithError = { ...batchResponses.status, error_file_id: "error-0" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["status", 200, /voyage-batch-status: JSON response exceeds \d+ bytes/],
  [
    "error",
    200,
    /voyage batch batch-0 completed: error file unavailable: voyage batch error file content exceeds \d+ bytes/,
  ],
  ["status", 500, { name: "ProviderHttpError", status: 500, statusCode: 500 }],
] as const)("bounds %s streams with HTTP %i", async (stage, status, error) => {
  const streamed = createStreamingResponse({
    status,
    chunkCount: 20,
    chunkSize: 1024 * 1024,
    byte: 0,
    headers: { "content-type": "application/json" },
  });
  const fetchMock = stubBatchFetch({
    [stage]: streamed.response,
    ...(stage === "error" ? { create: Response.json(completedWithError) } : {}),
  });
  const result = expect(runBatch()).rejects;
  if (error instanceof RegExp) {
    await result.toThrow(error);
  } else {
    await result.toMatchObject(error);
  }
  expect(streamed.getReadCount()).toBeLessThan(20);
  expect(streamed.wasCanceled()).toBe(true);
  if (status === 500) {
    expect(
      fetchMock.mock.calls.filter(([input]) => fetchInputUrl(input).endsWith("/batches/batch-0")),
    ).toHaveLength(1);
  }
});

it("preserves real default requests, grouping, and configured query parameters", async () => {
  const vectors = [
    [7, 11],
    [13, 17],
  ];
  const { baseUrl, received } = await serve({
    "/tenant/v1/embeddings": {
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
  await expect(
    provider.embedBatch([{ text: "first" }, "second"], { inputType: undefined }),
  ).resolves.toEqual(vectors);
  expect(received).toEqual([
    {
      url: `/tenant/v1/embeddings?${tenantQuery}`,
      authorization,
      body: { model: "voyage-3", input: ["first", "second"], input_type: "document" },
    },
  ]);
  await expect(provider.embedBatch([], { inputType: undefined })).resolves.toEqual([]);
  expect(received).toHaveLength(1);
});

it("preserves configured query parameters through real batch upload, create, status, and error output", async () => {
  const { baseUrl, received } = await serve({
    "/tenant/v1/files": batchResponses.upload,
    "/tenant/v1/batches": batchResponses.create,
    "/tenant/v1/batches/batch-0": completedWithError,
    "/tenant/v1/files/error-0/content": {
      custom_id: "req-0",
      response: { status_code: 500, message: "provider rejected request" },
      error: null,
    },
  });
  await expect(
    runBatch({
      client: {
        baseUrl,
        headers: { Authorization: authorization },
        model: "voyage-3",
        ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
      },
    }),
  ).rejects.toThrow("voyage batch batch-0 completed: provider rejected request");

  expect(received.map(({ url, authorization: auth }) => ({ url, authorization: auth }))).toEqual(
    ["files", "batches", "batches/batch-0", "files/error-0/content"].map((path) => ({
      url: `/tenant/v1/${path}?${tenantQuery}`,
      authorization,
    })),
  );
});

it("clamps polling and avoids status fetch after expiry", async ({ signal }) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const fetchMock = stubBatchFetch();
  const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
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
    expect(timeoutSpy.mock.calls.some(([, ms]) => ms === 500)).toBe(true);
    nowSpy.mockReturnValue(1_000);
    await vi.advanceTimersByTimeAsync(500);
    await withinTest(rejection, signal);
    expect(
      fetchMock.mock.calls.some(([url]) => fetchInputUrl(url).endsWith("/batches/batch-0")),
    ).toBe(false);
  } finally {
    nowSpy.mockReturnValue(1_000);
    try {
      await vi.runOnlyPendingTimersAsync();
    } finally {
      await settled;
    }
  }
});

it("preserves authentication and batch request details on the real fetch boundary", async () => {
  const fetchMock = stubBatchFetch();

  await expect(runBatch()).resolves.toEqual(new Map([["req-0", [1, 2]]]));
  expect(fetchMock).toHaveBeenCalledTimes(4);
  for (const [, init] of fetchMock.mock.calls) {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-voyage");
  }
  const create = fetchMock.mock.calls.find(([url]) => fetchInputUrl(url).endsWith("/batches"));
  const requestBody = create?.[1]?.body;
  assert(typeof requestBody === "string", "missing Voyage batch creation body");
  expect(JSON.parse(requestBody)).toMatchObject({
    endpoint: "/v1/embeddings",
    request_params: { model: "voyage-3", input_type: "document" },
  });
  const status = fetchMock.mock.calls.find(([url]) =>
    fetchInputUrl(url).endsWith("/batches/batch-0"),
  );
  expect(status?.[1]?.signal).toBeInstanceOf(AbortSignal);
});
