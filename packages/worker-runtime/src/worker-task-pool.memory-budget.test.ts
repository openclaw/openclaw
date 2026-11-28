import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkerLifecycle } from "./worker-lifecycle.js";
import { createWorkerComputeCapacity } from "./worker-task-capacity.js";
import type { WorkerPoolMemoryBudget, WorkerTaskHost } from "./worker-task-host.js";
import { WorkerTaskPoolCore } from "./worker-task-pool-core.js";
import type { WorkerTaskPoolOptions } from "./worker-task-pool.types.js";

class FixtureWorker extends EventEmitter implements WorkerLifecycle {
  readonly inputs: Array<{ taskId: number; input: unknown }> = [];
  readonly terminate = vi.fn(async () => {
    this.threadId = -1;
    this.emit("exit", 0);
  });

  constructor(public threadId: number) {
    super();
  }

  postMessage(value: unknown) {
    assert(value !== null && typeof value === "object" && "taskId" in value && "input" in value);
    assert(typeof value.taskId === "number");
    this.inputs.push({ taskId: value.taskId, input: value.input });
  }

  reply() {
    const task = this.inputs.at(-1);
    assert(task, "No worker task was dispatched");
    this.emit("message", { taskId: task.taskId, status: "ok", value: task.input });
  }

  ref() {}
  unref() {}
  cpuUsage: WorkerLifecycle["cpuUsage"] = async () => ({ user: 0, system: 0 });
  async getHeapStatistics(): Promise<never> {
    throw new Error("unused");
  }
}

const pools: Array<WorkerTaskPoolCore<string, string>> = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  vi.useRealTimers();
});

function createBudget(admit: () => boolean) {
  return {
    floor: 1,
    isCurrent: vi.fn(() => true),
    admitGrowth: vi.fn(admit),
    releaseGrowth: vi.fn(),
    reservePointReadFloor: vi.fn(),
    waitStarted: vi.fn(),
    waitFinished: vi.fn(),
  } satisfies WorkerPoolMemoryBudget;
}

function createPool(
  budget: WorkerPoolMemoryBudget | undefined,
  maxWorkers = 2,
  options: Partial<WorkerTaskPoolOptions<string>> = {},
) {
  const workers: FixtureWorker[] = [];
  const createMemoryBudget = vi.fn((): WorkerPoolMemoryBudget | undefined => budget);
  const host: WorkerTaskHost = {
    createMemoryBudget,
    createWorker() {
      const worker = new FixtureWorker(workers.length + 1);
      workers.push(worker);
      return { worker };
    },
    serviceNativeWorkers() {},
    prepareResources: async () => {},
    releaseTemporaryDirectory: async () => {},
    captureTaskContext: () => undefined,
    receiveMessage: () => false,
    workerStarted() {},
    workerRetiring() {},
    computeCapacity: createWorkerComputeCapacity(4),
    pools: {
      register: (pool) => pool,
      async close(_pool, closures, finish) {
        await Promise.all(closures);
        await finish();
      },
    },
  };
  const pool = new WorkerTaskPoolCore<string, string>(
    {
      workerUrl: new URL("file:///synthetic-worker.mjs"),
      maxWorkers,
      idleTimeoutMs: 0,
      ...options,
    },
    host,
  );
  pools.push(pool);
  return { pool, workers, host, createMemoryBudget };
}

const settle = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

it.each([0, 60_000])(
  "keeps the shared reader when preparation finishes out of order (primary idle %i)",
  async (idleTimeoutMs) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { pool, host, workers } = createPool(undefined, 2, {
      idleTimeoutMs,
      burstIdleTimeoutMs: 5_000,
    });
    host.isSharedWorker = (worker) => worker === workers[0];
    const gate = Promise.withResolvers<string>();
    const first = pool.run(() => gate.promise, {});
    const second = pool.run("second", {});
    await settle();
    const shared = workers[0]!;
    shared.reply();
    await second;
    gate.resolve("first");
    await settle();
    const dedicated = workers[1]!;
    dedicated.reply();
    await first;

    const warm = pool.run("warm", {});
    const rescue = pool.run("rescue", {});
    expect(shared.inputs.at(-1)?.input).toBe("warm");
    expect(dedicated.inputs.at(-1)?.input).toBe("rescue");
    dedicated.reply();
    shared.reply();
    await Promise.all([warm, rescue]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dedicated.terminate).toHaveBeenCalledOnce();
    expect(shared.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(55_000);
    expect(shared.terminate).toHaveBeenCalledTimes(idleTimeoutMs ? 1 : 0);
  },
);

