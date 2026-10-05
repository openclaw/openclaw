import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkerLifecycle } from "./worker-lifecycle.js";
import { createWorkerComputeCapacity } from "./worker-task-capacity.js";
import type { WorkerTaskHost } from "./worker-task-host.js";
import { WorkerTaskPoolCore } from "./worker-task-pool-core.js";
import type { WorkerTaskPoolOptions, WorkerTaskResponse } from "./worker-task-pool.types.js";

class FixtureWorker extends EventEmitter implements WorkerLifecycle {
  threadId: number;
  readonly inputs: Array<{ taskId: number; input: unknown }> = [];
  readonly terminate = vi.fn(async () => {
    this.threadId = -1;
    this.emit("exit", 0);
  });

  constructor(id: number) {
    super();
    this.threadId = id;
  }

  postMessage(value: unknown) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("taskId" in value) ||
      typeof value.taskId !== "number" ||
      !("input" in value)
    ) {
      throw new Error("Expected a worker task input");
    }
    this.inputs.push({ taskId: value.taskId, input: value.input });
  }

  ready() {
    this.emit("message", { status: "ready" });
  }

  reply(error?: string) {
    const task = this.inputs.at(-1);
    if (!task) {
      throw new Error("No worker task was dispatched");
    }
    this.emit("message", {
      taskId: task.taskId,
      ...(error ? { status: "failed", error } : { status: "ok", value: task.input }),
    });
  }

  ref() {}
  unref() {}
  cpuUsage: Worker["cpuUsage"] = async () => ({ user: 0, system: 0 });
  async getHeapStatistics(): Promise<never> {
    throw new Error("Heap statistics are outside the bootstrap contract");
  }
}

const pools: Array<WorkerTaskPoolCore<string, string>> = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

function createPool(
  options: Pick<WorkerTaskPoolOptions<string>, "maxWorkers" | "prepareWorker"> & {
    requiresReady?: false;
  } = {},
) {
  const workers: FixtureWorker[] = [];
  let constructionFailure: Error | undefined;
  let onCreated: ((worker: FixtureWorker) => void) | undefined;
  let attempts = 0;
  const host: WorkerTaskHost = {
    ...(options.requiresReady === false ? {} : { requiresReady: true }),
    createWorker() {
      attempts++;
      if (constructionFailure) {
        throw constructionFailure;
      }
      const worker = new FixtureWorker(attempts);
      workers.push(worker);
      onCreated?.(worker);
      return { worker };
    },
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
      maxWorkers: options.maxWorkers ?? 1,
      prepareWorker: options.prepareWorker,
      idleTimeoutMs: 0,
    },
    host,
  );
  pools.push(pool);
  return {
    pool,
    workers,
    attempts: () => attempts,
    failConstruction: (error?: Error) => {
      constructionFailure = error;
    },
    onCreated: (callback?: (worker: FixtureWorker) => void) => {
      onCreated = callback;
    },
  };
}

it.each(["error", "exit", "constructor"] as const)(
  "rejects one bootstrap cohort after %s and retries only after rotation",
  async (failure) => {
    const { pool, workers, attempts, failConstruction, onCreated } = createPool();
    if (failure === "constructor") {
      failConstruction(new Error("module unavailable"));
    } else {
      onCreated((worker) => {
        queueMicrotask(() => {
          if (failure === "error") {
            worker.emit("error", new Error("module unavailable"));
          } else {
            worker.emit("exit", 0);
          }
        });
      });
    }
    const prepare = vi.fn(() => "input");
    const release = vi.fn();
    const tasks = Array.from({ length: 12 }, () =>
      pool.run(prepare, { inputBytes: 16, onInputConsumed: release }),
    );
    const outcomes = await Promise.allSettled(tasks);
    expect(outcomes).toEqual(
      Array.from({ length: 12 }, () => ({
        status: "rejected",
        reason: expect.objectContaining({ code: "unavailable" }),
      })),
    );
    expect(attempts()).toBe(1);
    expect(prepare).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(12);
    expect(pool.getSnapshot()).toMatchObject({ activeTasks: 0, pendingTasks: 0, workers: 0 });
    await expect(pool.run("still unavailable", {})).rejects.toMatchObject({ code: "unavailable" });
    expect(attempts()).toBe(1);

    failConstruction();
    onCreated();
    await pool.rotate();
    const recovered = pool.run("recovered", {});
    const worker = workers.at(-1)!;
    worker.ready();
    worker.reply();
    await expect(recovered).resolves.toBe("recovered");
    expect(attempts()).toBe(2);
  },
);

