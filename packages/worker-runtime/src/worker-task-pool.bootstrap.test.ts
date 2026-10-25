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
  threadId = 1;
  input?: { taskId: number; input: unknown; nativeSections: SharedArrayBuffer };
  readonly terminate = vi.fn(async () => {
    this.threadId = -1;
    this.emit("exit", 0);
  });

  postMessage(input: NonNullable<FixtureWorker["input"]>) {
    this.input = input;
    this.emit("posted");
  }
  ready = () => this.emit("message", { status: "ready" });

  complete(error?: string) {
    this.ready();
    this.reply(error);
  }

  reply(error?: string) {
    const task = this.input;
    assert(task, "No worker task was dispatched");
    this.emit("message", {
      taskId: task.taskId,
      ...(error ? { status: "failed", error } : { status: "ok", value: task.input }),
    });
  }

  ref() {}
  unref() {}
  cpuUsage: WorkerLifecycle["cpuUsage"] = async () => ({ user: 0, system: 0 });
  getHeapStatistics = async (): Promise<never> => fail("Unexpected heap statistics request");
}

const pools: Array<WorkerTaskPoolCore<string, string>> = [];
const workerUrl = new URL("file:///synthetic-worker.mjs");
afterEach(() => Promise.all(pools.splice(0).map((pool) => pool.close())));

function fail(message: string): never {
  throw new Error(message);
}

function createPool({
  requiresReady,
  computeCapacity = createWorkerComputeCapacity(4),
  ...options
}: Omit<WorkerTaskPoolOptions<string>, "workerUrl"> & {
  requiresReady?: false;
  computeCapacity?: WorkerComputeCapacity;
} = {}) {
  const workers: FixtureWorker[] = [];
  const createWorker = vi.fn(() => {
    const worker = new FixtureWorker();
    workers.push(worker);
    return { worker };
  });
  const host: WorkerTaskHost = {
    requiresReady: requiresReady === false ? undefined : true,
    createWorker,
    serviceNativeWorkers: (nativeWorkers) => nativeWorkers.forEach((worker) => worker.service()),
    prepareResources: async () => {},
    releaseTemporaryDirectory: async () => {},
    captureTaskContext: () => undefined,
    receiveMessage: () => false,
    workerStarted() {},
    workerRetiring() {},
    computeCapacity,
    pools: {
      register: (pool) => pool,
      close: (_pool, closures, finish) => Promise.all(closures).then(finish),
    },
  };
  const pool = new WorkerTaskPoolCore<string, string>(
    { workerUrl, maxWorkers: 1, ...options, idleTimeoutMs: 0 },
    host,
  );
  pools.push(pool);
  return { pool, host, workers, createWorker };
}

const unavailable = { code: "unavailable" };
const rejected = { status: "rejected", reason: expect.objectContaining(unavailable) };

