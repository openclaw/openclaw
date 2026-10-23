import { createServer } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../test-support/streaming-error-response.js";
import { runOpenAiEmbeddingBatches } from "./embedding-batch.js";

const jsonlEncoder = new TextEncoder();
type BatchParams = Parameters<typeof runOpenAiEmbeddingBatches>[0];

function batchRequests(count: number, input = (index: number) => `payload-${index}`) {
  return Array.from({ length: count }, (_, index) => ({
    custom_id: String(index),
    method: "POST" as const,
    url: "/v1/embeddings" as const,
    body: { model: "text-embedding-3-small", input: input(index) },
  }));
}

function outputLine(customId: string, embedding: number[], padding?: string) {
  return {
    custom_id: customId,
    response: { status_code: 200, body: { data: [{ embedding }] } },
    ...(padding === undefined ? {} : { padding }),
  };
}

function trackedResponse(
  chunkCount: number,
  nextChunk: (index: number) => Uint8Array,
  contentType = "application/jsonl",
) {
  const state = { sent: 0, canceled: false };
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.sent >= chunkCount) {
          controller.close();
          return;
        }
        controller.enqueue(nextChunk(state.sent));
        state.sent += 1;
      },
      cancel() {
        state.canceled = true;
      },
    }),
    { status: 200, headers: { "Content-Type": contentType } },
  );
  return { response, state };
}

function batchFetch(options: { output?: Response; status?: () => Response }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = fetchInputUrl(input);
    if (url.endsWith("/files") && init?.method === "POST") {
      return Response.json({ id: "file-0" });
    }
    if (url.endsWith("/batches") && init?.method === "POST") {
      return Response.json(
        options.status
          ? { id: "batch-0", status: "in_progress" }
          : { id: "batch-0", status: "completed", output_file_id: "output-0" },
      );
    }
    if (url.endsWith("/batches/batch-0") && options.status) {
      return options.status();
    }
    if (url.endsWith("/files/output-0/content") && options.output) {
      return options.output;
    }
    return new Response("unexpected request", { status: 500 });
  });
}

function uploadFetch(
  onUpload: (jsonl: string, requests: Array<{ custom_id?: string }>) => Response | undefined,
) {
  const requestsByFileId = new Map<string, Array<{ custom_id?: string }>>();
  const outputByFileId = new Map<string, string>();
  let fileIndex = 0;
  let batchIndex = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = fetchInputUrl(input);
    if (url.endsWith("/files") && init?.method === "POST") {
      const file = (init.body as FormData).get("file");
      if (!(file instanceof Blob)) {
        throw new Error("missing batch upload file");
      }
      const jsonl = await file.text();
      const requests = jsonl.split("\n").map((line) => JSON.parse(line) as { custom_id?: string });
      const rejected = onUpload(jsonl, requests);
      if (rejected) {
        return rejected;
      }
      const id = `file-${fileIndex++}`;
      requestsByFileId.set(id, requests);
      return Response.json({ id });
    }
    if (url.endsWith("/batches") && init?.method === "POST") {
      const body = parseStringBody(init) as { input_file_id?: string };
      const id = `batch-${batchIndex}`;
      const output_file_id = `output-${batchIndex++}`;
      outputByFileId.set(
        output_file_id,
        (requestsByFileId.get(body.input_file_id ?? "") ?? [])
          .map(({ custom_id }) =>
            JSON.stringify(outputLine(custom_id ?? "", [Number(custom_id) + 1])),
          )
          .join("\n"),
      );
      return Response.json({ id, status: "completed", output_file_id });
    }
    const contentMatch = url.match(/\/files\/([^/]+)\/content$/);
    return contentMatch
      ? new Response(outputByFileId.get(contentMatch[1] ?? "") ?? "", { status: 200 })
      : new Response("unexpected request", { status: 500 });
  });
}

function singleRequestBatchParams(
  fetchImpl: typeof fetch,
  pollIntervalMs: number,
  timeoutMs: number,
): BatchParams {
  return {
    openAi: {
      baseUrl: "https://openai-compatible.example/v1",
      headers: { Authorization: "Bearer test" },
      model: "text-embedding-3-small",
      fetchImpl,
    },
    agentId: "main",
    requests: batchRequests(1, () => "payload"),
    wait: true,
    concurrency: 1,
    pollIntervalMs,
    timeoutMs,
  };
}

function jsonlBytes(value: string): number {
  return jsonlEncoder.encode(value).byteLength;
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function parseStringBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new Error("missing JSON request body");
  }
  return JSON.parse(init.body) as unknown;
}

