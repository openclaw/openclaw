import { afterEach, describe, expect, it, vi } from "vitest";
import { runOpenAiEmbeddingBatches } from "./embedding-batch.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function inputUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function runBatch(params: {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  pollIntervalMs?: number;
  debug?: (message: string) => void;
}) {
  return runOpenAiEmbeddingBatches({
    openAi: {
      baseUrl: "https://openai-compatible.example/v1",
      headers: { Authorization: "Bearer test" },
      model: "text-embedding-3-small",
      fetchImpl: params.fetchImpl,
    },
    agentId: "main",
    requests: [
      {
        custom_id: "0",
        method: "POST",
        url: "/v1/embeddings",
        body: { model: "text-embedding-3-small", input: "payload" },
      },
    ],
    wait: true,
    concurrency: 1,
    pollIntervalMs: params.pollIntervalMs ?? 1,
    timeoutMs: params.timeoutMs,
    debug: params.debug,
  });
}

describe("OpenAI embedding batch operation deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not poll after the initial batch status consumes the operation deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let statusCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = inputUrl(input);
      if (url.endsWith("/files") && init?.method === "POST") {
        return jsonResponse({ id: "file-0" });
      }
      if (url.endsWith("/batches") && init?.method === "POST") {
        return jsonResponse({ id: "batch-0", status: "in_progress" });
      }
      if (url.endsWith("/batches/batch-0")) {
        statusCalls += 1;
        return jsonResponse({
          id: "batch-0",
          status: "completed",
          output_file_id: "output-0",
        });
      }
      return new Response(
        JSON.stringify({
          custom_id: "0",
          response: { status_code: 200, body: { data: [{ embedding: [1] }] } },
        }),
      );
    });
    const result = runBatch({
      fetchImpl,
      timeoutMs: 1_000,
      pollIntervalMs: 1_000,
      debug: (message) => {
        if (message.includes("batch-0 in_progress")) {
          vi.setSystemTime(1_000);
        }
      },
    });
    const outcome = result.then(
      () => ({ kind: "resolved" as const }),
      (error: Error) => ({ kind: "rejected" as const, error }),
    );

    await vi.runAllTimersAsync();

    await expect(outcome).resolves.toMatchObject({
      kind: "rejected",
      error: { message: "openai batch batch-0 timed out after 1000ms" },
    });
    expect(statusCalls).toBe(0);
  });

  it("aborts an in-flight batch status request when its operation deadline expires", async () => {
    let statusRequestAborted = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = inputUrl(input);
      if (url.endsWith("/files") && init?.method === "POST") {
        return jsonResponse({ id: "file-0" });
      }
      if (url.endsWith("/batches") && init?.method === "POST") {
        return jsonResponse({ id: "batch-0", status: "in_progress" });
      }
      if (url.endsWith("/batches/batch-0")) {
        return await new Promise<Response>((resolve, reject) => {
          const fallback = setTimeout(() => {
            resolve(
              jsonResponse({
                id: "batch-0",
                status: "completed",
                output_file_id: "output-0",
              }),
            );
          }, 100);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(fallback);
              statusRequestAborted = true;
              reject(init.signal?.reason ?? new Error("request aborted"));
            },
            { once: true },
          );
        });
      }
      return new Response(
        JSON.stringify({
          custom_id: "0",
          response: { status_code: 200, body: { data: [{ embedding: [1] }] } },
        }),
      );
    });

    await expect(runBatch({ fetchImpl, timeoutMs: 20 })).rejects.toThrow(/timed out|timeout/i);
    expect(statusRequestAborted).toBe(true);
  });
});
