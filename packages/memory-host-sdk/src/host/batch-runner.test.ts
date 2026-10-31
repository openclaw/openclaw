// Memory Host SDK tests cover batch runner behavior.
import { describe, expect, it, vi } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../../gateway-client/src/timeouts.js";
import {
  buildEmbeddingBatchGroupOptions,
  runEmbeddingBatchGroups,
  runEmbeddingBatches,
} from "./batch-runner.js";

const jsonlEncoder = new TextEncoder();

function jsonlLineBytes(value: unknown): number {
  return jsonlEncoder.encode(JSON.stringify(value)).byteLength;
}

describe("buildEmbeddingBatchGroupOptions", () => {
  it("clamps oversized embedding batch poll intervals to the timeout budget", () => {
    const options = buildEmbeddingBatchGroupOptions(
      {
        requests: ["request-1"],
        wait: true,
        pollIntervalMs: Number.MAX_SAFE_INTEGER,
        timeoutMs: 60_000,
        concurrency: 1,
      },
      {
        maxRequests: 100,
        debugLabel: "embedding batch submit",
      },
    );

    expect(options.pollIntervalMs).toBe(60_000);
  });

  it("passes clamped poll intervals into batch group runners", async () => {
    const runGroup = vi.fn(async () => {});

    await runEmbeddingBatchGroups({
      requests: ["request-1"],
      maxRequests: 100,
      wait: true,
      pollIntervalMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: 60_000,
      concurrency: 1,
      debugLabel: "embedding batch submit",
      runGroup,
    });

    expect(runGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        pollIntervalMs: 60_000,
        timeoutMs: 60_000,
      }),
    );
  });

  it("keeps timeout-safe oversized embedding batch poll intervals bounded", () => {
    const options = buildEmbeddingBatchGroupOptions(
      {
        requests: ["request-1"],
        wait: true,
        pollIntervalMs: Number.MAX_SAFE_INTEGER,
        timeoutMs: Number.MAX_SAFE_INTEGER,
        concurrency: 1,
      },
      {
        maxRequests: 100,
        debugLabel: "embedding batch submit",
      },
    );

    expect(options.pollIntervalMs).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });

  it("splits embedding batch groups by serialized JSONL bytes", async () => {
    const requests = [
      { id: "one", body: { input: "alpha" } },
      { id: "two", body: { input: "βeta" } },
      { id: "three", body: { input: "gamma" } },
    ];
    const maxJsonlBytes = jsonlLineBytes(requests[0]) + 1 + jsonlLineBytes(requests[1]);
    const groups: string[][] = [];

    await runEmbeddingBatchGroups({
      requests,
      maxRequests: 100,
      maxJsonlBytes,
      wait: true,
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
      concurrency: 1,
      debugLabel: "embedding batch submit",
      runGroup: async ({ group }) => {
        groups.push(group.map((request) => request.id));
      },
    });

    expect(groups).toEqual([["one", "two"], ["three"]]);
  });

  it("splits provider-rejected batch groups when the error is splittable", async () => {
    const uploadTooLarge = new Error("batch upload failed: 413 payload too large");
    const calls: string[][] = [];
    const onSplitGroup = vi.fn();

    await runEmbeddingBatchGroups({
      requests: ["one", "two", "three", "four"],
      maxRequests: 100,
      wait: true,
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
      concurrency: 1,
      debugLabel: "embedding batch submit",
      shouldSplitGroupOnError: (error) => error === uploadTooLarge,
      onSplitGroup,
      runGroup: async ({ group }) => {
        calls.push([...group]);
        if (group.length === 4) {
          throw uploadTooLarge;
        }
      },
    });

    expect(calls).toEqual([
      ["one", "two", "three", "four"],
      ["one", "two"],
      ["three", "four"],
    ]);
    expect(onSplitGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        error: uploadTooLarge,
        group: ["one", "two", "three", "four"],
        parts: [
          ["one", "two"],
          ["three", "four"],
        ],
        depth: 0,
      }),
    );
  });

  it("does not split a single rejected batch request", async () => {
    const uploadTooLarge = new Error("batch upload failed: 413 payload too large");

    await expect(
      runEmbeddingBatchGroups({
        requests: ["one"],
        maxRequests: 100,
        wait: true,
        pollIntervalMs: 1000,
        timeoutMs: 60_000,
        concurrency: 1,
        debugLabel: "embedding batch submit",
        shouldSplitGroupOnError: () => true,
        runGroup: async () => {
          throw uploadTooLarge;
        },
      }),
    ).rejects.toThrow(uploadTooLarge);
  });
});

describe("runEmbeddingBatches completion", () => {
  it.each([
    ["completed", false, "out", false, null],
    ["pending", true, "out", true, null],
    [
      "pending",
      false,
      "out",
      false,
      "openai batch b1 submitted; enable remote.batch.wait to await completion",
    ],
    ["completed", false, "", false, "openai batch b1 completed without output file"],
    ["pending", true, "", true, "openai batch b1 completed without output file"],
  ] as const)(
    "handles %s, wait=%s, output=%s",
    async (status, wait, outputFileId, waited, error) => {
      const batchStatus = {
        id: "b1",
        status,
        ...(status === "completed" ? { output_file_id: outputFileId } : {}),
      };
      const waitForBatch = vi.fn(async () => ({ outputFileId }));
      const readOutput = vi.fn(
        async (fileId: string, read: (response: Response) => Promise<void>) => {
          expect(fileId).toBe("out");
          await read(
            new Response(
              '{"custom_id":"0","response":{"status_code":200,"body":{"data":[{"embedding":[1,2]}]}}}\n',
            ),
          );
        },
      );
      const result = runEmbeddingBatches({
        provider: "openai",
        requests: [{ custom_id: "0" }],
        maxRequests: 100,
        wait,
        pollIntervalMs: 1000,
        timeoutMs: 60_000,
        concurrency: 1,
        debugLabel: "embedding batch submit",
        submit: async () => batchStatus,
        waitForBatch,
        readError: async () => undefined,
        readOutput,
      });
      if (error) {
        await expect(result).rejects.toThrow(error);
        expect(readOutput).not.toHaveBeenCalled();
      } else {
        expect(await result).toEqual(new Map([["0", [1, 2]]]));
      }
      if (waited) {
        expect(waitForBatch).toHaveBeenCalledExactlyOnceWith(batchStatus, 1000, 60_000);
      } else {
        expect(waitForBatch).not.toHaveBeenCalled();
      }
    },
  );
});
