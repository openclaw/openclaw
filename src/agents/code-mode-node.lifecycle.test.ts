import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CodeModeWorkerThreadResult } from "./code-mode-worker-types.js";

const fixture = vi.hoisted(() => ({
  workerUrl: "file:///runtime/code-mode-node.worker.js",
  executions: [] as Array<{ input: unknown; options: { timeoutMs: number } }>,
  pools: [] as Array<{
    isClosed: boolean;
    run: Mock<
      (
        makeInput: () => unknown,
        options: { timeoutMs: number },
      ) => Promise<CodeModeWorkerThreadResult<undefined>>
    >;
    close: Mock<() => Promise<void>>;
  }>,
}));
vi.mock("../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL(fixture.workerUrl),
}));
vi.mock("../infra/worker-task-pool.js", () => ({
  WorkerTaskError: class extends Error {},
  WorkerTaskPool: class {
    isClosed = false;
    run = vi.fn(
      async (
        makeInput: () => unknown,
        options: { timeoutMs: number },
      ): Promise<CodeModeWorkerThreadResult<undefined>> => {
        fixture.executions.push({ input: await makeInput(), options });
        return {
          status: "completed",
          value: { kind: "complete", json: "1" },
          output: { count: 0, source: { kind: "complete", json: "[]" } },
        };
      },
    );
    close = vi.fn(async () => {
      this.isClosed = true;
    });
    constructor() {
      fixture.pools.push(this);
    }
  },
}));

import { nodeCodeModeExecutor } from "./code-mode-node.js";

const input = {
  kind: "exec" as const,
  source: "return 1;",
  catalog: [],
  namespaces: [],
  config: {
    timeoutMs: 1000,
    memoryLimitBytes: 64 * 1024 * 1024,
    maxOutputBytes: 1024,
    maxPendingToolCalls: 16,
    maxSnapshotBytes: 1024,
  },
};
const run = () => nodeCodeModeExecutor.execute(input, { timeoutMs: 1000 });

afterEach(async () => {
  fixture.workerUrl += ".next";
  await run();
});

