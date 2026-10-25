import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createRetainedOperation } from "./retained-operation.js";
import type { WorkerLifecycle } from "./worker-lifecycle.js";
import {
  createWorkerComputeCapacity,
  DEFAULT_WORKER_PENDING_BYTES,
  type WorkerComputeCapacity,
} from "./worker-task-capacity.js";
import { WorkerTaskError } from "./worker-task-error.js";
import type { WorkerTaskHost } from "./worker-task-host.js";
import {
  retainCurrentWorkerNativeSection,
  withWorkerTaskNativeSectionScope,
} from "./worker-task-native-sections.js";
import { WorkerTaskPoolCore } from "./worker-task-pool-core.js";
import type { WorkerTaskPoolOptions, WorkerTaskResponse } from "./worker-task-pool.types.js";

class FixtureWorker extends EventEmitter implements WorkerLifecycle {
  input?: { taskId: number; input: unknown; nativeSections: SharedArrayBuffer };
  readonly terminate = vi.fn(async () => {
    this.threadId = -1;
    this.emit("exit", 0);
  });

  constructor(public threadId: number) {
    super();
  }

  postMessage(input: NonNullable<FixtureWorker["input"]>) {
    this.input = input;
    this.emit("posted");
  }
  ready() {
    this.emit("message", { status: "ready" });
  }

  complete() {
    this.ready();
    this.reply();
  }

  reply() {
    const task = this.input;
    assert(task, "No worker task was dispatched");
    this.emit("message", {
      taskId: task.taskId,
      status: "ok",
      value: task.input,
    });
  }

  ref() {}
  unref() {}
  cpuUsage: WorkerLifecycle["cpuUsage"] = async () => ({ user: 0, system: 0 });
  async getHeapStatistics(): Promise<never> {
    throw new Error("Heap statistics are outside the bootstrap contract");
  }
}

const pools: Array<WorkerTaskPoolCore<string, string>> = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

function createPool({
  maxWorkers = 1,
  requiresReady,
  computeCapacity = createWorkerComputeCapacity(4),
  ...options
}: Pick<
  WorkerTaskPoolOptions<string>,
  "maxWorkers" | "maxPendingTasks" | "maxPendingBytes" | "sharedCompute" | "onRotationComplete"
> & {
  requiresReady?: false;
  computeCapacity?: WorkerComputeCapacity;
} = {}) {
  const workers: FixtureWorker[] = [];
  const createWorker = vi.fn(() => {
    const worker = new FixtureWorker(workers.length + 1);
    workers.push(worker);
    return { worker };
  });
  const host: WorkerTaskHost = {
    requiresReady: requiresReady === false ? undefined : true,
    createWorker,
    serviceNativeWorkers(nativeWorkers) {
      nativeWorkers.forEach((worker) => worker.service());
    },
    prepareResources: async () => {},
    releaseTemporaryDirectory: async () => {},
    captureTaskContext: () => undefined,
    receiveMessage: () => false,
    workerStarted() {},
    workerRetiring() {},
    computeCapacity,
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
      ...options,
      idleTimeoutMs: 0,
    },
    host,
  );
  pools.push(pool);
  return {
    pool,
    host,
    workers,
    complete: () => workers.at(-1)!.complete(),
    createWorker,
    attempts: () => createWorker.mock.calls.length,
  };
}

const unavailable = { code: "unavailable" };
const rejected = { status: "rejected", reason: expect.objectContaining(unavailable) };

it.each([false, true])(
  "flushes diagnostics after native sections and before direct exit (flush fails=%s)",
  async (rejectFlush) => {
    const { pool, workers, host } = createPool();
    const started = Promise.withResolvers<void>();
    const flush = createRetainedOperation<void>(() => {});
    const flushDiagnostics = vi.fn(() => {
      started.resolve();
      return flush.operation;
    });
    host.flushWorkerDiagnostics = flushDiagnostics;
    const task = pool.run("active native work", {}).catch(() => undefined);
    const worker = workers[0]!;
    const release = withWorkerTaskNativeSectionScope(
      new Int32Array(worker.input!.nativeSections),
      () => true,
      retainCurrentWorkerNativeSection,
    );
    const closing = pool.close();
    await Promise.resolve();
    expect(flushDiagnostics).not.toHaveBeenCalled();
    expect(worker.terminate).not.toHaveBeenCalled();
    release();
    await started.promise;
    expect(worker.terminate).not.toHaveBeenCalled();
    if (rejectFlush) {
      flush.reject(new Error("telemetry unavailable"));
    } else {
      flush.resolve();
    }
    await closing;
    await task;
    expect(flushDiagnostics).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  },
);

