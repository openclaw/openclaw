import { once } from "node:events";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runVoyageEmbeddingBatches } from "./embedding-batch.js";
import { createVoyageEmbeddingProvider } from "./embedding-provider.js";

type VoyageBatchOptions = Parameters<typeof runVoyageEmbeddingBatches>[0];
type BatchStage = "upload" | "create" | "status" | "output" | "error";

function resolveBatchStage(url: string, init?: RequestInit): BatchStage {
  if (url.endsWith("/files") && init?.method === "POST") {
    return "upload";
  }
  if (url.endsWith("/batches") && init?.method === "POST") {
    return "create";
  }
  if (url.endsWith("/batches/batch-0")) {
    return "status";
  }
  if (url.endsWith("/files/output-0/content")) {
    return "output";
  }
  if (url.endsWith("/files/error-0/content")) {
    return "error";
  }
  throw new Error(`unexpected Voyage batch request: ${url}`);
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

function stubBatchFetch(
  override?: (stage: BatchStage, url: string, init?: RequestInit) => Response | undefined,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = fetchInputUrl(input);
    const stage = resolveBatchStage(url, init);
    const response = override?.(stage, url, init);
    if (response) {
      return response;
    }
    if (stage === "error") {
      throw new Error("unexpected Voyage batch stage");
    }
    return Response.json(batchResponses[stage]);
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

async function withServer(
  reply: (request: ReceivedRequest) => unknown,
  run: (baseUrl: string, received: ReceivedRequest[]) => Promise<void>,
) {
  const received: ReceivedRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await text(request);
    const entry = {
      url: request.url ?? "",
      authorization: request.headers.authorization,
      ...(body && request.headers["content-type"]?.includes("application/json")
        ? { body: JSON.parse(body) }
        : {}),
    };
    received.push(entry);
    const result =
      new URL(entry.url, "http://localhost").search === `?${tenantQuery}`
        ? reply(entry)
        : undefined;
    response.writeHead(result === undefined ? 404 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result ?? { error: "unexpected embedding endpoint" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback TCP address");
    }
    await run(`http://127.0.0.1:${address.port}/tenant/v1/?${tenantQuery}#local`, received);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const tenantQuery = "api-version=2024-10-21&tenant=beta";
const authorization = "Bearer voyage-loopback-key";
const completedWithError = {
  ...batchResponses.status,
  error_file_id: "error-0",
};

async function expectBoundedStream(
  stage: "status" | "error",
  assertResult: (result: ReturnType<typeof runBatch>) => Promise<unknown>,
  status = 200,
) {
  let reads = 0;
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= 20) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      canceled = true;
    },
  });
  const response = new Response(stream, {
    status,
    headers: { "content-type": "application/json" },
  });
  const fetchMock = stubBatchFetch((current) => {
    if (current === stage) {
      return response;
    }
    if (stage === "error" && current === "create") {
      return Response.json(completedWithError);
    }
  });
  await assertResult(runBatch());
  expect(reads).toBeLessThan(20);
  expect(canceled).toBe(true);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("voyage batch bounded reads", () => {
  it("preserves real default requests, grouping, and configured query parameters", async () => {
    const vectors: Record<string, number[]> = { first: [7, 11], second: [13, 17] };
    await withServer(
      ({ url, body }) =>
        url === `/tenant/v1/embeddings?${tenantQuery}`
          ? {
              data: (body as { input: string[] }).input.map((input, index) => ({
                index,
                embedding: vectors[input],
              })),
            }
          : undefined,
      async (baseUrl, received) => {
        const { provider } = await createVoyageEmbeddingProvider({
          config: {},
          provider: "voyage",
          model: "voyage/voyage-3",
          fallback: "none",
          remote: { baseUrl, apiKey: "voyage-loopback-key" },
        });
        expect(provider.maxInputTokens).toBe(32000);
        await expect(
          provider.embedBatch([{ text: "first" }, "second"], { inputType: undefined }),
        ).resolves.toEqual([
          [7, 11],
          [13, 17],
        ]);
        expect(received).toEqual([
          {
            url: `/tenant/v1/embeddings?${tenantQuery}`,
            authorization,
            body: { model: "voyage-3", input: ["first", "second"], input_type: "document" },
          },
        ]);
        await expect(provider.embedBatch([], { inputType: undefined })).resolves.toEqual([]);
        expect(received).toHaveLength(1);
      },
    );
  });

  it("preserves configured query parameters through real batch upload, create, status, and error output", async () => {
    await withServer(
      ({ url }) => {
        const replies: Record<string, unknown> = {
          "/tenant/v1/files": batchResponses.upload,
          "/tenant/v1/batches": batchResponses.create,
          "/tenant/v1/batches/batch-0": completedWithError,
          "/tenant/v1/files/error-0/content": {
            custom_id: "req-0",
            response: { status_code: 500, message: "provider rejected request" },
            error: null,
          },
        };
        return (
          replies[new URL(url, "http://localhost").pathname] ?? {
            error: "unexpected embedding path",
          }
        );
      },
      async (baseUrl, received) => {
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

        expect(
          received.map(({ url, authorization: auth }) => ({ url, authorization: auth })),
        ).toEqual(
          ["files", "batches", "batches/batch-0", "files/error-0/content"].map((path) => ({
            url: `/tenant/v1/${path}?${tenantQuery}`,
            authorization,
          })),
        );
      },
    );
  });

  it("clamps polling to the remaining timeout and stops before fetching expired status", async ({
    signal,
  }) => {
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

  it("caps an oversized batch status stream through the public runner", async () => {
    await expectBoundedStream("status", (result) =>
      expect(result).rejects.toThrow(/voyage-batch-status: JSON response exceeds \d+ bytes/),
    );
  });

  it("fail-softs an oversized error file through the public runner", async () => {
    await expectBoundedStream("error", (result) =>
      expect(result).rejects.toThrow(
        /voyage batch batch-0 completed: error file unavailable: voyage batch error file content exceeds \d+ bytes/,
      ),
    );
  });

  it("normalizes and bounds a non-OK status diagnostic through the public runner", async () => {
    const fetchMock = await expectBoundedStream(
      "status",
      (result) =>
        expect(result).rejects.toMatchObject({
          name: "ProviderHttpError",
          status: 500,
          statusCode: 500,
        }),
      500,
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => fetchInputUrl(input).endsWith("/batches/batch-0")),
    ).toHaveLength(1);
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
    if (typeof requestBody !== "string") {
      throw new Error("missing Voyage batch creation body");
    }
    expect(JSON.parse(requestBody)).toMatchObject({
      endpoint: "/v1/embeddings",
      request_params: { model: "voyage-3", input_type: "document" },
    });
    const status = fetchMock.mock.calls.find(([url]) =>
      fetchInputUrl(url).endsWith("/batches/batch-0"),
    );
    expect(status?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