it.each([false, true])("flushes between native work and direct exit (%s)", async (rejectFlush) => {
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
  expect([flushDiagnostics.mock.calls.length, worker.terminate.mock.calls.length]).toEqual([0, 0]);
  release();
  await started.promise;
  expect(worker.terminate).not.toHaveBeenCalled();
  if (rejectFlush) {
    flush.reject(new Error("telemetry unavailable"));
  } else {
    flush.resolve();
  }
  await Promise.all([closing, task]);
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("services the diagnostic flush before native stop without Promise reactions", () => {
  const { pool, host } = createPool();
  const worker = new FixtureWorker();
  const stopped = createRetainedOperation<void>(() => {});
  const stop = vi.fn(() => {
    worker.threadId = -1;
    worker.emit("exit", 0);
    stopped.resolve();
    return stopped.operation;
  });
  const nativeState = { started: true, executionStopped: false, service() {} };
  const native = Object.assign(worker, nativeState, { stop });
  host.createWorker = () => ({ worker: native, native });
  let delivered = false;
  const flush = createRetainedOperation<void>(() => {
    if (delivered) {
      flush.resolve();
    }
  });
  host.flushWorkerDiagnostics = () => flush.operation;
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
  expect(stop).toHaveBeenCalledOnce();
});

async function overloadCapacity(result: Promise<string>) {
  const error = await result.catch((reason: unknown) => reason);
  assert(error instanceof WorkerTaskError, "Expected a worker overload");
  expect(error.code).toBe("overloaded");
  return error.capacityAvailable;
}

it("retries failed publication before successor dispatch", async () => {
  const events: string[] = [];
  const failure = new Error("resource publication failed");
  const { pool, workers } = createPool({
    onRotationComplete() {
      events.push("publish");
      if (events.length === 1) {
        throw failure;
      }
    },
  });
  const first = pool.run("first", {});
  workers.at(-1)!.complete();
  await first;
  const rotating = pool.rotate();
  const successor = pool.run(() => {
    events.push("prepare");
    return "successor";
  }, {});
  await expect(rotating).rejects.toBe(failure);
  expect(workers[0]!.threadId).toBe(-1);
  await pool.rotate();
  workers.at(-1)!.complete();
  await expect(successor).resolves.toBe("successor");
  expect(events).toEqual(["publish", "publish", "prepare"]);
});

it.each(["error", "exit", "constructor"] as const)("latches %s until rotation", async (failure) => {
  const { pool, workers, createWorker } = createPool({ maxWorkers: 2 });
  const prepared = Promise.withResolvers<string>();
  const nativeFailure = new Error("synthetic startup failure");
  if (failure === "constructor") {
    createWorker.mockImplementationOnce(() => fail("module unavailable"));
  } else {
    queueMicrotask(() => {
      workers[0]!.emit(failure, failure === "error" ? nativeFailure : 0);
      prepared.resolve("prepared after failure");
    });
  }
  const prepare = vi.fn(() => "input");
  const release = vi.fn();
  const inputs = [prepare, () => prepared.promise, prepare];
  const tasks = inputs.map((input) =>
    pool.run(input, { inputBytes: 16, onInputConsumed: release }),
  );
  const outcomes = await Promise.allSettled(tasks);
  expect(outcomes).toEqual([rejected, rejected, rejected]);
  if (failure === "error") {
    expect(outcomes[0]).toMatchObject({ reason: { cause: nativeFailure } });
  }
  expect([prepare.mock.calls.length, release.mock.calls.length]).toEqual([1, 3]);
  expect(pool.getSnapshot()).toMatchObject({ activeTasks: 0, pendingTasks: 0, workers: 0 });
  await expect(pool.run("still unavailable", {})).rejects.toMatchObject(unavailable);
  expect(createWorker).toHaveBeenCalledOnce();

  await pool.rotate();
  const recovered = pool.run("recovered", {});
  workers.at(-1)!.complete();
  await expect(recovered).resolves.toBe("recovered");
});

it("keeps a healthy sibling serving queued and new work with checkpoint pressure after failed boot", async () => {
  const { pool, workers, createWorker } = createPool({ maxWorkers: 2 });
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
    worker.reply();
    await expect(newlyAdmitted).resolves.toBe("newly admitted");
    expect(createWorker).toHaveBeenCalledTimes(2);
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
  expect([pool.getSnapshot().pendingTasks, workers[0]!.threadId]).toEqual([0, -1]);
});

it("keeps a failed native stop latched until a successful rotation joins it", async () => {
  const { pool, workers, createWorker } = createPool();
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
  expect(createWorker).toHaveBeenCalledOnce();
  await pool.rotate();
  expect(pool.getSnapshot().pendingTasks).toBe(0);
  const recovered = pool.run("recovered", {});
  workers.at(-1)!.complete();
  await expect(recovered).resolves.toBe("recovered");
});

it("does not latch malformed task input or an ordinary failure from a ready worker", async () => {
  const { pool, workers, createWorker } = createPool();
  await expect(
    pool.run("malformed transfer", {
      transferList: () => fail("invalid transfer input"),
    }),
  ).rejects.toThrow("invalid transfer input");
  const failed = pool.run("ordinary task failure", {});
  const failedResult = expect(failed).rejects.toMatchObject({ code: "failed" });
  workers[1]!.complete("invalid task data");
  await failedResult;
  const recovered = pool.run("valid task", {});
  workers[1]!.reply();
  await expect(recovered).resolves.toBe("valid task");
  expect(createWorker).toHaveBeenCalledTimes(2);
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
  const capacityAvailable = await overloadCapacity(local.pool.run("retry", { inputBytes: 16 }));
  assert(capacityAvailable, "Expected an overload readiness signal");
  const ready = vi.fn();
  void capacityAvailable.then(ready);
  const first = localFirst ? local : other;
  const firstWork = localFirst ? localWork : sharedWork;
  first.workers[0]!.reply();
  await firstWork;
  await Promise.resolve();
  expect(ready).not.toHaveBeenCalled();
  const second = localFirst ? other : local;
  second.workers[0]!.reply();
  await Promise.all([localWork, sharedWork, capacityAvailable]);
  expect(ready).toHaveBeenCalledOnce();
  const retry = local.pool.run("retry", { inputBytes: 16 });
  local.workers[0]!.reply();
  await expect(retry).resolves.toBe("retry");
  expect(computeCapacity.getSnapshot()).toMatchObject({ pendingTasks: 0, pendingBytes: 0 });
});

it("wakes an overloaded caller on close and rejects its retry as unavailable", async () => {
  const { pool } = createPool({ requiresReady: false, maxPendingTasks: 1 });
  const held = pool.run("held", {});
  const heldOutcome = Promise.allSettled([held]);
  const capacityAvailable = await overloadCapacity(pool.run("retry", {}));
  assert(capacityAvailable, "Expected an overload readiness signal");
  await pool.close();
  await capacityAvailable;
  expect(await heldOutcome).toMatchObject([{ status: "rejected" }]);
  await expect(pool.run("retry", {})).rejects.toMatchObject(unavailable);
});

it("does not promise readiness for input that exceeds the pool byte limit", async () => {
  const { pool } = createPool({ requiresReady: false, maxPendingBytes: 8 });
  expect(await overloadCapacity(pool.run("oversized", { inputBytes: 16 }))).toBeUndefined();
  expect(pool.getSnapshot().pendingTasks).toBe(0);
});
