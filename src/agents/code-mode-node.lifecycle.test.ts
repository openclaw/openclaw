import { channel } from "node:diagnostics_channel";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { CodeModeWorkerThreadResult } from "./code-mode-worker-types.js";

vi.mock("node:diagnostics_channel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:diagnostics_channel")>();
  const pressure = actual.channel(Symbol("code-mode-node-lifecycle"));
  return {
    ...actual,
    channel: (name: string | symbol) =>
      name === "openclaw.memory.critical" ? pressure : actual.channel(name),
  };
});

const fixture = vi.hoisted(() => ({
  workerUrl: "file:///runtime/code-mode-node.worker.js",
  completed: {
    status: "completed",
    value: { kind: "complete", json: "1" },
    output: { count: 0, source: { kind: "complete", json: "[]" } },
  } satisfies CodeModeWorkerThreadResult<undefined>,
  executions: [] as Array<{ input: unknown; options: { timeoutMs: number } }>,
  pools: [] as Array<{
    url: string;
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
    url: string;
    isClosed = false;
    run = vi.fn(
      async (
        makeInput: () => unknown,
        options: { timeoutMs: number },
      ): Promise<CodeModeWorkerThreadResult<undefined>> => {
        fixture.executions.push({ input: await makeInput(), options });
        return fixture.completed;
      },
    );
    close = vi.fn(async () => {
      this.isClosed = true;
    });
    constructor(options: { workerUrl: URL }) {
      this.url = options.workerUrl.href;
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
let host: LegacyPluginSdkResourceHost;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
const run = () => host.run(() => nodeCodeModeExecutor.execute(input, { timeoutMs: 1000 }));

beforeEach(() => {
  host = new LegacyPluginSdkResourceHost();
  scheduler = createTestGatewayScheduler("fake-timers");
  host.bindScheduler(scheduler);
});

afterEach(async () => {
  await host.close();
  await scheduler.stop();
});

describe("Node Code Mode worker custody", () => {
  it("joins its native workers at host close without retiring a sibling host", async () => {
    const sibling = new LegacyPluginSdkResourceHost();
    const siblingScheduler = createTestGatewayScheduler();
    sibling.bindScheduler(siblingScheduler);
    const released = createDeferred();
    const retiring = createDeferred();
    try {
      await run();
      const owned = fixture.pools.at(-1)!;
      await sibling.run(() => nodeCodeModeExecutor.execute(input, { timeoutMs: 1000 }));
      const survivor = fixture.pools.at(-1)!;
      expect(survivor).not.toBe(owned);
      owned.close.mockImplementationOnce(async () => {
        retiring.resolve();
        await released.promise;
        owned.isClosed = true;
      });
      const completed = vi.fn();
      const closing = host.close().then(completed);
      await retiring.promise;
      expect(completed).not.toHaveBeenCalled();
      expect(scheduler.nextWakeAtMs).toBeNull();
      expect(survivor.isClosed).toBe(false);
      released.resolve();
      await closing;
      const count = fixture.pools.length;
      await sibling.run(() => nodeCodeModeExecutor.execute(input, { timeoutMs: 1000 }));
      expect(fixture.pools).toHaveLength(count);
      expect(survivor.isClosed).toBe(false);
      await expect(run()).rejects.toThrow("Plugin SDK resource host is closed");
    } finally {
      released.resolve();
      await sibling.close();
      await siblingScheduler.stop();
    }
  });

  it("closes a standalone completed worker without retaining an unowned idle timer", async () => {
    await nodeCodeModeExecutor.execute(input, { timeoutMs: 1000 });
    expect(fixture.pools.at(-1)?.isClosed).toBe(true);
  });

  it("retains a failed host retirement for the next acquisition to join", async () => {
    const previous = new LegacyPluginSdkResourceHost();
    const previousScheduler = createTestGatewayScheduler();
    previous.bindScheduler(previousScheduler);
    await previous.run(() => nodeCodeModeExecutor.execute(input, { timeoutMs: 1000 }));
    const retired = fixture.pools.at(-1)!;
    retired.close.mockRejectedValueOnce(new Error("native exit uncertain"));
    await expect(previous.close()).rejects.toThrow(
      "Plugin SDK resources could not all be disposed",
    );
    expect(retired.isClosed).toBe(false);
    await run();
    expect(retired.close).toHaveBeenCalledTimes(2);
    expect(retired.isClosed).toBe(true);
    await previousScheduler.stop();
  });

  it("reuses idle workers within five minutes and expires each after inactivity", async () => {
    vi.useFakeTimers();
    try {
      await Promise.all([run(), run()]);
      const count = fixture.pools.length;
      const previous = fixture.pools.at(-1)!;
      const reused = fixture.pools.at(-2)!;
      await vi.advanceTimersByTimeAsync(70_000);
      expect(await run()).toMatchObject({ status: "completed" });
      expect(fixture.pools).toHaveLength(count);
      expect(previous.isClosed).toBe(false);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(previous.isClosed).toBe(true);
      expect(reused.isClosed).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reused.isClosed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the warm set and retires every idle pool on memory pressure", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, run));
    expect(results.every((result) => result.status === "completed")).toBe(true);
    const idle = fixture.pools.filter((pool) => !pool.isClosed);
    expect(idle).toHaveLength(4);
    channel("openclaw.memory.critical").publish({});
    expect(idle.every((pool) => pool.isClosed)).toBe(true);
    expect(channel("openclaw.memory.critical").hasSubscribers).toBe(false);
    const count = fixture.pools.length;
    expect(await run()).toMatchObject({ status: "completed" });
    expect(fixture.pools).toHaveLength(count + 1);
  });

  it.each(["abort", "timeout"] as const)(
    "ends acquisition on %s while native retirement still owns its worker",
    async (reason) => {
      vi.useFakeTimers();
      await run();
      const previous = fixture.pools.at(-1)!;
      const poolCount = fixture.pools.length;
      const executionCount = fixture.executions.length;
      const release = createDeferred();
      const retiring = createDeferred();
      previous.close.mockImplementationOnce(async () => {
        retiring.resolve();
        await release.promise;
        previous.isClosed = true;
      });
      fixture.workerUrl += ".updated";
      const controller = new AbortController();
      let observed: unknown;
      const execution = host
        .run(() =>
          nodeCodeModeExecutor.execute(input, { timeoutMs: 3000, signal: controller.signal }),
        )
        .then((result) => {
          observed = result;
          return result;
        });
      try {
        await retiring.promise;
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
        release.resolve();
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
        const result = await host.run(() =>
          nodeCodeModeExecutor.execute({ ...input, executionTimeoutMs: 300 }, { timeoutMs: 3000 }),
        );
        if (retirementMs < input.config.timeoutMs) {
          expect(result.status).toBe("completed");
          expect(fixture.executions.at(-1)).toMatchObject({
            input: { config: { timeoutMs: 750 }, executionTimeoutMs: 300 },
            options: { timeoutMs: 750 },
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

  it("retires all old runtime workers before executing against a new entry", async () => {
    await Promise.all([run(), run()]);
    const previous = fixture.pools.at(-1)!;
    const sibling = fixture.pools.at(-2)!;
    const previousExecutions = previous.run.mock.calls.length;
    const joined = createDeferred();
    const retiring = createDeferred();
    previous.close.mockImplementationOnce(async () => {
      retiring.resolve();
      await joined.promise;
      previous.isClosed = true;
    });
    fixture.workerUrl += ".updated";
    const poolCount = fixture.pools.length;
    const result = run();
    await retiring.promise;
    expect(fixture.pools).toHaveLength(poolCount);
    fixture.workerUrl += ".newer";
    joined.resolve();
    expect(await result).toMatchObject({ status: "completed" });
    expect(fixture.pools).toHaveLength(poolCount + 1);
    expect(previous.run).toHaveBeenCalledTimes(previousExecutions);
    expect(sibling.isClosed).toBe(true);
    expect(fixture.pools.at(-1)?.url).toBe(fixture.workerUrl);
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

  it("retires a completing worker when its runtime entry changed during execution", async () => {
    await run();
    const previous = fixture.pools.at(-1)!;
    previous.run.mockImplementationOnce(async () => {
      fixture.workerUrl += ".updated";
      return fixture.completed;
    });
    expect(await run()).toMatchObject({ status: "completed" });
    expect(previous.isClosed).toBe(true);
  });

  it("does not release an excess completed pool after native cleanup fails", async () => {
    await run();
    const first = fixture.pools.at(-1)!;
    const complete = createDeferred<CodeModeWorkerThreadResult<undefined>>();
    const starting = createDeferred();
    first.run.mockImplementationOnce(async () => {
      starting.resolve();
      return complete.promise;
    });
    const pending = run();
    await starting.promise;
    const siblings = await Promise.all(Array.from({ length: 4 }, run));
    expect(siblings.every((result) => result.status === "completed")).toBe(true);
    first.close.mockRejectedValueOnce(new Error("native exit uncertain"));
    complete.resolve(fixture.completed);
    expect(await pending).toMatchObject({ status: "failed", error: "native exit uncertain" });
    expect(first.close).toHaveBeenCalledTimes(2);
    expect(first.isClosed).toBe(true);
  });
});
