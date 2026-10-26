import * as embeddingSdk from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../test-support/streaming-error-response.js";
import { runGeminiEmbeddingBatches } from "./embedding-batch.js";
import type { GeminiEmbeddingClient } from "./embedding-provider.js";
import { geminiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

// Bounded reads need real Response bodies, not mocked stream objects.
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
      return await params.onResponse(await fetch(params.url, params.init));
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fetchInputUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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

function jsonl(...lines: unknown[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join("\n"));
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

function operation(state: string, extra: Record<string, unknown> = {}) {
  return { name: "batches/b-0", done: true, metadata: { state }, ...extra };
}

function defaultBatchResponse(stage: BatchStage): Response {
  switch (stage) {
    case "upload":
      return Response.json({ file: { name: "files/f-ok" } });
    case "create":
      return Response.json(operation("BATCH_STATE_PENDING", { done: false }));
    case "status":
      return Response.json(operation("BATCH_STATE_SUCCEEDED", outputFile));
    case "download":
      return jsonl({ key: "r0", response: { embedding: { values: [1, 0, 0] } } });
  }
  throw new Error("Unexpected batch stage");
}

const outputFile = { response: { responsesFile: "files/out-0" } };
const batchOptions = {
  agentId: "main",
  wait: true,
  concurrency: 1,
  pollIntervalMs: 1,
  timeoutMs: 5_000,
};

function stubStage(stage?: BatchStage, response?: Response | Record<string, unknown>) {
  const override = response instanceof Response ? response : response && Response.json(response);
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const candidate = batchStageForUrl(fetchInputUrl(input));
    return candidate === stage && override ? override : defaultBatchResponse(candidate);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function runBatch(
  requests = [batchRequest("r0", "hello")],
  gemini = makeGeminiClient(),
  overrides: Partial<Parameters<typeof runGeminiEmbeddingBatches>[0]> = {},
): Promise<Map<string, number[]>> {
  return runGeminiEmbeddingBatches({
    ...batchOptions,
    gemini,
    requests,
    ...overrides,
  });
}

function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

describe("Google embedding-batch bounded JSON reads", () => {
  it.each([
    { label: "missing", valuesJson: undefined, reason: "empty" },
    { label: "empty", valuesJson: "[]", reason: "empty" },
    { label: "mixed coordinates", valuesJson: "[1,null]", reason: "invalid" },
    { label: "positive overflow", valuesJson: "[1,1e400]", reason: "invalid" },
  ])("rejects downloaded $label vectors before normalization", async ({ valuesJson, reason }) => {
    stubStage(
      "download",
      new Response(
        `{"key":"r0","response":{"embedding":{${valuesJson === undefined ? "" : `"values":${valuesJson}`}}}}\n` +
          '{"key":"r0","response":{"embedding":{"values":[1,0]}}}',
      ),
    );
    await expect(runBatch()).rejects.toThrow(`r0: ${reason} embedding`);
  });

  it("keeps the first accepted id ahead of duplicate malformed coordinates", async () => {
    // Leave another submitted id pending so the duplicate is actually parsed.
    const requests = ["r0", "r1", "r2"].map((id) => batchRequest(id, id));
    stubStage(
      "download",
      jsonl(
        { key: "r0", response: { embedding: { values: [3, 4] } } },
        { key: "r0", response: { embedding: { values: [null] } } },
        { request_id: "r1", embedding: { values: [0, 1] } },
      ),
    );
    await expect(runBatch(requests)).rejects.toThrow("missing 1 embedding responses");
  });

  it("rejects async batch embeddings that do not match the requested dimensions", async () => {
    stubStage();
    await expect(
      runBatch(undefined, {
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
    const fetchMock = stubStage();
    const result = runBatch(undefined, undefined, {
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

  it.each([
    { stage: "status", status: 200, label: "gemini.batch-status", fields: {} },
    {
      stage: "download",
      status: 503,
      label: "gemini.batch-file-content",
      fields: { name: "ProviderHttpError", status: 503, statusCode: 503 },
    },
  ] as const)("bounds oversized $stage responses", async ({ stage, status, label, fields }) => {
    const streamed = createStreamingResponse({
      status,
      chunkCount: 20,
      chunkSize: 1024 * 1024,
      byte: 0,
      headers: { "Content-Type": "application/json" },
    });
    stubStage(stage, streamed.response);
    const error = await captureRejection(runBatch());
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ ...fields, message: expect.stringContaining(label) });
    expect(streamed.wasCanceled()).toBe(true);
    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("marks create 404 as unavailable while preserving the structured cause", async () => {
    const response = Response.json(
      { error: { code: 404, message: "Input file was not found", status: "NOT_FOUND" } },
      { status: 404 },
    );
    stubStage("create", response);
    const error = await captureRejection(runBatch());
    expect(error).toMatchObject({
      name: "EmbeddingBatchUnavailableError",
      code: "embedding_batch_unavailable",
      message: expect.stringContaining("asyncBatchEmbedContent not available"),
      cause: {
        name: "ProviderHttpError",
        status: 404,
        code: "NOT_FOUND",
        message: expect.stringContaining("Input file was not found"),
      },
    });
    expect((error as Error).message).not.toContain("switch providers");
    expect(response.bodyUsed).toBe(true);
  });

  it("uses canonical Google file routes with a version and configured query", async () => {
    const origin = "https://generativelanguage.googleapis.com";
    const fetchMock = stubStage();
    const result = await runBatch(undefined, makeGeminiClient(`${origin}/v1alpha/?tenant=remote`));
    expect(result.get("r0")).toEqual([1, 0, 0]);
    expect(fetchMock.mock.calls.map(([input]) => fetchInputUrl(input))).toEqual([
      `${origin}/upload/v1alpha/files?tenant=remote&uploadType=multipart`,
      `${origin}/v1alpha/models/gemini-embedding-001:asyncBatchEmbedContent?tenant=remote`,
      `${origin}/v1alpha/batches/b-0?tenant=remote`,
      `${origin}/download/v1alpha/files/out-0:download?tenant=remote&alt=media`,
    ]);
  });

  it.each([
    { basePath: "/gateway/v1beta/", query: "?tenant=/openai/team/&route=a/" },
    { basePath: "/gateway/v1beta/openai", query: "" },
  ])(
    "runs the public adapter over HTTP for $basePath with query $query",
    async ({ basePath, query }) => {
      let createBody: unknown;
      let uploadBody = "";
      const observedUrls: string[] = [];
      const headers: unknown[] = [];
      const realSdk = await vi.importActual<typeof embeddingSdk>(
        "openclaw/plugin-sdk/memory-core-host-engine-embeddings",
      );
      vi.spyOn(embeddingSdk, "withRemoteHttpResponse").mockImplementation(
        realSdk.withRemoteHttpResponse,
      );
      await withServer(
        (request, response) => {
          void (async () => {
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            observedUrls.push(`${request.method} ${url.pathname}${url.search}`);
            headers.push([request.headers["x-goog-api-key"], request.headers["x-proof-tenant"]]);
            for (const [name, value] of new URLSearchParams(query)) {
              expect(url.searchParams.get(name)).toBe(value);
            }
            let body = "";
            request.setEncoding("utf8");
            for await (const chunk of request) {
              body += chunk;
            }
            if (url.pathname === "/gateway/v1beta/models/gemini-embedding-001:embedContent") {
              response.setHeader("content-type", "application/json");
              response.end(JSON.stringify({ embedding: { values: [1, 0, 0] } }));
              return;
            }
            const stage = batchStageForUrl(url.pathname);
            if (stage === "upload") {
              expect(url.searchParams.get("uploadType")).toBe("multipart");
              uploadBody = body;
            }
            if (stage === "create") {
              createBody = JSON.parse(body);
            }
            if (stage === "download") {
              expect(url.searchParams.get("alt")).toBe("media");
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
            ...batchOptions,
            chunks: [{ text: "hello" }],
            debug: () => {},
          });
          await expect(result).resolves.toEqual([[1, 0, 0]]);
          const uploadedRequest = uploadBody.split("\r\n\r\n")[2]?.split("\r\n")[0];
          expect(JSON.parse(uploadedRequest ?? "null")).toEqual({
            key: "0",
            request: batchRequest("0", "hello").request,
          });
          expect(createBody).toMatchObject({
            batch: { inputConfig: { file_name: "files/f-ok" } },
          });
          expect(headers).toEqual(Array.from({ length: 5 }, () => ["test-key", "remote"]));
          expect(observedUrls.map((value) => value.split("?")[0])).toEqual([
            "POST /gateway/v1beta/models/gemini-embedding-001:embedContent",
            "POST /gateway/upload/v1beta/files",
            "POST /gateway/v1beta/models/gemini-embedding-001:asyncBatchEmbedContent",
            "GET /gateway/v1beta/batches/b-0",
            "GET /gateway/v1beta/files/out-0:download",
          ]);
        },
      );
    },
  );

  it("honors terminal LRO fields when metadata is stale", async () => {
    stubStage("create", operation("BATCH_STATE_RUNNING", outputFile));
    await expect(runBatch()).resolves.toEqual(new Map([["r0", [1, 0, 0]]]));
  });

  it("keeps shipped compatible-endpoint output aliases", async () => {
    const requests = [batchRequest("r0", "hello"), batchRequest("r1", "world")];
    stubStage(
      "download",
      jsonl(
        { custom_id: "r0", embedding: { values: [1, 0] } },
        { request_id: "r1", embedding: { values: [0, 1] } },
      ),
    );
    await expect(runBatch(requests)).resolves.toEqual(
      new Map([
        ["r0", [1, 0]],
        ["r1", [0, 1]],
      ]),
    );
  });

  it("falls back from an empty top-level output error", async () => {
    stubStage(
      "download",
      jsonl({
        key: "r0",
        error: { message: "" },
        response: { error: { message: "nested output error" } },
      }),
    );
    await expect(runBatch()).rejects.toThrow("nested output error");
  });

  it.each([
    { state: "BATCH_STATE_FAILED", message: "gemini batch batches/b-0 failed" },
    { state: "JOB_STATE_CANCELLED", message: "gemini batch batches/b-0 cancelled" },
    { state: "BATCH_STATE_EXPIRED", message: "gemini batch batches/b-0 expired" },
    {
      state: "BATCH_STATE_SUCCEEDED",
      message: "gemini batch batches/b-0 failed",
      extra: { ...outputFile, error: { code: 13, message: "provider job failed" } },
    },
    {
      state: "BATCH_STATE_SUCCEEDED",
      message: "conflicting output files",
      extra: {
        metadata: {
          state: "BATCH_STATE_SUCCEEDED",
          output: { responsesFile: "files/metadata-output" },
        },
        response: { responsesFile: "files/response-output" },
      },
    },
  ])("rejects Operation $state: $message", async ({ state, message, extra }) => {
    stubStage("create", operation(state, extra));
    await expect(runBatch()).rejects.toThrow(message);
  });
});