it("charges time already idle when a dedicated reader becomes surplus", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { pool, host, workers } = createPool(undefined, 2, {
    idleTimeoutMs: 0,
    burstIdleTimeoutMs: 5_000,
  });
  host.isSharedWorker = (worker) => worker === workers[1];
  const gate = Promise.withResolvers<string>();
  const first = pool.run("dedicated", {});
  const second = pool.run(() => gate.promise, {});
  await settle();
  const dedicated = workers[0]!;
  dedicated.reply();
  await first;
  await vi.advanceTimersByTimeAsync(4_000);
  gate.resolve("shared");
  await settle();
  const shared = workers[1]!;
  shared.reply();
  await second;
  await vi.advanceTimersByTimeAsync(999);
  expect(dedicated.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(dedicated.terminate).toHaveBeenCalledOnce();
  expect(shared.terminate).not.toHaveBeenCalled();
});

it("queues refused growth on the floor worker instead of starting or dropping it", async () => {
  const budget = createBudget(() => false);
  const { pool, workers } = createPool(budget);
  const first = pool.run("first", {});
  const second = pool.run("second", {});
  await settle();
  expect(workers).toHaveLength(1);
  expect(budget.admitGrowth).toHaveBeenCalled();
  expect(budget.waitStarted).toHaveBeenCalledOnce();
  workers[0]!.reply();
  await expect(first).resolves.toBe("first");
  await settle();
  expect(workers).toHaveLength(1);
  expect(budget.waitFinished).toHaveBeenCalledOnce();
  workers[0]!.reply();
  await expect(second).resolves.toBe("second");
});

it("starts admitted growth and releases it after that worker exits", async () => {
  const budget = createBudget(() => true);
  const { pool, workers } = createPool(budget);
  const runs = [pool.run("first", {}), pool.run("second", {})];
  await settle();
  expect(workers).toHaveLength(2);
  expect(budget.admitGrowth).toHaveBeenCalledOnce();
  expect(budget.waitStarted).not.toHaveBeenCalled();
  workers[0]!.reply();
  workers[1]!.reply();
  await Promise.all(runs);
  workers[1]!.emit("exit", 1);
  await settle();
  pool.run("third", {}).catch(() => undefined);
  await settle();
  expect(budget.releaseGrowth).toHaveBeenCalledWith(1);
});

it("keeps the point-read lane mandatory and out of bulk use", async () => {
  const budget = createBudget(() => false);
  const { pool, workers } = createPool(budget);
  const bulk = pool.run("bulk", {});
  const pointRead = pool.run("point", { pointRead: true });
  await settle();
  // The point read gets its own lane without a growth admission.
  expect(workers).toHaveLength(2);
  expect(budget.reservePointReadFloor).toHaveBeenCalledOnce();
  workers[1]!.reply();
  await expect(pointRead).resolves.toBe("point");
  const nextBulk = pool.run("next bulk", {});
  await settle();
  // The idle point-read worker is not bulk capacity while growth is refused.
  expect(workers[1]!.inputs).toHaveLength(1);
  expect(budget.waitStarted).toHaveBeenCalledOnce();
  workers[0]!.reply();
  await expect(bulk).resolves.toBe("bulk");
  await settle();
  workers.find((worker) => worker.inputs.at(-1)?.input === "next bulk")!.reply();
  await expect(nextBulk).resolves.toBe("next bulk");
});

it("rebinds to the host's current policy after the previous one was replaced", async () => {
  const lean = createBudget(() => true);
  const { pool, workers, createMemoryBudget } = createPool(lean);
  const runs = [pool.run("first", {}), pool.run("second", {})];
  await settle();
  workers.forEach((worker) => worker.reply());
  await Promise.all(runs);
  // An in-process restart chose standard: the old lean policy no longer applies.
  lean.isCurrent.mockReturnValue(false);
  expect(createMemoryBudget).toHaveBeenCalledOnce();
  createMemoryBudget.mockReturnValue(undefined);
  const next = [pool.run("a", {}), pool.run("b", {})];
  await settle();
  // The pool asked for the current policy instead of charging the retired ledger.
  expect(createMemoryBudget.mock.calls.length).toBeGreaterThan(1);
  expect(lean.releaseGrowth).not.toHaveBeenCalled();
  expect(lean.admitGrowth).toHaveBeenCalledOnce();
  expect(workers.filter((worker) => worker.inputs.length === 2)).toHaveLength(2);
  workers.forEach((worker) => worker.reply());
  await Promise.all(next);
});