it("keeps a healthy sibling serving the backlog without repeatedly replacing the failed boot", async () => {
  const { pool, workers, attempts } = createPool({ maxWorkers: 2 });
  const healthy = pool.run("healthy", {});
  const worker = workers[0]!;
  worker.ready();
  const failed = pool.run("failed boot", {});
  const failedResult = expect(failed).rejects.toMatchObject({ code: "unavailable" });
  const pending = ["first", "second", "third"].map((input) => pool.run(input, {}));
  workers[1]!.emit("error", new Error("second worker failed to initialize"));
  await failedResult;
  pending.push(pool.run("newly admitted", {}));
  expect(attempts()).toBe(2);
  worker.reply();
  await expect(healthy).resolves.toBe("healthy");
  for (const input of ["first", "second", "third", "newly admitted"]) {
    expect(worker.inputs.at(-1)?.input).toBe(input);
    worker.reply();
  }
  await expect(Promise.all(pending)).resolves.toEqual([
    "first",
    "second",
    "third",
    "newly admitted",
  ]);
  expect(attempts()).toBe(2);
});

it("does not start a late input preparation after its sibling bootstrap failed", async () => {
  const { pool, workers, attempts } = createPool({ maxWorkers: 2 });
  const failed = pool.run("failed boot", {});
  const prepared = Promise.withResolvers<string>();
  const release = vi.fn();
  const preparing = pool.run(() => prepared.promise, { onInputConsumed: release });
  const results = Promise.allSettled([failed, preparing]);
  workers[0]!.emit("error", new Error("module unavailable"));
  prepared.resolve("prepared after failure");
  expect(await results).toEqual([
    { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
    { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
  ]);
  expect(release).toHaveBeenCalledOnce();
  expect(attempts()).toBe(1);
  expect(pool.getSnapshot().pendingTasks).toBe(0);
});

it("rechecks bootstrap admission after worker preparation reenters a sibling failure", async () => {
  const created = Promise.withResolvers<FixtureWorker>();
  const release = vi.fn(async () => {});
  let preparations = 0;
  const { pool, attempts, onCreated } = createPool({
    maxWorkers: 2,
    prepareWorker() {
      if (++preparations === 2) {
        sibling.emit("error", new Error("first worker failed during second preparation"));
      }
      return { options: {}, releaseResources: release };
    },
  });
  onCreated((worker) => {
    if (worker.threadId === 1) {
      created.resolve(worker);
    } else {
      queueMicrotask(() => worker.emit("error", new Error("unexpected replacement worker")));
    }
  });
  const first = pool.run("first bootstrap", {});
  const sibling = await created.promise;
  const results = await Promise.allSettled([first, pool.run("second preparation", {})]);
  expect(results).toEqual([
    { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
    { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
  ]);
  await pool.close();
  expect(attempts()).toBe(1);
  expect(release).toHaveBeenCalledTimes(2);
});

it("requests a checkpoint when failed bootstrap leaves a healthy host-waiting sibling", async () => {
  const { pool, workers } = createPool({ maxWorkers: 2 });
  const requested = Promise.withResolvers<AbortSignal>();
  const response = Promise.withResolvers<WorkerTaskResponse>();
  const healthy = pool.run("host request", {
    onRequest(_value, { yieldSignal }) {
      requested.resolve(yieldSignal);
      return response.promise;
    },
  });
  const healthyResult = Promise.allSettled([healthy]);
  const worker = workers[0]!;
  worker.ready();
  const failed = pool.run("failed boot", {});
  const failedResult = expect(failed).rejects.toMatchObject({ code: "unavailable" });
  workers[1]!.emit("error", new Error("second worker failed to initialize"));
  await failedResult;
  worker.emit("message", {
    status: "request",
    taskId: worker.inputs[0]!.taskId,
    id: 1,
    value: "waiting on host",
  });
  const pressure = await requested.promise;
  expect(pressure.aborted).toBe(false);
  const queued = Promise.allSettled([pool.run("queued contender", {})]);
  try {
    expect(pressure.aborted).toBe(true);
  } finally {
    response.resolve({ input: null, timeoutMs: 1000 });
    await pool.close();
    await Promise.all([healthyResult, queued]);
  }
});

it("retains rejected owned-task admission until each owner releases its task", async () => {
  const { pool, workers } = createPool();
  const failed = pool.runTask("failed boot", { inputBytes: 16 });
  const queued = pool.runTask("queued task", { inputBytes: 16 });
  const results = Promise.allSettled([failed.result, queued.result]);
  workers[0]!.emit("error", new Error("module unavailable"));
  expect(await results).toEqual([
    { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
    { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
  ]);
  expect(pool.getSnapshot().pendingTasks).toBe(2);
  await Promise.all([failed.close(), queued.close()]);
  expect(pool.getSnapshot().pendingTasks).toBe(0);
  expect(workers[0]!.threadId).toBe(-1);
});

it("keeps a failed native stop latched until a successful rotation joins it", async () => {
  const { pool, workers, attempts } = createPool();
  const failed = pool.run("failed boot", {});
  const failedResult = expect(failed).rejects.toThrow("exit uncertain");
  const worker = workers[0]!;
  worker.terminate
    .mockRejectedValueOnce(new Error("exit uncertain"))
    .mockRejectedValueOnce(new Error("exit still uncertain"));
  worker.emit("error", new Error("module unavailable"));
  await failedResult;
  expect(pool.getSnapshot().pendingTasks).toBe(1);
  await expect(pool.rotate()).rejects.toThrow("exit still uncertain");
  await expect(pool.run("no premature retry", {})).rejects.toMatchObject({ code: "unavailable" });
  expect(attempts()).toBe(1);
  await pool.rotate();
  expect(pool.getSnapshot().pendingTasks).toBe(0);
  const recovered = pool.run("recovered", {});
  workers[1]!.ready();
  workers[1]!.reply();
  await expect(recovered).resolves.toBe("recovered");
});

it("does not latch malformed task input or an ordinary failure from a ready worker", async () => {
  const { pool, workers, attempts } = createPool();
  await expect(
    pool.run("malformed transfer", {
      transferList() {
        throw new Error("invalid transfer input");
      },
    }),
  ).rejects.toThrow("invalid transfer input");
  const failed = pool.run("ordinary task failure", {});
  const failedResult = expect(failed).rejects.toMatchObject({ code: "failed" });
  workers[1]!.ready();
  workers[1]!.reply("invalid task data");
  await failedResult;
  const recovered = pool.run("valid task", {});
  workers[1]!.reply();
  await expect(recovered).resolves.toBe("valid task");
  expect(attempts()).toBe(2);
});

it("preserves arbitrary worker recovery without a served-protocol readiness requirement", async () => {
  const { pool, workers } = createPool({ requiresReady: false });
  const failed = pool.run("custom worker exits", {});
  const failedResult = expect(failed).rejects.toMatchObject({ code: "unavailable" });
  const queued = pool.run("custom response", {});
  workers[0]!.emit("exit", 0);
  await failedResult;
  workers[1]!.reply();
  await expect(queued).resolves.toBe("custom response");
});
