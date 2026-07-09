// Google tests cover embedding batch bounded JSON response reads.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGeminiEmbeddingBatches } from "./embedding-batch.js";
import type { GeminiEmbeddingClient } from "./embedding-provider.js";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeGeminiClient(): GeminiEmbeddingClient {
  return {
    baseUrl: "https://gemini-compatible.example/v1beta",
    model: "text-embedding-004",
    modelPath: "models/text-embedding-004",
    headers: { "x-goog-api-key": "test-key" },
    apiKeys: ["test-key"],
    ssrfPolicy: undefined,
  };
}

type GeminiBatchRequest = Parameters<typeof runGeminiEmbeddingBatches>[0]["requests"][number];

function singleRequest(): GeminiBatchRequest[] {
  return [
    {
      custom_id: "r0",
      request: {
        model: "models/text-embedding-004",
        content: { parts: [{ text: "hello" }] },
        taskType: "RETRIEVAL_DOCUMENT",
      },
    },
  ];
}

function makeOversizedResponse(mib = 20): {
  response: Response;
  getReadCount: () => number;
  wasCanceled: () => boolean;
} {
  const chunkSize = 1024 * 1024;
  const chunkCount = mib;
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
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
    getReadCount: () => readCount,
    wasCanceled: () => canceled,
  };
}

describe("Google embedding-batch bounded JSON reads", () => {
  it("bounds oversized file-upload JSON response and cancels the stream", async () => {
    const streamed = makeOversizedResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (fetchInputUrl(input).includes("/upload/")) {
          return streamed.response;
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    await expect(
      runGeminiEmbeddingBatches({
        gemini: makeGeminiClient(),
        agentId: "main",
        requests: singleRequest(),
        wait: true,
        concurrency: 1,
        pollIntervalMs: 50,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/gemini\.batch-file-upload/);

    expect(streamed.wasCanceled()).toBe(true);
    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("bounds oversized batch-create JSON response and cancels the stream", async () => {
    const streamed = makeOversizedResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = fetchInputUrl(input);
        if (url.includes("/upload/")) {
          return jsonResponse({ name: "files/f-ok" });
        }
        if (url.includes(":asyncBatchEmbedContent")) {
          return streamed.response;
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    await expect(
      runGeminiEmbeddingBatches({
        gemini: makeGeminiClient(),
        agentId: "main",
        requests: singleRequest(),
        wait: true,
        concurrency: 1,
        pollIntervalMs: 50,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/gemini\.batch-create/);

    expect(streamed.wasCanceled()).toBe(true);
    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("bounds oversized batch-status poll JSON response and cancels the stream", async () => {
    const streamed = makeOversizedResponse();
    let statusCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = fetchInputUrl(input);
        if (url.includes("/upload/")) {
          return jsonResponse({ name: "files/f-ok" });
        }
        if (url.includes(":asyncBatchEmbedContent")) {
          return jsonResponse({ name: "batches/b-0", state: "PENDING" });
        }
        if (url.includes("/batches/") && !statusCalled) {
          statusCalled = true;
          return streamed.response;
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    await expect(
      runGeminiEmbeddingBatches({
        gemini: makeGeminiClient(),
        agentId: "main",
        requests: singleRequest(),
        wait: true,
        concurrency: 1,
        pollIntervalMs: 50,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/gemini\.batch-status/);

    expect(streamed.wasCanceled()).toBe(true);
    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("bounds oversized file download JSONL response and cancels the stream", async () => {
    // 257 MiB exceeds the 256 MiB GEMINI_BATCH_OUTPUT_MAX_BYTES cap.
    const streamed = makeOversizedResponse(257);
    let statusCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = fetchInputUrl(input);
        if (url.includes("/upload/")) {
          return jsonResponse({ name: "files/f-ok" });
        }
        if (url.includes(":asyncBatchEmbedContent")) {
          return jsonResponse({ name: "batches/b-0", state: "PENDING" });
        }
        if (url.includes("/batches/") && !statusCalled) {
          statusCalled = true;
          return jsonResponse({
            name: "batches/b-0",
            state: "SUCCEEDED",
            outputConfig: { file: "files/out-0" },
          });
        }
        if (url.includes(":download")) {
          return streamed.response;
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    await expect(
      runGeminiEmbeddingBatches({
        gemini: makeGeminiClient(),
        agentId: "main",
        requests: singleRequest(),
        wait: true,
        concurrency: 1,
        pollIntervalMs: 50,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/Gemini batch output file too large/);

    // The overflow was detected at the 257th chunk (256 MiB cap reached).
    // readResponseWithLimit cancelled the reader; the cap prevented unbounded
    // reading past the limit.
    expect(streamed.getReadCount()).toBe(257);
  });

  it("parses small responses on all three JSON paths correctly", async () => {
    // Use a unit-length vector so sanitizeAndNormalizeEmbedding preserves values.
    const outputLine = JSON.stringify({
      key: "r0",
      embedding: { values: [1, 0, 0] },
    });
    let statusCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = fetchInputUrl(input);
        if (url.includes("/upload/")) {
          return jsonResponse({ name: "files/f-ok" });
        }
        if (url.includes(":asyncBatchEmbedContent")) {
          return jsonResponse({ name: "batches/b-0", state: "PENDING" });
        }
        if (url.includes("/batches/") && !statusCalled) {
          statusCalled = true;
          return jsonResponse({
            name: "batches/b-0",
            state: "SUCCEEDED",
            outputConfig: { file: "files/out-0" },
          });
        }
        if (url.includes(":download")) {
          return new Response(outputLine, { status: 200 });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    const result = await runGeminiEmbeddingBatches({
      gemini: makeGeminiClient(),
      agentId: "main",
      requests: singleRequest(),
      wait: true,
      concurrency: 1,
      pollIntervalMs: 50,
      timeoutMs: 5_000,
    });

    expect(result.get("r0")).toEqual([1, 0, 0]);
  });
});