it("services the diagnostic flush before native stop without Promise reactions", () => {
  const { pool, host } = createPool();
  const worker = new FixtureWorker(1);
  const stopped = createRetainedOperation<void>(() => {});
  const stop = vi.fn(() => {
    worker.threadId = -1;
    worker.emit("exit", 0);
    stopped.resolve();
    return stopped.operation;
  });
  const native = Object.assign(worker, {
    started: true,
    executionStopped: false,
    service() {},
    stop,
  });
  host.createWorker = () => ({ worker: native, native });
  let delivered = false;
  const flush = createRetainedOperation<void>(() => {
    if (delivered) {
      flush.resolve();
    }
  });
  const flushDiagnostics = vi.fn(() => flush.operation);
  host.flushWorkerDiagnostics = flushDiagnostics;
  void pool.run("ready to retire", {});
  worker.emit("started");
  worker.complete();
  const rotating = pool.startRotate();
  rotating.service();
  expect(rotating.read().status).toBe("pending");
  expect(stop).not.toHaveBeenCalled();
  delivered = true;
  rotating.service();
  expect(rotating.read().status).toBe("fulfilled");
  expect(flushDiagnostics).toHaveBeenCalledExactlyOnceWith(worker, "rotation");
  expect(stop).toHaveBeenCalledOnce();
});

async function expectOverload(result: Promise<string>) {
  const error = await result.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(WorkerTaskError);
  assert(error instanceof WorkerTaskError, "Expected a worker overload");
  expect(error.code).toBe("overloaded");
  return error;
}

async function expectCapacity(result: Promise<string>) {
  const { capacityAvailable } = await expectOverload(result);
  assert(capacityAvailable, "Expected an overload readiness signal");
  return { capacityAvailable };
}

it("retries failed publication before successor dispatch", async () => {
  const events: string[] = [];
  const failure = new Error("resource publication failed");
  const { pool, workers, complete } = createPool({
    onRotationComplete() {
      events.push("publish");
      if (events.length === 1) {
        throw failure;
      }
    },
  });
  const first = pool.run("first", {});
  complete();
  await first;
  const rotating = pool.rotate();
  const prepared = vi.fn(() => {
    events.push("prepare");
    return "successor";
  });
  const successor = pool.run(prepared, {});
  await expect(rotating).rejects.toBe(failure);
  expect(workers[0]!.threadId).toBe(-1);
  expect(prepared).not.toHaveBeenCalled();
  await pool.rotate();
  complete();
  await expect(successor).resolves.toBe("successor");
  expect(events).toEqual(["publish", "publish", "prepare"]);
});

it.each(["error", "exit", "constructor"] as const)("latches %s until rotation", async (failure) => {
  const { pool, workers, complete, attempts, createWorker } = createPool({ maxWorkers: 2 });
  const prepared = Promise.withResolvers<string>();
  const nativeFailure = Object.assign(new Error("synthetic heap exhausted"), {
    code: "ERR_WORKER_OUT_OF_MEMORY",
  });
  if (failure === "constructor") {
    createWorker.mockImplementationOnce(() => {
      throw new Error("module unavailable");
    });
  } else {
    queueMicrotask(() => {
      workers[0]!.emit(failure, failure === "error" ? nativeFailure : 0);
      prepared.resolve("prepared after failure");
    });
  }
  const prepare = vi.fn(() => "input");
  const release = vi.fn();
  const tasks = Array.from({ length: 12 }, (_, index) =>
    pool.run(index === 1 ? () => prepared.promise : prepare, {
      inputBytes: 16,
      onInputConsumed: release,
    }),
  );
  const outcomes = await Promise.allSettled(tasks);
  expect(outcomes).toEqual(Array.from({ length: 12 }, () => rejected));
  if (failure === "error") {
    expect(outcomes[0]).toMatchObject({ reason: { cause: nativeFailure } });
  }
  expect(prepare).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledTimes(12);
  expect(pool.getSnapshot()).toMatchObject({ activeTasks: 0, pendingTasks: 0, workers: 0 });
  await expect(pool.run("still unavailable", {})).rejects.toMatchObject(unavailable);
  expect(attempts()).toBe(1);

  await pool.rotate();
  const recovered = pool.run("recovered", {});
  complete();
  await expect(recovered).resolves.toBe("recovered");
  expect(attempts()).toBe(2);
});

