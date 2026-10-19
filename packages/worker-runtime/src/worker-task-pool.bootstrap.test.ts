import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkerLifecycle } from "./worker-lifecycle.js";
import {
  createWorkerComputeCapacity,
  DEFAULT_WORKER_PENDING_BYTES,
  type WorkerComputeCapacity,
} from "./worker-task-capacity.js";
import { WorkerTaskError } from "./worker-task-error.js";
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
  options: Pick<
    WorkerTaskPoolOptions<string>,
    "maxWorkers" | "maxPendingTasks" | "maxPendingBytes" | "sharedCompute" | "onRotationComplete"
  > & {
    requiresReady?: false;
    computeCapacity?: WorkerComputeCapacity;
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
    serviceNativeWorkers(nativeWorkers) {
      for (const worker of nativeWorkers) {
        worker.service();
      }
    },
    prepareResources: async () => {},
    releaseTemporaryDirectory: async () => {},
    captureTaskContext: () => undefined,
    receiveMessage: () => false,
    workerStarted() {},
    workerRetiring() {},
    computeCapacity: options.computeCapacity ?? createWorkerComputeCapacity(4),
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
      onRotationComplete: options.onRotationComplete,
      maxPendingTasks: options.maxPendingTasks,
      maxPendingBytes: options.maxPendingBytes,
      sharedCompute: options.sharedCompute,
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

it("publishes retired resources before dispatching queued successor input", async () => {
  let nativeReader = false;
  const { pool, workers } = createPool({
    onRotationComplete: () => {
      nativeReader = false;
    },
  });
  const first = pool.run(() => {
    nativeReader = true;
    return "first";
  }, {});
  workers[0]!.ready();
  workers[0]!.reply();
  await first;
  const rotating = pool.rotate();
  let previousReader: boolean | undefined;
  const successor = pool.run(() => {
    previousReader = nativeReader;
    nativeReader = true;
    return "successor";
  }, {});
  await rotating;
  const worker = workers.at(-1)!;
  worker.ready();
  worker.reply();
  await expect(successor).resolves.toBe("successor");
  expect(workers[0]!.threadId).toBe(-1);
  expect(previousReader).toBe(false);
  expect(nativeReader).toBe(true);
});

it("holds queued input after resource publication fails until rotation is retried", async () => {
  const failure = new Error("resource publication failed");
  const released = vi.fn().mockImplementationOnce(() => {
    throw failure;
  });
  const { pool, workers } = createPool({ onRotationComplete: released });
  const first = pool.run("first", {});
  workers[0]!.ready();
  workers[0]!.reply();
  await first;
  const rotating = pool.rotate();
  const prepared = vi.fn(() => "successor");
  const successor = pool.run(prepared, {});
  await expect(rotating).rejects.toBe(failure);
  expect(workers[0]!.threadId).toBe(-1);
  expect(prepared).not.toHaveBeenCalled();
  await pool.rotate();
  workers.at(-1)!.ready();
  workers.at(-1)!.reply();
  await expect(successor).resolves.toBe("successor");
  expect(released).toHaveBeenCalledTimes(2);
});

it.each(["error", "exit", "constructor"] as const)(
  "rejects one bootstrap cohort after %s and retries only after rotation",
  async (failure) => {
    const { pool, workers, attempts, failConstruction, onCreated } = createPool();
    const nativeFailure = Object.assign(new Error("synthetic heap exhausted"), {
      code: "ERR_WORKER_OUT_OF_MEMORY",
    });
    if (failure === "constructor") {
      failConstruction(new Error("module unavailable"));
    } else {
      onCreated((worker) => {
        queueMicrotask(() => {
          if (failure === "error") {
            worker.emit("error", nativeFailure);
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
    if (failure === "error") {
      expect(outcomes[0]).toMatchObject({ reason: { cause: nativeFailure } });
    }
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

it.each(["local-first", "shared-first"] as const)(
  "notifies overload readiness only after local and shared capacity return (%s)",
  async (order) => {
    const computeCapacity = createWorkerComputeCapacity(4);
    const local = createPool({
      requiresReady: false,
      maxPendingTasks: 1,
      maxPendingBytes: 32,
      sharedCompute: true,
      computeCapacity,
    });
    const other = createPool({ requiresReady: false, sharedCompute: true, computeCapacity });
    const localWork = local.pool.run("local", { inputBytes: 8 });
    const sharedWork = other.pool.run("shared", { inputBytes: DEFAULT_WORKER_PENDING_BYTES - 8 });
    const overload = await local.pool
      .run("retry", { inputBytes: 16 })
      .catch((error: unknown) => error);
    expect(overload).toBeInstanceOf(WorkerTaskError);
    if (!(overload instanceof WorkerTaskError) || !overload.capacityAvailable) {
      throw new Error("Expected an overload readiness signal");
    }
    expect(overload.code).toBe("overloaded");
    let ready = false;
    void overload.capacityAvailable.then(() => {
      ready = true;
    });
    const first = order === "local-first" ? local : other;
    const firstWork = order === "local-first" ? localWork : sharedWork;
    first.workers[0]!.reply();
    await firstWork;
    await Promise.resolve();
    expect(ready).toBe(false);
    const second = order === "local-first" ? other : local;
    second.workers[0]!.reply();
    await Promise.all([localWork, sharedWork, overload.capacityAvailable]);
    expect(ready).toBe(true);
    const retry = local.pool.run("retry", { inputBytes: 16 });
    local.workers[0]!.reply();
    await expect(retry).resolves.toBe("retry");
    expect(computeCapacity.getSnapshot().pendingTasks).toBe(0);
    expect(computeCapacity.getSnapshot().pendingBytes).toBe(0);
  },
);

it("wakes an overloaded caller on close and rejects its retry as unavailable", async () => {
  const { pool } = createPool({ requiresReady: false, maxPendingTasks: 1 });
  const held = pool.run("held", {});
  const heldOutcome = Promise.allSettled([held]);
  const overload = await pool.run("retry", {}).catch((error: unknown) => error);
  if (!(overload instanceof WorkerTaskError) || !overload.capacityAvailable) {
    throw new Error("Expected an overload readiness signal");
  }
  await pool.close();
  await overload.capacityAvailable;
  expect(await heldOutcome).toMatchObject([{ status: "rejected" }]);
  await expect(pool.run("retry", {})).rejects.toMatchObject({ code: "unavailable" });
});

it("does not promise readiness for input that exceeds the pool byte limit", async () => {
  const { pool } = createPool({ requiresReady: false, maxPendingBytes: 8 });
  const overload = await pool.run("oversized", { inputBytes: 16 }).catch((error: unknown) => error);
  expect(overload).toBeInstanceOf(WorkerTaskError);
  if (!(overload instanceof WorkerTaskError)) {
    throw new Error("Expected the oversized input to be rejected");
  }
  expect(overload.code).toBe("overloaded");
  expect(overload.capacityAvailable).toBeUndefined();
  expect(pool.getSnapshot().pendingTasks).toBe(0);
});
