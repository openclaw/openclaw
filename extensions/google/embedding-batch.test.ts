import * as embeddingSdk from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGeminiEmbeddingBatches } from "./embedding-batch.js";
import type { GeminiEmbeddingClient } from "./embedding-provider.js";
import { geminiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

// Pass-through so onResponse receives real Response objects (required by
// readProviderJsonResponse which needs a real .body ReadableStream).
vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")>();
  return {
    ...actual,
    withRemoteHttpResponse: async <T>(params: {
      url: string;
      ssrfPolicy?: unknown;
      init?: RequestInit;
      onResponse: (response: Response) => Promise<T>;
    }): Promise<T> => {
      const response = await fetch(params.url, params.init);
      return await params.onResponse(response);
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function makeGeminiClient(
  baseUrl = "https://generativelanguage.googleapis.com/v1beta",
): GeminiEmbeddingClient {
  return {
    baseUrl,
    model: "gemini-embedding-001",
    modelPath: "models/gemini-embedding-001",
    headers: { "x-goog-api-client": "test-client" },
    apiKeys: ["test-key"],
    ssrfPolicy: undefined,
  };
}

type GeminiBatchRequest = Parameters<typeof runGeminiEmbeddingBatches>[0]["requests"][number];

function batchRequest(customId: string, text: string): GeminiBatchRequest {
  return {
    custom_id: customId,
    request: {
      model: "models/gemini-embedding-001",
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_DOCUMENT",
    },
  };
}

function singleRequest(): GeminiBatchRequest[] {
  return [batchRequest("r0", "hello")];
}

type BatchStage = "upload" | "create" | "status" | "download";

function batchStageForUrl(url: string): BatchStage {
  if (url.includes("/upload/")) {
    return "upload";
  }
  if (url.includes(":asyncBatchEmbedContent")) {
    return "create";
  }
  if (url.includes("/batches/")) {
    return "status";
  }
  if (url.includes(":download")) {
    return "download";
  }
  throw new Error(`unexpected Gemini batch URL: ${url}`);
}

function defaultBatchResponse(stage: BatchStage): Response {
  switch (stage) {
    case "upload":
      return Response.json({ file: { name: "files/f-ok" } });
    case "create":
      return Response.json({
        name: "batches/b-0",
        done: false,
        metadata: { state: "BATCH_STATE_PENDING" },
      });
    case "status":
      return Response.json({
        name: "batches/b-0",
        done: true,
        metadata: { state: "BATCH_STATE_SUCCEEDED" },
        response: { responsesFile: "files/out-0" },
      });
    case "download":
      return new Response(
        JSON.stringify({ key: "r0", response: { embedding: { values: [1, 0, 0] } } }),
        { status: 200 },
      );
  }
  throw new Error("unexpected Gemini batch stage");
}

function stubBatchFetch(
  override?: (stage: BatchStage, url: string, init?: RequestInit) => Response | undefined,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = fetchInputUrl(input);
    const stage = batchStageForUrl(url);
    return override?.(stage, url, init) ?? defaultBatchResponse(stage);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function runBatch(
  requests = singleRequest(),
  gemini = makeGeminiClient(),
): Promise<Map<string, number[]>> {
  return runGeminiEmbeddingBatches({
    gemini,
    agentId: "main",
    requests,
    wait: true,
    concurrency: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
  });
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function makeOversizedResponse(status = 200): {
  response: Response;
  getReadCount: () => number;
  wasCanceled: () => boolean;
} {
  const chunkSize = 1024 * 1024;
  const chunkCount = 20; // 20 MiB — over 16 MiB cap
  let readCount = 0;
  let canceled = false;
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (readCount >= chunkCount) {
            controller.close();
            return;
          }
          readCount += 1;
          controller.enqueue(new Uint8Array(chunkSize));
        },
        cancel() {
          canceled = true;
        },
      }),
      { status, headers: { "Content-Type": "application/json" } },
    ),
    getReadCount: () => readCount,
    wasCanceled: () => canceled,
  };
}

