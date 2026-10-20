import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { prepareCodeModeNodeCatalog } from "./code-mode-node-input.js";
import type { CodeModeNodeInput, CodeModeWorkerThreadResult } from "./code-mode-worker-types.js";

vi.mock("node:diagnostics_channel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:diagnostics_channel")>();
  const pressure = actual.channel(Symbol("code-mode-node-lifecycle"));
  return {
    ...actual,
    channel: (name: string | symbol) =>
      name === "openclaw.memory.critical" ? pressure : actual.channel(name),
  };
});

const fixture = vi.hoisted(() => {
  class WorkerTaskPool {
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
  }
  return {
    WorkerTaskPool,
    workerUrl: "file:///runtime/code-mode-node.worker.js",
    completed: {
      status: "completed",
      value: { kind: "complete", json: "1" },
      output: { count: 0, source: { kind: "complete", json: "[]" } },
    } satisfies CodeModeWorkerThreadResult<undefined>,
    executions: [] as Array<{ input: unknown; options: { timeoutMs: number } }>,
    pools: [] as WorkerTaskPool[],
  };
});
vi.mock("../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL(fixture.workerUrl),
}));
// mock-isolation: Control worker execution and retirement without starting real worker threads.
vi.mock("../infra/worker-task-pool.js", () => ({
  WorkerTaskError: class extends Error {},
  WorkerTaskPool: fixture.WorkerTaskPool,
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
let stormTime = 0;
const assignedWorkerId = () =>
  (fixture.executions.at(-1)!.input as CodeModeNodeInput).gcAttribution!.workerId;

function holdRetirement(pool: (typeof fixture.pools)[number]) {
  const release = createDeferred();
  const retiring = createDeferred();
  pool.close.mockImplementationOnce(async () => {
    retiring.resolve();
    await release.promise;
    pool.isClosed = true;
  });
  return { release: release.resolve, retiring: retiring.promise };
}

function holdRun(pool: (typeof fixture.pools)[number]) {
  const started = createDeferred();
  const result = createDeferred<CodeModeWorkerThreadResult<undefined>>();
  pool.run.mockImplementationOnce(async () => {
    started.resolve();
    return result.promise;
  });
  return { started: started.promise, complete: result.resolve };
}

function parkedResult(): CodeModeWorkerThreadResult<undefined> {
  return {
    status: "waiting",
    continuation: undefined,
    pendingRequests: [{ id: "bridge:yield:1", method: "yield", args: [] }],
    canceledRequestIds: [],
    settlementMode: { kind: "awaiting" },
    output: fixture.completed.output,
  };
}

beforeEach(() => {
  host = new LegacyPluginSdkResourceHost();
  scheduler = createTestGatewayScheduler("fake-timers");
  host.bindScheduler(scheduler);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await host.close();
  await scheduler.stop();
});

it("retires a storming warm worker, bounds retirement admission, and replaces it on demand", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue((stormTime += 60_000));
  const storm = channel("openclaw.code-mode.gc-storm");
  await run();
  const retired = fixture.pools.at(-1)!;
  const workerId = assignedWorkerId();
  const count = fixture.pools.length;
  storm.publish(workerId);
  expect(retired.close).toHaveBeenCalledWith(undefined, "gc-storm");
  expect(fixture.pools).toHaveLength(count);
  expect(await run()).toMatchObject({ status: "completed" });
  const replacement = fixture.pools.at(-1)!;
  expect(replacement).not.toBe(retired);
  const replacementId = assignedWorkerId();
  storm.publish(replacementId);
  expect(replacement.close).not.toHaveBeenCalled();
  clock.mockReturnValue((stormTime += 60_000));
  storm.publish(workerId);
  expect(replacement.close).not.toHaveBeenCalled();
  storm.publish(replacementId);
  expect(replacement.close).toHaveBeenCalledWith(undefined, "gc-storm");
  expect(storm.hasSubscribers).toBe(false);
});

it.each(["complete", "expire"] as const)(
  "drains a storming worker without dropping its active or parked cell until %s",
  async (settlement) => {
    vi.spyOn(performance, "now").mockReturnValue((stormTime += 60_000));
    await run();
    const pool = fixture.pools.at(-1)!;
    const workerId = assignedWorkerId();
    const held = holdRun(pool);
    const active = run();
    await held.started;
    channel("openclaw.code-mode.gc-storm").publish(workerId);
    expect(pool.close).not.toHaveBeenCalled();
    held.complete(parkedResult());
    const result = await active;
    assert(result.status === "waiting", "Expected a live continuation");
    expect(pool.close).not.toHaveBeenCalled();
    expect(await run()).toMatchObject({ status: "completed" });
    expect(fixture.pools.at(-1)).not.toBe(pool);
    if (settlement === "complete") {
      expect(
        await result.continuation.resume(
          { kind: "resume", config: input.config, settledRequests: [] },
          { timeoutMs: 1000 },
        ),
      ).toMatchObject({ status: "completed" });
    } else {
      // The existing continuation TTL owner expires parked work through dispose().
      await result.continuation.dispose();
    }
    expect(pool.close).toHaveBeenCalledWith(undefined, "gc-storm");
    expect(pool.isClosed).toBe(true);
  },
);

it("shares catalog bytes across cells while sending current execution limits", async () => {
  const catalog = Array.from({ length: 109 }, (_, i) => ({
    callableName: `tool_${i}`,
    name: `tool_${i}`,
    source: "openclaw",
    description: "catalog metadata ".repeat(100),
  }));
  let start = { ...input, ...prepareCodeModeNodeCatalog({ catalog, namespaces: [] }) };
  const execute = () => host.run(() => nodeCodeModeExecutor.execute(start, { timeoutMs: 1000 }));
  await execute();
  const first = fixture.executions.at(-1)!.input as CodeModeNodeInput;
  await execute();
  const second = fixture.executions.at(-1)!.input as CodeModeNodeInput;
  assert(first.kind === "exec" && second.kind === "exec", "expected execution payloads");
  expect(second.initialization).toBe(first.initialization);
  expect(second.initialization.byteLength).toBeGreaterThan(100_000);
  expect(second).not.toHaveProperty("catalog");
  expect(second).not.toHaveProperty("apiFiles");
  expect(second).not.toHaveProperty("namespaces");
  expect(JSON.stringify(second).length).toBeLessThan(500);

  start = {
    ...input,
    ...prepareCodeModeNodeCatalog({
      catalog: [{ ...catalog[0]!, description: "new revision" }],
      namespaces: [],
    }),
    config: { ...input.config, maxPendingToolCalls: 3 },
  };
  await execute();
  const revised = fixture.executions.at(-1)!.input as CodeModeNodeInput;
  assert(revised.kind === "exec", "expected execution payload");
  expect(revised.initialization).not.toBe(first.initialization);
  expect(JSON.parse(new TextDecoder().decode(revised.initialization))).toMatchObject({
    __openclawCatalog: [{ description: "new revision" }],
  });
  expect(revised.config.maxPendingToolCalls).toBe(3);
});

it("joins its native workers at host close without retiring a sibling host", async () => {
  const sibling = new LegacyPluginSdkResourceHost();
  const siblingScheduler = createTestGatewayScheduler();
  sibling.bindScheduler(siblingScheduler);
  let held: ReturnType<typeof holdRetirement> | undefined;
  try {
    await run();
    const owned = fixture.pools.at(-1)!;
    await sibling.run(() => nodeCodeModeExecutor.execute(input, { timeoutMs: 1000 }));
    const survivor = fixture.pools.at(-1)!;
    expect(survivor).not.toBe(owned);
    held = holdRetirement(owned);
    const completed = vi.fn();
    const closing = host.close().then(completed);
    await held.retiring;
    expect(completed).not.toHaveBeenCalled();
    expect(scheduler.nextWakeAtMs).toBeNull();
    expect(survivor.isClosed).toBe(false);
    held.release();
    await closing;
    expect(owned.close).toHaveBeenCalledWith(undefined, "shutdown");
    const count = fixture.pools.length;
    await sibling.run(() => nodeCodeModeExecutor.execute(input, { timeoutMs: 1000 }));
    expect(fixture.pools).toHaveLength(count);
    expect(survivor.isClosed).toBe(false);
    await expect(run()).rejects.toThrow("Plugin SDK resource host is closed");
  } finally {
    held?.release();
    await sibling.close();
    await siblingScheduler.stop();
  }
});

it.each(["standalone", "runtime changed"] as const)(
  "closes a completed worker when %s prevents idle retention",
  async (reason) => {
    let previous: (typeof fixture.pools)[number] | undefined;
    if (reason === "runtime changed") {
      await run();
      previous = fixture.pools.at(-1)!;
      previous.run.mockImplementationOnce(async () => {
        fixture.workerUrl += ".updated";
        return fixture.completed;
      });
    }
    expect(
      await (reason === "standalone"
        ? nodeCodeModeExecutor.execute(input, { timeoutMs: 1000 })
        : run()),
    ).toMatchObject({ status: "completed" });
    expect((previous ?? fixture.pools.at(-1))?.isClosed).toBe(true);
    expect((previous ?? fixture.pools.at(-1))?.close).toHaveBeenCalledWith(
      undefined,
      reason === "runtime changed" ? "rotation" : "dispose",
    );
  },
);

it.each(["host", "idle"] as const)(
  "joins failed %s retirement before acquiring a successor",
  async (reason) => {
    const previous = reason === "host" ? new LegacyPluginSdkResourceHost() : host;
    const previousScheduler = reason === "host" ? createTestGatewayScheduler() : scheduler;
    if (reason === "host") {
      previous.bindScheduler(previousScheduler);
    }
    await previous.run(() => nodeCodeModeExecutor.execute(input, { timeoutMs: 1000 }));
    const retired = fixture.pools.at(-1)!;
    const count = fixture.pools.length;
    retired.close.mockRejectedValueOnce(new Error("native exit uncertain"));
    if (reason === "host") {
      await expect(previous.close()).rejects.toThrow(
        "Plugin SDK resources could not all be disposed",
      );
    } else {
      fixture.workerUrl += ".updated";
      await expect(run()).rejects.toThrow("native exit uncertain");
    }
    expect(retired.isClosed).toBe(false);
    expect(fixture.pools).toHaveLength(count);
    expect(await run()).toMatchObject({ status: "completed" });
    expect(retired.close).toHaveBeenCalledTimes(2);
    expect(retired.isClosed).toBe(true);
    expect(fixture.pools).toHaveLength(count + 1);
    if (reason === "host") {
      await previousScheduler.stop();
    }
  },
);

it("reuses idle workers and expires them without retaining completed caller context", async () => {
  const caller = new AsyncLocalStorage<string>();
  const retiredContexts: Array<string | undefined> = [];
  vi.useFakeTimers();
  try {
    await caller.run("completed-turn", () => Promise.all([run(), run()]));
    const count = fixture.pools.length;
    const previous = fixture.pools.at(-1)!;
    const reused = fixture.pools.at(-2)!;
    for (const pool of [previous, reused]) {
      pool.close.mockImplementation(async () => {
        retiredContexts.push(caller.getStore());
        pool.isClosed = true;
      });
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect([previous.isClosed, reused.isClosed]).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await caller.run("reused-turn", run)).toMatchObject({ status: "completed" });
    expect(fixture.pools).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect([previous.isClosed, reused.isClosed]).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reused.isClosed).toBe(true);
    expect(retiredContexts).toEqual([undefined, undefined]);
    expect(previous.close).toHaveBeenCalledWith(undefined, "idle-expiry");
    expect(reused.close).toHaveBeenCalledWith(undefined, "idle-expiry");
  } finally {
    caller.disable();
  }
});

it.each([
  ["90s delayed wake", 0, 60_000, 30_000, 210_000],
  ["360s delayed wake", 0, 330_000, 30_000, 0],
  ["immediate backward clock", 0, -3_600_000, 300_000, 0],
  ["backward clock after 60s", 60_000, -3_600_000, 240_000, 0],
] as const)(
  "keeps idle expiry through %s",
  async (_label, beforeMs, clockShift, afterMs, remainingMs) => {
    vi.useFakeTimers();
    await run();
    const pool = fixture.pools.at(-1)!;
    await vi.advanceTimersByTimeAsync(beforeMs);
    vi.setSystemTime(Date.now() + clockShift);
    await vi.advanceTimersByTimeAsync(afterMs);
    if (remainingMs) {
      expect(pool.isClosed).toBe(false);
      await vi.advanceTimersByTimeAsync(remainingMs);
    }
    expect(pool.isClosed).toBe(true);
  },
);

it("bounds the warm set and retires every idle pool on memory pressure", async () => {
  const start = fixture.pools.length;
  const results = await Promise.all(Array.from({ length: 6 }, run));
  expect(results.every((result) => result.status === "completed")).toBe(true);
  const idle = fixture.pools.filter((pool) => !pool.isClosed);
  expect(idle).toHaveLength(4);
  const evicted = fixture.pools.slice(start).filter((pool) => pool.isClosed);
  expect(evicted).toHaveLength(2);
  for (const pool of evicted) {
    expect(pool.close).toHaveBeenCalledWith(undefined, "eviction");
  }
  channel("openclaw.memory.critical").publish({});
  expect(idle.every((pool) => pool.isClosed)).toBe(true);
  for (const pool of idle) {
    expect(pool.close).toHaveBeenCalledWith(undefined, "memory_pressure");
  }
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
    const held = holdRetirement(previous);
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
      await held.retiring;
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
      held.release();
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
  pool.run.mockResolvedValueOnce(parkedResult());
  const result = await run();
  assert(result.status === "waiting", "Expected a live continuation");
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
  expect(pool.close).toHaveBeenCalledWith(undefined, "dispose");
  expect(pool.isClosed).toBe(true);
});

it.each([250, 1500])(
  "charges %d ms of native retirement to the deadline without shortening the separate CPU allowance",
  async (retirementMs) => {
    await run();
    const previous = fixture.pools.at(-1)!;
    const executionCount = fixture.executions.length;
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
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
  },
);

it("retires all old runtime workers before executing against a new entry", async () => {
  await Promise.all([run(), run()]);
  const previous = fixture.pools.at(-1)!;
  const sibling = fixture.pools.at(-2)!;
  const previousExecutions = previous.run.mock.calls.length;
  const held = holdRetirement(previous);
  fixture.workerUrl += ".updated";
  const poolCount = fixture.pools.length;
  const result = run();
  await held.retiring;
  expect(fixture.pools).toHaveLength(poolCount);
  fixture.workerUrl += ".newer";
  held.release();
  expect(await result).toMatchObject({ status: "completed" });
  expect(fixture.pools).toHaveLength(poolCount + 1);
  expect(previous.run).toHaveBeenCalledTimes(previousExecutions);
  expect(sibling.isClosed).toBe(true);
  expect(fixture.pools.at(-1)?.url).toBe(fixture.workerUrl);
});

it("does not release an excess completed pool after native cleanup fails", async () => {
  await run();
  const first = fixture.pools.at(-1)!;
  const held = holdRun(first);
  const pending = run();
  await held.started;
  const siblings = await Promise.all(Array.from({ length: 4 }, run));
  expect(siblings.every((result) => result.status === "completed")).toBe(true);
  first.close.mockRejectedValueOnce(new Error("native exit uncertain"));
  held.complete(fixture.completed);
  expect(await pending).toMatchObject({ status: "failed", error: "native exit uncertain" });
  expect(first.close).toHaveBeenCalledTimes(2);
  expect(first.isClosed).toBe(true);
});