it("keeps a healthy sibling serving queued and new work with checkpoint pressure after failed boot", async () => {
  const { pool, workers, attempts } = createPool({ maxWorkers: 2 });
  const requested = Promise.withResolvers<AbortSignal>();
  const response = Promise.withResolvers<WorkerTaskResponse>();
  const healthy = pool.run("healthy", {});
  const worker = workers[0]!;
  worker.ready();
  const failed = pool.run("failed boot", {});
  const failedResult = expect(failed).rejects.toMatchObject(unavailable);
  const queued = pool.run("queued", {
    onRequest(_value, { yieldSignal }) {
      requested.resolve(yieldSignal);
      return response.promise;
    },
  });
  workers[1]!.emit("error", new Error("second worker failed to initialize"));
  await failedResult;
  worker.reply();
  await expect(healthy).resolves.toBe("healthy");
  expect(worker.input?.input).toBe("queued");
  worker.emit("message", {
    status: "request",
    taskId: worker.input!.taskId,
    id: 1,
    value: "waiting on host",
  });
  const pressure = await requested.promise;
  expect(pressure.aborted).toBe(false);
  const newlyAdmitted = pool.run("newly admitted", {});
  try {
    expect(pressure.aborted).toBe(true);
    const posted = once(worker, "posted");
    response.resolve({ input: "queued", timeoutMs: 1000 });
    await posted;
    worker.reply();
    await expect(queued).resolves.toBe("queued");
    expect(worker.input?.input).toBe("newly admitted");
    worker.reply();
    await expect(newlyAdmitted).resolves.toBe("newly admitted");
    expect(attempts()).toBe(2);
  } finally {
    response.resolve({ input: null, timeoutMs: 1000 });
    await pool.close();
    await Promise.allSettled([queued, newlyAdmitted]);
  }
});

it("retains rejected owned-task admission until each owner releases its task", async () => {
  const { pool, workers } = createPool();
  const failed = pool.runTask("failed boot", { inputBytes: 16 });
  const queued = pool.runTask("queued task", { inputBytes: 16 });
  const results = Promise.allSettled([failed.result, queued.result]);
  workers[0]!.emit("error", new Error("module unavailable"));
  expect(await results).toEqual([rejected, rejected]);
  expect(pool.getSnapshot().pendingTasks).toBe(2);
  await Promise.all([failed.close(), queued.close()]);
  expect(pool.getSnapshot().pendingTasks).toBe(0);
  expect(workers[0]!.threadId).toBe(-1);
});

it("keeps a failed native stop latched until a successful rotation joins it", async () => {
  const { pool, workers, complete, attempts } = createPool();
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
  await expect(pool.run("no premature retry", {})).rejects.toMatchObject(unavailable);
  expect(attempts()).toBe(1);
  await pool.rotate();
  expect(pool.getSnapshot().pendingTasks).toBe(0);
  const recovered = pool.run("recovered", {});
  complete();
  await expect(recovered).resolves.toBe("recovered");
});

it("does not latch malformed task input", async () => {
  const { pool, workers, attempts } = createPool();
  await expect(
    pool.run("malformed transfer", {
      transferList() {
        throw new Error("invalid transfer input");
      },
    }),
  ).rejects.toThrow("invalid transfer input");
  const recovered = pool.run("valid task", {});
  workers[1]!.complete();
  await expect(recovered).resolves.toBe("valid task");
  expect(attempts()).toBe(2);
});

it.each([true, false])("waits for both capacities (local first=%s)", async (localFirst) => {
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
  const overload = await expectCapacity(local.pool.run("retry", { inputBytes: 16 }));
  let ready = false;
  void overload.capacityAvailable.then(() => {
    ready = true;
  });
  const first = localFirst ? local : other;
  const firstWork = localFirst ? localWork : sharedWork;
  first.workers[0]!.reply();
  await firstWork;
  await Promise.resolve();
  expect(ready).toBe(false);
  const second = localFirst ? other : local;
  second.workers[0]!.reply();
  await Promise.all([localWork, sharedWork, overload.capacityAvailable]);
  expect(ready).toBe(true);
  const retry = local.pool.run("retry", { inputBytes: 16 });
  local.workers[0]!.reply();
  await expect(retry).resolves.toBe("retry");
  expect(computeCapacity.getSnapshot()).toMatchObject({ pendingTasks: 0, pendingBytes: 0 });
});

it("wakes an overloaded caller on close and rejects its retry as unavailable", async () => {
  const { pool } = createPool({ requiresReady: false, maxPendingTasks: 1 });
  const held = pool.run("held", {});
  const heldOutcome = Promise.allSettled([held]);
  const overload = await expectCapacity(pool.run("retry", {}));
  await pool.close();
  await overload.capacityAvailable;
  expect(await heldOutcome).toMatchObject([{ status: "rejected" }]);
  await expect(pool.run("retry", {})).rejects.toMatchObject(unavailable);
});

it("does not promise readiness for input that exceeds the pool byte limit", async () => {
  const { pool } = createPool({ requiresReady: false, maxPendingBytes: 8 });
  const overload = await expectOverload(pool.run("oversized", { inputBytes: 16 }));
  expect(overload.capacityAvailable).toBeUndefined();
  expect(pool.getSnapshot().pendingTasks).toBe(0);
});