describe("Node Code Mode worker custody", () => {
  it.each(["abort", "timeout"] as const)(
    "ends acquisition on %s while native retirement still owns its worker",
    async (reason) => {
      vi.useFakeTimers();
      await run();
      const previous = fixture.pools.at(-1)!;
      const poolCount = fixture.pools.length;
      const executionCount = fixture.executions.length;
      let release!: () => void;
      let retirementStarted!: () => void;
      const retiring = new Promise<void>((resolve) => {
        retirementStarted = resolve;
      });
      previous.close.mockImplementationOnce(async () => {
        retirementStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        previous.isClosed = true;
      });
      fixture.workerUrl += ".updated";
      const controller = new AbortController();
      let observed: unknown;
      const execution = nodeCodeModeExecutor
        .execute(input, { timeoutMs: 3000, signal: controller.signal })
        .then((result) => {
          observed = result;
          return result;
        });
      try {
        await retiring;
        if (reason === "abort") {
          controller.abort();
        }
        await vi.advanceTimersByTimeAsync(reason === "timeout" ? 1000 : 0);
        expect(observed).toMatchObject({
          status: "failed",
          code: reason === "timeout" ? "timeout" : "aborted",
        });
        expect(previous.isClosed).toBe(false);
        expect(fixture.pools).toHaveLength(poolCount);
        expect(fixture.executions).toHaveLength(executionCount);
      } finally {
        release();
        await execution;
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }
      expect(previous.isClosed).toBe(true);
      expect(fixture.pools).toHaveLength(poolCount);
    },
  );

  it("retries failed continuation cleanup without restoring resume authority", async () => {
    await run();
    const pool = fixture.pools.at(-1)!;
    pool.run.mockResolvedValueOnce({
      status: "waiting",
      continuation: undefined,
      pendingRequests: [{ id: "bridge:yield:1", method: "yield", args: [] }],
      canceledRequestIds: [],
      settlementMode: { kind: "awaiting" },
      output: { count: 0, source: { kind: "complete", json: "[]" } },
    });
    const result = await run();
    if (result.status !== "waiting") {
      throw new Error("Expected a live continuation");
    }
    pool.close.mockRejectedValueOnce(new Error("native exit uncertain"));
    await expect(result.continuation.dispose()).rejects.toThrow("native exit uncertain");
    expect(
      await result.continuation.resume(
        { kind: "resume", config: input.config, settledRequests: [] },
        { timeoutMs: 1000 },
      ),
    ).toMatchObject({ status: "failed", code: "runtime_unavailable" });
    await result.continuation.dispose();
    expect(pool.close).toHaveBeenCalledTimes(2);
    expect(pool.isClosed).toBe(true);
  });

  it.each([250, 1500])(
    "charges %d ms of native retirement to the deadline without shortening the separate CPU allowance",
    async (retirementMs) => {
      await run();
      const previous = fixture.pools.at(-1)!;
      const executionCount = fixture.executions.length;
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      try {
        previous.close.mockImplementationOnce(async () => {
          clock.mockReturnValue(retirementMs);
          previous.isClosed = true;
        });
        fixture.workerUrl += ".updated";
        const result = await nodeCodeModeExecutor.execute(
          { ...input, executionTimeoutMs: 300 },
          { timeoutMs: 3000 },
        );
        if (retirementMs < input.config.timeoutMs) {
          expect(result.status).toBe("completed");
          expect(fixture.executions.at(-1)).toMatchObject({
            input: { config: { timeoutMs: 750 }, executionTimeoutMs: 300 },
            options: { timeoutMs: 2750 },
          });
        } else {
          expect(result).toMatchObject({ status: "failed", code: "timeout" });
          expect(fixture.executions).toHaveLength(executionCount);
          expect(fixture.pools.at(-1)?.isClosed).toBe(true);
        }
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("retires the old runtime worker before executing against a new entry", async () => {
    await run();
    const previous = fixture.pools.at(-1)!;
    const previousExecutions = previous.run.mock.calls.length;
    let joined!: () => void;
    let retirementStarted!: () => void;
    const retiring = new Promise<void>((resolve) => {
      retirementStarted = resolve;
    });
    previous.close.mockImplementationOnce(async () => {
      retirementStarted();
      await new Promise<void>((resolve) => {
        joined = resolve;
      });
      previous.isClosed = true;
    });
    fixture.workerUrl += ".updated";
    const poolCount = fixture.pools.length;
    const result = run();
    await retiring;
    expect(fixture.pools).toHaveLength(poolCount);
    joined();
    expect(await result).toMatchObject({ status: "completed" });
    expect(fixture.pools).toHaveLength(poolCount + 1);
    expect(previous.run).toHaveBeenCalledTimes(previousExecutions);
  });

  it("retains failed idle retirement and joins its native retry before allocating a successor", async () => {
    await run();
    const previous = fixture.pools.at(-1)!;
    const count = fixture.pools.length;
    previous.close.mockRejectedValueOnce(new Error("native exit uncertain"));
    fixture.workerUrl += ".updated";
    await expect(run()).rejects.toThrow("native exit uncertain");
    expect(fixture.pools).toHaveLength(count);
    expect(await run()).toMatchObject({ status: "completed" });
    expect(previous.close).toHaveBeenCalledTimes(2);
    expect(fixture.pools).toHaveLength(count + 1);
  });

  it("does not release a completed pool after an idle-cache collision fails native cleanup", async () => {
    await run();
    const first = fixture.pools.at(-1)!;
    let complete!: (value: CodeModeWorkerThreadResult<undefined>) => void;
    let started!: () => void;
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    first.run.mockImplementationOnce(async () => {
      started();
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const pending = run();
    await starting;
    expect(await run()).toMatchObject({ status: "completed" });
    first.close.mockRejectedValueOnce(new Error("native exit uncertain"));
    complete({
      status: "completed",
      value: { kind: "complete", json: "1" },
      output: { count: 0, source: { kind: "complete", json: "[]" } },
    });
    expect(await pending).toMatchObject({ status: "failed", error: "native exit uncertain" });
    expect(first.close).toHaveBeenCalledTimes(2);
    expect(first.isClosed).toBe(true);
  });
});