async function listenLoopbackServer(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("OpenAI embedding batch output", () => {
  it.each(["/files", "/batches", "/files/output-0/content"])(
    "refreshes and retries only the rejected %s request",
    async (expiredPath) => {
      let bearer = "Bearer fixture-old";
      let rejected = false;
      const requests: Array<{ path: string; bearer: string | null }> = [];
      const resolveRequestHeaders = vi.fn(async ({ forceRefresh }: { forceRefresh: boolean }) => {
        if (forceRefresh) {
          bearer = "Bearer fixture-new";
        }
        return { Authorization: bearer };
      });
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(fetchInputUrl(input)).pathname.replace(/^\/v1/, "");
        requests.push({ path, bearer: new Headers(init?.headers).get("Authorization") });
        if (path === expiredPath && !rejected) {
          rejected = true;
          return Response.json({ error: { code: "token_expired" } }, { status: 401 });
        }
        if (path === "/files") {
          return Response.json({ id: "input-0" });
        }
        if (path === "/batches") {
          expect(parseStringBody(init)).toMatchObject({ input_file_id: "input-0" });
          return Response.json({ id: "batch-0", status: "completed", output_file_id: "output-0" });
        }
        return Response.json(outputLine("0", [3, 5]));
      });
      const params = singleRequestBatchParams(fetchImpl, 1, 10_000);
      params.openAi.resolveRequestHeaders = resolveRequestHeaders;
      await expect(runOpenAiEmbeddingBatches(params)).resolves.toEqual(new Map([["0", [3, 5]]]));
      const paths = ["/files", "/batches", "/files/output-0/content"];
      expect(requests.map((request) => request.path)).toEqual(
        paths.flatMap((path) => (path === expiredPath ? [path, path] : [path])),
      );
      const rejectedIndex = requests.findIndex((request) => request.path === expiredPath);
      expect(requests.map((request) => request.bearer)).toEqual(
        requests.map((_, index) =>
          index <= rejectedIndex ? "Bearer fixture-old" : "Bearer fixture-new",
        ),
      );
      expect(resolveRequestHeaders.mock.calls.filter(([call]) => call.forceRefresh)).toHaveLength(
        1,
      );
    },
  );

  it("preserves configured query parameters through real batch upload, create, status, and output", async () => {
    const received: Array<{ url: string; authorization: string | undefined }> = [];
    const server = createServer((request, response) => {
      const url = request.url ?? "";
      received.push({ url, authorization: request.headers.authorization });
      const parsed = new URL(url, "http://localhost");
      if (parsed.search !== "?api-version=2024-10-21&tenant=alpha") {
        response.writeHead(404).end("missing embedding tenant query");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (parsed.pathname === "/tenant/v1/files") {
        response.end(JSON.stringify({ id: "input-0" }));
      } else if (parsed.pathname === "/tenant/v1/batches") {
        response.end(JSON.stringify({ id: "batch-0", status: "in_progress" }));
      } else if (parsed.pathname === "/tenant/v1/batches/batch-0") {
        response.end(
          JSON.stringify({ id: "batch-0", status: "completed", output_file_id: "output-0" }),
        );
      } else if (parsed.pathname === "/tenant/v1/files/output-0/content") {
        response.end(JSON.stringify(outputLine("0", [3, 5])));
      } else {
        response.end(JSON.stringify({ error: "unexpected embedding path" }));
      }
    });
    const port = await listenLoopbackServer(server);

    try {
      const result = await runOpenAiEmbeddingBatches({
        ...singleRequestBatchParams(globalThis.fetch, 1, 10_000),
        openAi: {
          baseUrl: `http://127.0.0.1:${port}/tenant/v1/?api-version=2024-10-21&tenant=alpha#local`,
          headers: { Authorization: "Bearer openai-loopback-key" },
          model: "text-embedding-3-small",
          ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
        },
      });

      expect(result).toEqual(new Map([["0", [3, 5]]]));
      expect(received.map(({ url }) => url)).toEqual([
        "/tenant/v1/files?api-version=2024-10-21&tenant=alpha",
        "/tenant/v1/batches?api-version=2024-10-21&tenant=alpha",
        "/tenant/v1/batches/batch-0?api-version=2024-10-21&tenant=alpha",
        "/tenant/v1/files/output-0/content?api-version=2024-10-21&tenant=alpha",
      ]);
      expect(
        received.every(({ authorization }) => authorization === "Bearer openai-loopback-key"),
      ).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it.for([
    {
      name: "pending status",
      pollIntervalMs: 2_000,
      expectedWaits: [500],
      statusSequence: [],
      expectedStatusTimes: [],
      advanceClock: true,
      timeoutCause: undefined,
    },
    {
      name: "retry backoff",
      pollIntervalMs: 500,
      expectedWaits: [500, 500],
      statusSequence: ["retry"],
      expectedStatusTimes: [500],
      advanceClock: false,
      timeoutCause: 503,
    },
    {
      name: "combined pending and retry backoff",
      pollIntervalMs: 100,
      expectedWaits: [100, 200, 400, 300],
      statusSequence: ["pending", "retry", "pending"],
      expectedStatusTimes: [100, 300, 700],
      advanceClock: false,
      timeoutCause: undefined,
    },
  ])("clamps $name waits to the remaining batch timeout", async (scenario, { signal }) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    // The polling owner logs immediately before arming its sleep. Dispatcher
    // cleanup also owns 100ms timers, so delay values alone cannot identify polls.
    const pollTimeoutIndexes: number[] = [];
    const pollTimeoutCalls = () =>
      pollTimeoutIndexes.map((index) => setTimeoutSpy.mock.calls[index]);
    const polling = scenario.expectedWaits.map((waitMs) => ({
      waitMs,
      gate: createDeferred(),
    }));
    let statusCalls = 0;
    const statusTimes: number[] = [];
    const fetchImpl = batchFetch({
      status: () => {
        statusCalls += 1;
        statusTimes.push(Date.now());
        const nextStatus = scenario.statusSequence[statusCalls - 1];
        if (nextStatus === "pending") {
          return Response.json({ id: "batch-0", status: "in_progress" });
        }
        if (nextStatus === "retry") {
          return Response.json({ error: { message: "retry status" } }, { status: 503 });
        }
        return Response.json({ id: "batch-0", status: "completed", output_file_id: "output-0" });
      },
      output: new Response(JSON.stringify(outputLine("0", [1]))),
    });

    const result = runOpenAiEmbeddingBatches({
      ...singleRequestBatchParams(fetchImpl, scenario.pollIntervalMs, 1_000),
      debug: (message) => {
        if (scenario.advanceClock && message.includes("batch-0 in_progress")) {
          vi.setSystemTime(500);
        }
        if (message.startsWith("openai batch batch-0 ") && message.includes("; waiting ")) {
          pollTimeoutIndexes.push(setTimeoutSpy.mock.calls.length);
          polling[pollTimeoutIndexes.length - 1]?.gate.resolve();
        }
      },
    });
    const rejection = expect(result).rejects.toMatchObject({
      message: "openai batch batch-0 timed out after 1000ms",
      ...(scenario.timeoutCause ? { cause: { status: scenario.timeoutCause } } : {}),
    });

    const settled = Promise.allSettled([result, rejection]);
    try {
      for (const [index, { waitMs, gate }] of polling.entries()) {
        // Submission and response cleanup may span I/O turns before polling can arm a timer.
        await withinTest(
          awaitGateBeforeSettlement(gate.promise, result, "OpenAI batch settled before polling"),
          signal,
        );
        expect(pollTimeoutCalls()).toHaveLength(index + 1);
        expect(pollTimeoutCalls()[index]?.[1]).toBe(waitMs);
        await vi.advanceTimersByTimeAsync(waitMs);
      }
      await withinTest(rejection, signal);
      if (scenario.timeoutCause === undefined) {
        await expect(result).rejects.not.toHaveProperty("cause");
      }
      expect(statusCalls).toBe(scenario.expectedStatusTimes.length);
      expect(statusTimes).toEqual(scenario.expectedStatusTimes);
    } finally {
      vi.setSystemTime(1_000);
      try {
        await vi.runOnlyPendingTimersAsync();
      } finally {
        await settled;
      }
    }
  });

  it.each(["create", "status", "failed"] as const)(
    "reads a batch error file from %s before downloading successful output",
    async (completionStage) => {
      vi.useFakeTimers();
      let outputFetched = false;
      const terminal = {
        id: "batch-0",
        status: completionStage === "failed" ? "failed" : "completed",
        output_file_id: "output-0",
        error_file_id: "error-0",
      };
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = fetchInputUrl(input);
        if (url.endsWith("/files") && init?.method === "POST") {
          return Response.json({ id: "input-0" });
        }
        if (url.endsWith("/batches") && init?.method === "POST") {
          return Response.json(
            completionStage === "create" ? terminal : { id: "batch-0", status: "in_progress" },
          );
        }
        if (url.endsWith("/batches/batch-0")) {
          return Response.json(terminal);
        }
        if (url.endsWith("/files/error-0/content")) {
          return new Response(
            JSON.stringify({
              custom_id: "0",
              response: { status_code: 500, message: "provider rejected request" },
              error: null,
            }),
          );
        }
        if (url.endsWith("/files/output-0/content")) {
          outputFetched = true;
        }
        return new Response("unexpected request", { status: 500 });
      });

      const rejection = expect(
        runOpenAiEmbeddingBatches(singleRequestBatchParams(fetchImpl, 1, 1_000)),
      ).rejects.toThrow(`openai batch batch-0 ${terminal.status}: provider rejected request`);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(outputFetched).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(completionStage === "create" ? 3 : 4);
      expect(
        fetchImpl.mock.calls.filter(([input]) => fetchInputUrl(input).endsWith("/batches/batch-0")),
      ).toHaveLength(completionStage === "create" ? 0 : 1);
    },
  );

  it("splits provider uploads by serialized JSONL byte cap", async () => {
    const requests = batchRequests(3, (index) => `payload-${index}-${"β".repeat(8)}`);
    const uploadedJsonl: string[] = [];
    const maxJsonlBytes = jsonlBytes(JSON.stringify(requests[0]));
    const fetchImpl = uploadFetch((jsonl) => {
      uploadedJsonl.push(jsonl);
      return undefined;
    });

    const byCustomId = await runOpenAiEmbeddingBatches({
      ...singleRequestBatchParams(fetchImpl, 1000, 60_000),
      requests,
      maxJsonlBytes,
    });

    expect(uploadedJsonl).toHaveLength(3);
    expect(uploadedJsonl.every((jsonl) => jsonlBytes(jsonl) <= maxJsonlBytes)).toBe(true);
    expect([...byCustomId.entries()]).toEqual([
      ["0", [1]],
      ["1", [2]],
      ["2", [3]],
    ]);
  });

  it("adapts OpenAI-compatible upload groups after payload-size rejection", async () => {
    const requests = batchRequests(4);
    const uploadedGroups: string[][] = [];
    const debug = vi.fn();
    const fetchImpl = uploadFetch((_jsonl, uploadedRequests) => {
      uploadedGroups.push(uploadedRequests.map((request) => request.custom_id ?? ""));
      return uploadedRequests.length > 2
        ? Response.json(
            {
              error: {
                message: "Request body too large. Maximum allowed: 10 MB",
                type: "payload_too_large",
                code: "PAYLOAD_TOO_LARGE",
              },
            },
            { status: 413 },
          )
        : undefined;
    });

    const byCustomId = await runOpenAiEmbeddingBatches({
      ...singleRequestBatchParams(fetchImpl, 1000, 60_000),
      requests,
      debug,
    });

    expect(uploadedGroups).toEqual([
      ["0", "1", "2", "3"],
      ["0", "1"],
      ["2", "3"],
    ]);
    expect(debug).toHaveBeenCalledWith(
      "memory embeddings: openai batch upload too large; splitting group",
      expect.objectContaining({
        requests: 4,
        parts: [2, 2],
      }),
    );
    expect([...byCustomId.entries()]).toEqual([
      ["0", [1]],
      ["1", [2]],
      ["2", [3]],
      ["3", [4]],
    ]);
  });

  it("bounds batch status success body via readProviderJsonResponse", async () => {
    const chunkSize = 1024 * 1024;
    const chunkCount = 20; // 20 MiB, well over 16 MiB cap
    const oversizedStatus = trackedResponse(
      chunkCount,
      () => new Uint8Array(chunkSize),
      "application/json",
    );
    let batchStatusCalled = false;
    const fetchImpl = batchFetch({
      status: () => {
        if (batchStatusCalled) {
          return new Response("unexpected request", { status: 500 });
        }
        batchStatusCalled = true;
        return oversizedStatus.response;
      },
    });

    await expect(
      runOpenAiEmbeddingBatches(singleRequestBatchParams(fetchImpl, 1, 60_000)),
    ).rejects.toThrow(/openai\.batch-status/);
    expect(oversizedStatus.state.canceled).toBe(true);
    expect(oversizedStatus.state.sent).toBeLessThan(chunkCount);
  });

  it("streams valid batch output files larger than the provider text cap", async () => {
    const outputLineCount = 18;
    const padding = "x".repeat(1024 * 1024);
    const requests = batchRequests(outputLineCount);
    const output = trackedResponse(outputLineCount, (index) =>
      jsonlEncoder.encode(`${JSON.stringify(outputLine(String(index), [index + 1], padding))}\n`),
    );
    const fetchImpl = batchFetch({ output: output.response });

    const byCustomId = await runOpenAiEmbeddingBatches({
      ...singleRequestBatchParams(fetchImpl, 1000, 60_000),
      requests,
    });

    expect(output.state.sent).toBe(outputLineCount);
    expect([...byCustomId.entries()]).toEqual(
      requests.map((request, index) => [request.custom_id, [index + 1]]),
    );
  });

  it("stops reading batch output after all requested custom IDs are accounted for", async () => {
    const outputLineCount = 1024;
    const output = trackedResponse(outputLineCount, (index) => {
      const line = index === 0 ? outputLine("0", [1]) : outputLine(`extra-${index}`, [index]);
      return jsonlEncoder.encode(`${JSON.stringify(line)}\n`);
    });
    const fetchImpl = batchFetch({ output: output.response });

    const byCustomId = await runOpenAiEmbeddingBatches(
      singleRequestBatchParams(fetchImpl, 1_000, 60_000),
    );

    expect([...byCustomId.entries()]).toEqual([["0", [1]]]);
    expect(output.state.canceled).toBe(true);
    expect(output.state.sent).toBeLessThan(outputLineCount);
  });

  it("bounds batch output file content without buffering the whole response", async () => {
    const outputChunkCount = 1024;
    let outputChunksSent = 0;
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/v1/files") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "file-0" }));
        return;
      }
      if (url === "/v1/batches") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "batch-0", status: "completed", output_file_id: "output-0" }));
        return;
      }
      if (url === "/v1/files/output-0/content") {
        res.writeHead(200, { "Content-Type": "application/jsonl" });
        const chunkSize = 1024 * 1024;
        const writeNext = () => {
          if (outputChunksSent >= outputChunkCount) {
            res.end();
            return;
          }
          outputChunksSent += 1;
          if (res.write(Buffer.alloc(chunkSize))) {
            setImmediate(writeNext);
          } else {
            res.once("drain", writeNext);
          }
        };
        writeNext();
        return;
      }
      res.writeHead(500);
      res.end("unexpected request");
    });

    const port = await listenLoopbackServer(server);
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const originalUrl = new URL(fetchInputUrl(input));
      const loopbackUrl = new URL(
        `${originalUrl.pathname}${originalUrl.search}`,
        `http://127.0.0.1:${port}`,
      );
      return await realFetch(loopbackUrl, init);
    });

    try {
      await expect(
        runOpenAiEmbeddingBatches(singleRequestBatchParams(fetchImpl, 1_000, 60_000)),
      ).rejects.toThrow(/openai\.batch-file-content/);
    } finally {
      await closeServer(server);
    }
    expect(outputChunksSent).toBeLessThan(outputChunkCount);
  });

  it("retries normalized transient batch-status errors", async () => {
    let statusCalls = 0;
    const fetchImpl = batchFetch({
      status: () => {
        statusCalls += 1;
        return statusCalls === 1
          ? Response.json({ error: { message: "retry status" } }, { status: 503 })
          : Response.json({ id: "batch-0", status: "completed", output_file_id: "output-0" });
      },
      output: new Response(JSON.stringify(outputLine("0", [1]))),
    });

    const result = await runOpenAiEmbeddingBatches(singleRequestBatchParams(fetchImpl, 1, 1_000));

    expect(result).toEqual(new Map([["0", [1]]]));
    expect(statusCalls).toBe(2);
  });

  it("bounds batch resource error bodies without using response.text()", async () => {
    const tracked = cancelTrackedTextResponse(`${"batch status unavailable ".repeat(1024)}tail`, {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    let batchStatusReturned = false;
    const fetchImpl = batchFetch({
      status: () => {
        if (batchStatusReturned) {
          return new Response("unexpected request", { status: 500 });
        }
        batchStatusReturned = true;
        return tracked.response;
      },
    });

    await expect(
      runOpenAiEmbeddingBatches(singleRequestBatchParams(fetchImpl, 1, 60_000)),
    ).rejects.toMatchObject({ name: "ProviderHttpError", status: 400, statusCode: 400 });
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });
});
