import { describe, expect, it } from "vitest";
import { runGeminiEmbeddingBatches } from "./embedding-batch.js";
import type { GeminiEmbeddingClient } from "./embedding-provider.js";

type GeminiBatchDeps = NonNullable<Parameters<typeof runGeminiEmbeddingBatches>[0]["deps"]>;

describe("runGeminiEmbeddingBatches", () => {
  it("uses the remaining batch timeout budget for wait polling and file download", async () => {
    let now = 0;
    const timeouts: Array<[string, number | undefined]> = [];
    const sleeps: number[] = [];
    const client: GeminiEmbeddingClient = {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      headers: {},
      model: "gemini-embedding-001",
      modelPath: "models/gemini-embedding-001",
      apiKeys: ["test-key"],
    };

    const withRemoteHttpResponse = (async <T>(params: {
      url: string;
      timeoutMs?: number;
      onResponse: (response: Response) => Promise<T>;
    }) => {
      const url = params.url;
      if (url.includes("/upload/")) {
        timeouts.push(["upload", params.timeoutMs]);
        now = 500;
        return await params.onResponse(
          new Response(JSON.stringify({ name: "files/input-1" }), { status: 200 }),
        );
      }
      if (url.includes(":asyncBatchEmbedContent")) {
        timeouts.push(["create", params.timeoutMs]);
        now = 1000;
        return await params.onResponse(
          new Response(JSON.stringify({ name: "batches/batch-1", state: "RUNNING" }), {
            status: 200,
          }),
        );
      }
      if (url.endsWith("/batches/batch-1")) {
        timeouts.push(["status", params.timeoutMs]);
        now = 2500;
        return await params.onResponse(
          new Response(
            JSON.stringify({
              name: "batches/batch-1",
              state: "SUCCEEDED",
              outputConfig: { file: "files/out-1" },
            }),
            { status: 200 },
          ),
        );
      }

      timeouts.push(["download", params.timeoutMs]);
      return await params.onResponse(
        new Response(
          `${JSON.stringify({
            key: "req-1",
            response: { embedding: { values: [1, 0] } },
          })}\n`,
          { status: 200 },
        ),
      );
    }) as NonNullable<GeminiBatchDeps["withRemoteHttpResponse"]>;

    const result = await runGeminiEmbeddingBatches({
      gemini: client,
      agentId: "agent-1",
      requests: [
        {
          custom_id: "req-1",
          request: {
            content: { parts: [{ text: "hello" }] },
            taskType: "RETRIEVAL_DOCUMENT",
          },
        },
      ],
      wait: true,
      pollIntervalMs: 0,
      timeoutMs: 5000,
      concurrency: 1,
      deps: {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        withRemoteHttpResponse,
      },
    });

    expect(result.get("req-1")).toEqual([1, 0]);
    expect(sleeps).toEqual([0]);
    expect(timeouts).toEqual([
      ["upload", 5000],
      ["create", 4500],
      ["status", 4000],
      ["download", 2500],
    ]);
  });
});