describe("Google embedding-batch bounded JSON reads", () => {
  it.each([
    { label: "missing", valuesJson: undefined, reason: "empty" },
    { label: "empty", valuesJson: "[]", reason: "empty" },
    { label: "string", valuesJson: '"bad"', reason: "invalid" },
    { label: "mixed coordinates", valuesJson: "[1,null]", reason: "invalid" },
    { label: "positive overflow", valuesJson: "[1,1e400]", reason: "invalid" },
  ])("rejects downloaded $label vectors before normalization", async ({ valuesJson, reason }) => {
    stubBatchFetch((stage) =>
      stage === "download"
        ? new Response(
            `{"key":"r0","response":{"embedding":{${valuesJson === undefined ? "" : `"values":${valuesJson}`}}}}\n` +
              '{"key":"r0","response":{"embedding":{"values":[1,0]}}}',
          )
        : undefined,
    );

    await expect(runBatch()).rejects.toThrow(`r0: ${reason} embedding`);
  });

  it("keeps the first accepted id ahead of duplicate malformed coordinates", async () => {
    // Leave another submitted id pending so the duplicate is actually parsed.
    const requests = [
      batchRequest("r0", "one"),
      batchRequest("r1", "two"),
      batchRequest("r2", "three"),
    ];
    stubBatchFetch((stage) =>
      stage === "download"
        ? new Response(
            [
              { key: "r0", response: { embedding: { values: [3, 4] } } },
              { key: "r0", response: { embedding: { values: [null] } } },
              { request_id: "r1", embedding: { values: [0, 1] } },
            ]
              .map((line) => JSON.stringify(line))
              .join("\n"),
          )
        : undefined,
    );
    await expect(runBatch(requests)).rejects.toThrow("missing 1 embedding responses");
  });

  it("rejects async batch embeddings that do not match the requested dimensions", async () => {
    stubBatchFetch();
    await expect(
      runBatch(singleRequest(), {
        ...makeGeminiClient(),
        model: "gemini-embedding-2",
        modelPath: "models/gemini-embedding-2",
        outputDimensionality: 768,
      }),
    ).rejects.toThrow("gemini embeddings failed: expected 768 dimensions, received 3");
  });

  it("stops before polling status after the batch timeout expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = stubBatchFetch();

    const result = runGeminiEmbeddingBatches({
      gemini: makeGeminiClient(),
      agentId: "main",
      requests: singleRequest(),
      wait: true,
      concurrency: 1,
      pollIntervalMs: 2_000,
      timeoutMs: 1_000,
      debug: (message) => {
        if (message.includes("batches/b-0 pending")) {
          vi.setSystemTime(1_000);
        }
      },
    });
    const rejection = captureRejection(result);

    await expect(rejection).resolves.toMatchObject({
      message: "gemini batch batches/b-0 timed out after 1000ms",
    });
    expect(
      fetchMock.mock.calls.filter(([input]) => fetchInputUrl(input).includes("/batches/")),
    ).toHaveLength(0);
  });

  it.each([{ stage: "status", label: "gemini.batch-status" }] as const)(
    "bounds oversized successful $stage JSON",
    async ({ stage, label }) => {
      const streamed = makeOversizedResponse();
      stubBatchFetch((candidate) => (candidate === stage ? streamed.response : undefined));

      const error = await captureRejection(runBatch());

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(label);
      expect(streamed.wasCanceled()).toBe(true);
      expect(streamed.getReadCount()).toBeLessThan(20);
    },
  );

  it("bounds oversized download errors", async () => {
    const streamed = makeOversizedResponse(503);
    stubBatchFetch((stage) => (stage === "download" ? streamed.response : undefined));

    const error = await captureRejection(runBatch());

    expect(error).toMatchObject({ name: "ProviderHttpError", status: 503, statusCode: 503 });
    expect((error as Error).message).toContain("gemini.batch-file-content");
    expect(streamed.wasCanceled()).toBe(true);
    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("marks create 404 as unavailable while preserving the structured cause", async () => {
    const response = Response.json(
      { error: { code: 404, message: "Input file was not found", status: "NOT_FOUND" } },
      { status: 404 },
    );
    stubBatchFetch((stage) => (stage === "create" ? response : undefined));

    const error = await captureRejection(runBatch());

    expect(error).toMatchObject({
      name: "EmbeddingBatchUnavailableError",
      code: "embedding_batch_unavailable",
    });
    expect((error as Error).message).toContain("asyncBatchEmbedContent not available");
    expect((error as Error).cause).toMatchObject({
      name: "ProviderHttpError",
      status: 404,
      code: "NOT_FOUND",
    });
    expect(((error as Error).cause as Error).message).toContain("Input file was not found");
    expect((error as Error).message).not.toContain("switch providers");
    expect(response.bodyUsed).toBe(true);
  });

  it.each([
    {
      baseUrl: "https://generativelanguage.googleapis.com/v1alpha/?tenant=remote",
      version: "v1alpha",
      query: "tenant=remote&",
    },
  ])("uses canonical Google file routes for $baseUrl", async ({ baseUrl, version, query }) => {
    const fetchMock = stubBatchFetch();

    const result = await runBatch(singleRequest(), makeGeminiClient(baseUrl));

    expect(result.get("r0")).toEqual([1, 0, 0]);
    expect(fetchMock.mock.calls.map(([input]) => fetchInputUrl(input))).toEqual([
      `https://generativelanguage.googleapis.com/upload/${version}/files?${query}uploadType=multipart`,
      `https://generativelanguage.googleapis.com/${version}/models/gemini-embedding-001:asyncBatchEmbedContent${query ? `?${query.slice(0, -1)}` : ""}`,
      `https://generativelanguage.googleapis.com/${version}/batches/b-0${query ? `?${query.slice(0, -1)}` : ""}`,
      `https://generativelanguage.googleapis.com/download/${version}/files/out-0:download?${query}alt=media`,
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-key");
    }
    const createCall = fetchMock.mock.calls.find(([input]) =>
      fetchInputUrl(input).includes(":asyncBatchEmbedContent"),
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      batch: { inputConfig: { file_name: "files/f-ok" } },
    });
  });

  it.each<{
    basePath: string;
    prefix: string;
    query: string;
  }>([
    { basePath: "/gateway/v1beta/", prefix: "/gateway", query: "?tenant=/openai/team/&route=a/" },
    { basePath: "/gateway/v1beta/openai", prefix: "/gateway", query: "" },
  ])(
    "runs the public adapter over HTTP for $basePath with query $query",
    async ({ basePath, prefix, query }) => {
      let createBody: unknown;
      let uploadBody = "";
      const observedUrls: string[] = [];
      const authHeaders: Array<string | undefined> = [];
      const tenantHeaders: Array<string | undefined> = [];
      const realSdk = await vi.importActual<typeof embeddingSdk>(
        "openclaw/plugin-sdk/memory-core-host-engine-embeddings",
      );
      const remoteHttp = vi
        .spyOn(embeddingSdk, "withRemoteHttpResponse")
        .mockImplementation(realSdk.withRemoteHttpResponse);
      try {
        await withServer(
          (request, response) => {
            void (async () => {
              const url = new URL(request.url ?? "/", "http://127.0.0.1");
              observedUrls.push(`${request.method} ${url.pathname}${url.search}`);
              const apiKey = request.headers["x-goog-api-key"];
              authHeaders.push(Array.isArray(apiKey) ? apiKey.join(", ") : apiKey);
              const tenant = request.headers["x-proof-tenant"];
              tenantHeaders.push(Array.isArray(tenant) ? tenant.join(", ") : tenant);
              for (const [name, value] of new URLSearchParams(query)) {
                if (url.searchParams.get(name) !== value) {
                  throw new Error("configured query changed");
                }
              }
              let body = "";
              request.setEncoding("utf8");
              for await (const chunk of request) {
                body += chunk;
              }
              const routes = {
                [`${prefix}/upload/v1beta/files`]: "upload",
                [`${prefix}/v1beta/models/gemini-embedding-001:asyncBatchEmbedContent`]: "create",
                [`${prefix}/v1beta/batches/b-0`]: "status",
                [`${prefix}/v1beta/files/out-0:download`]: "download",
              } satisfies Record<string, BatchStage>;
              if (url.pathname === `${prefix}/v1beta/models/gemini-embedding-001:embedContent`) {
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ embedding: { values: [1, 0, 0] } }));
                return;
              }
              const stage = routes[url.pathname];
              if (!stage) {
                throw new Error(`unexpected fixture route: ${url.pathname}`);
              }
              if (stage === "upload") {
                if (url.searchParams.get("uploadType") !== "multipart") {
                  throw new Error("missing uploadType");
                }
                uploadBody = body;
              }
              if (stage === "create") {
                createBody = JSON.parse(body);
              }
              if (stage === "download") {
                if (url.searchParams.get("alt") !== "media") {
                  throw new Error("missing alt=media");
                }
                response.setHeader("content-type", "application/jsonl");
                const line = '{"key":"0","response":{"embedding":{"values":[1,0,0]}}}';
                response.write(line.slice(0, 17));
                response.end(line.slice(17));
              } else {
                response.setHeader("content-type", "application/json");
                response.end(await defaultBatchResponse(stage).text());
              }
            })().catch((error: unknown) => {
              response.writeHead(500).end(String(error));
            });
          },
          async (baseUrl) => {
            const adapter = await geminiMemoryEmbeddingProviderAdapter.create({
              config: {},
              provider: "gemini",
              model: "gemini-embedding-001",
              fallback: "none",
              remote: {
                baseUrl: `${baseUrl}${basePath}${query}`,
                apiKey: "test-key",
                headers: { "X-Proof-Tenant": "remote" },
              },
            });
            if (!adapter.provider) {
              throw new Error("Expected a Gemini embedding provider");
            }
            await expect(adapter.provider.embed("hello", { inputType: "query" })).resolves.toEqual([
              1, 0, 0,
            ]);
            const result = adapter.runtime?.batchEmbed?.({
              agentId: "main",
              chunks: [{ text: "hello" }],
              wait: true,
              concurrency: 1,
              pollIntervalMs: 1,
              timeoutMs: 5_000,
              debug: () => {},
            });

            await expect(result).resolves.toEqual([[1, 0, 0]]);
            const uploadedRequest = uploadBody.split("\r\n\r\n")[2]?.split("\r\n")[0];
            expect(JSON.parse(uploadedRequest ?? "null")).toEqual({
              key: "0",
              request: {
                content: { parts: [{ text: "hello" }] },
                taskType: "RETRIEVAL_DOCUMENT",
                model: "models/gemini-embedding-001",
              },
            });
            expect(createBody).toMatchObject({
              batch: { inputConfig: { file_name: "files/f-ok" } },
            });
            expect(authHeaders).toEqual(Array(5).fill("test-key"));
            expect(tenantHeaders).toEqual(Array(5).fill("remote"));
            expect(observedUrls.map((value) => value.split("?")[0])).toEqual([
              `POST ${prefix}/v1beta/models/gemini-embedding-001:embedContent`,
              `POST ${prefix}/upload/v1beta/files`,
              `POST ${prefix}/v1beta/models/gemini-embedding-001:asyncBatchEmbedContent`,
              `GET ${prefix}/v1beta/batches/b-0`,
              `GET ${prefix}/v1beta/files/out-0:download`,
            ]);
          },
        );
      } finally {
        remoteHttp.mockRestore();
      }
    },
  );

  it("honors terminal LRO fields when metadata is stale", async () => {
    stubBatchFetch((stage) =>
      stage === "create"
        ? Response.json({
            name: "batches/b-0",
            done: true,
            metadata: { state: "BATCH_STATE_RUNNING" },
            response: { responsesFile: "files/out-0" },
          })
        : undefined,
    );

    await expect(runBatch()).resolves.toEqual(new Map([["r0", [1, 0, 0]]]));
  });

  it("keeps a terminal Operation error ahead of stale success metadata", async () => {
    stubBatchFetch((stage) =>
      stage === "create"
        ? Response.json({
            name: "batches/b-0",
            done: true,
            metadata: { state: "BATCH_STATE_SUCCEEDED" },
            response: { responsesFile: "files/out-0" },
            error: { code: 13, message: "provider job failed" },
          })
        : undefined,
    );

    await expect(runBatch()).rejects.toThrow("gemini batch batches/b-0 failed");
  });

  it("keeps shipped compatible-endpoint output aliases", async () => {
    const requests = [batchRequest("r0", "hello"), batchRequest("r1", "world")];
    stubBatchFetch((stage) =>
      stage === "download"
        ? new Response(
            [
              JSON.stringify({ custom_id: "r0", embedding: { values: [1, 0] } }),
              JSON.stringify({ request_id: "r1", embedding: { values: [0, 1] } }),
            ].join("\n"),
          )
        : undefined,
    );

    await expect(runBatch(requests)).resolves.toEqual(
      new Map([
        ["r0", [1, 0]],
        ["r1", [0, 1]],
      ]),
    );
  });

  it("falls back from an empty top-level output error", async () => {
    stubBatchFetch((stage) =>
      stage === "download"
        ? new Response(
            JSON.stringify({
              key: "r0",
              error: { message: "" },
              response: { error: { message: "nested output error" } },
            }),
          )
        : undefined,
    );

    await expect(runBatch()).rejects.toThrow("nested output error");
  });

  it.each([
    { state: "BATCH_STATE_FAILED", normalized: "failed" },
    { state: "JOB_STATE_CANCELLED", normalized: "cancelled" },
    { state: "BATCH_STATE_EXPIRED", normalized: "expired" },
  ])("surfaces $state Operation failures", async ({ state, normalized }) => {
    stubBatchFetch((stage) =>
      stage === "create"
        ? Response.json({
            name: "batches/b-0",
            done: true,
            metadata: { state },
          })
        : undefined,
    );

    await expect(runBatch()).rejects.toThrow(`gemini batch batches/b-0 ${normalized}`);
  });

  it("rejects conflicting output files in one Operation", async () => {
    stubBatchFetch((stage) =>
      stage === "create"
        ? Response.json({
            name: "batches/b-0",
            done: true,
            metadata: {
              state: "BATCH_STATE_SUCCEEDED",
              output: { responsesFile: "files/metadata-output" },
            },
            response: { responsesFile: "files/response-output" },
          })
        : undefined,
    );

    await expect(runBatch()).rejects.toThrow("conflicting output files");
  });
});
