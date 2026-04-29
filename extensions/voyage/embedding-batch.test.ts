import { describe, expect, it } from "vitest";
import { runVoyageEmbeddingBatches } from "./embedding-batch.js";
import type { VoyageEmbeddingClient } from "./embedding-provider.js";

type VoyageBatchDeps = NonNullable<Parameters<typeof runVoyageEmbeddingBatches>[0]["deps"]>;
type RemoteTimeoutParam = number | (() => number | undefined);

function resolveTimeoutArg(timeoutMs: RemoteTimeoutParam | undefined): number | undefined {
  return typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
}

describe("runVoyageEmbeddingBatches", () => {
  it("uses the remaining batch timeout budget for wait polling and streamed download", async () => {
    let now = 0;
    const timeouts: Array<[string, number | undefined]> = [];
    const sleeps: number[] = [];
    const client: VoyageEmbeddingClient = {
      baseUrl: "https://api.voyage.test/v1",
      headers: {},
      model: "voyage-3",
    };

    const uploadBatchJsonlFile: NonNullable<VoyageBatchDeps["uploadBatchJsonlFile"]> = async (
      params,
    ) => {
      timeouts.push(["upload", resolveTimeoutArg(params.timeoutMs)]);
      now = 500;
      return "file-1";
    };
    const postJsonWithRetry = (async <T>(params: { timeoutMs?: RemoteTimeoutParam }) => {
      timeouts.push(["create", resolveTimeoutArg(params.timeoutMs)]);
      now = 1000;
      return { id: "batch-1", status: "running" } as T;
    }) as NonNullable<VoyageBatchDeps["postJsonWithRetry"]>;
    const withRemoteHttpResponse = (async <T>(params: {
      url: string;
      timeoutMs?: number;
      onResponse: (response: Response) => Promise<T>;
    }) => {
      const url = params.url;
      if (url.endsWith("/batches/batch-1")) {
        timeouts.push(["status", params.timeoutMs]);
        now = 2500;
        return await params.onResponse(
          new Response(
            JSON.stringify({
              id: "batch-1",
              status: "completed",
              output_file_id: "out-1",
            }),
            { status: 200 },
          ),
        );
      }

      timeouts.push(["download", params.timeoutMs]);
      return await params.onResponse(
        new Response(
          `${JSON.stringify({
            custom_id: "req-1",
            response: { body: { data: [{ embedding: [3, 4] }] } },
          })}\n`,
          { status: 200 },
        ),
      );
    }) as NonNullable<VoyageBatchDeps["withRemoteHttpResponse"]>;

    const result = await runVoyageEmbeddingBatches({
      client,
      agentId: "agent-1",
      requests: [{ custom_id: "req-1", body: { input: "hello" } }],
      wait: true,
      pollIntervalMs: 0,
      timeoutMs: 5000,
      concurrency: 1,
      deps: {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        uploadBatchJsonlFile,
        postJsonWithRetry,
        withRemoteHttpResponse,
      },
    });

    expect(result.get("req-1")).toEqual([3, 4]);
    expect(sleeps).toEqual([0]);
    expect(timeouts).toEqual([
      ["upload", 5000],
      ["create", 4500],
      ["status", 4000],
      ["download", 2500],
    ]);
  });
});
