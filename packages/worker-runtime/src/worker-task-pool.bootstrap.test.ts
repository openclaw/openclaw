import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  type WorkerNativeSectionState,
} from "./worker-task-native-sections.js";
import { WorkerTaskPoolCore } from "./worker-task-pool-core.js";
import type { WorkerTaskPoolOptions, WorkerTaskResponse } from "./worker-task-pool.types.js";

class FixtureWorker extends EventEmitter implements WorkerLifecycle {
  readonly inputs: Array<{ taskId: number; input: unknown }> = [];
  nativeSections?: WorkerNativeSectionState;
  readonly terminate = vi.fn(async () => {
    this.threadId = -1;
    this.emit("exit", 0);
  });

  constructor(public threadId: number) {
    super();
  }

  postMessage(value: unknown) {
    assert(value !== null && typeof value === "object" && "taskId" in value && "input" in value);
    assert(typeof value.taskId === "number", "Expected a worker task input");
    if ("nativeSections" in value && value.nativeSections instanceof SharedArrayBuffer) {
      this.nativeSections = new Int32Array(value.nativeSections);
    }
    this.inputs.push({ taskId: value.taskId, input: value.input });
  }

  ready() {
    this.emit("message", { status: "ready" });
  }

  complete(error?: string) {
    this.ready();
    this.reply(error);
  }

  reply(error?: string) {
    const task = this.inputs.at(-1);
    assert(task, "No worker task was dispatched");
    this.emit("message", {
      taskId: task.taskId,
      ...(error ? { status: "failed", error } : { status: "ok", value: task.input }),
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
const nativeFailure = Object.assign(new Error("synthetic heap exhausted"), {
  code: "ERR_WORKER_OUT_OF_MEMORY",
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

function createPool({
  maxWorkers = 1,
  requiresReady,
  failure: initialFailure,
  computeCapacity = createWorkerComputeCapacity(4),
  ...options
}: Pick<
  WorkerTaskPoolOptions<string>,
  "maxWorkers" | "maxPendingTasks" | "maxPendingBytes" | "sharedCompute" | "onRotationComplete"
> & {
  requiresReady?: false;
  failure?: "error" | "exit" | "constructor";
  computeCapacity?: WorkerComputeCapacity;
} = {}) {
  const workers: FixtureWorker[] = [];
  let failure = initialFailure;
  let attempts = 0;
  const host: WorkerTaskHost = {
    requiresReady: requiresReady === false ? undefined : true,
    createWorker() {
      attempts++;
      if (failure === "constructor") {
        throw new Error("module unavailable");
      }
      const worker = new FixtureWorker(attempts);
      workers.push(worker);
      const event = failure;
      if (event) {
        queueMicrotask(() => worker.emit(event, event === "error" ? nativeFailure : 0));
      }
      return { worker };
    },
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
    attempts: () => attempts,
    recover: () => {
      failure = undefined;
    },
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
    assert(worker.nativeSections);
    const release = withWorkerTaskNativeSectionScope(
      worker.nativeSections,
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

it.each([false, true])("publishes before successor dispatch (retry=%s)", async (retry) => {
  let nativeReader = false;
  const failure = new Error("resource publication failed");
  const released = vi.fn(() => {
    nativeReader = false;
  });
  if (retry) {
    released.mockImplementationOnce(() => {
      throw failure;
    });
  }
  const { pool, workers, complete } = createPool({ onRotationComplete: released });
  const first = pool.run(() => {
    nativeReader = true;
    return "first";
  }, {});
  complete();
  await first;
  const rotating = pool.rotate();
  let previousReader: boolean | undefined;
  const prepared = vi.fn(() => {
    previousReader = nativeReader;
    nativeReader = true;
    return "successor";
  });
  const successor = pool.run(prepared, {});
  if (retry) {
    await expect(rotating).rejects.toBe(failure);
    expect(workers[0]!.threadId).toBe(-1);
    expect(prepared).not.toHaveBeenCalled();
    await pool.rotate();
  } else {
    await rotating;
  }
  complete();
  await expect(successor).resolves.toBe("successor");
  expect([workers[0]!.threadId, previousReader, nativeReader]).toEqual([-1, false, true]);
  expect(released).toHaveBeenCalledTimes(retry ? 2 : 1);
});

it.each(["error", "exit", "constructor"] as const)("latches %s until rotation", async (failure) => {
  const { pool, complete, attempts, recover } = createPool({ failure });
  const prepare = vi.fn(() => "input");
  const release = vi.fn();
  const tasks = Array.from({ length: 12 }, () =>
    pool.run(prepare, { inputBytes: 16, onInputConsumed: release }),
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

  recover();
  await pool.rotate();
  const recovered = pool.run("recovered", {});
  complete();
  await expect(recovered).resolves.toBe("recovered");
  expect(attempts()).toBe(2);
});

it("keeps a healthy sibling serving the backlog without repeatedly replacing the failed boot", async () => {
  const { pool, workers, attempts } = createPool({ maxWorkers: 2 });
  const healthy = pool.run("healthy", {});
  const worker = workers[0]!;
  worker.ready();
  const failed = pool.run("failed boot", {});
  const failedResult = expect(failed).rejects.toMatchObject(unavailable);
  const inputs = ["first", "second", "third"];
  const pending = inputs.map((input) => pool.run(input, {}));
  workers[1]!.emit("error", new Error("second worker failed to initialize"));
  await failedResult;
  pending.push(pool.run("newly admitted", {}));
  inputs.push("newly admitted");
  worker.reply();
  await expect(healthy).resolves.toBe("healthy");
  for (const input of inputs) {
    expect(worker.inputs.at(-1)?.input).toBe(input);
    worker.reply();
  }
  await expect(Promise.all(pending)).resolves.toEqual(inputs);
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
  expect(await results).toEqual([rejected, rejected]);
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
  const failedResult = expect(failed).rejects.toMatchObject(unavailable);
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
  workers[1]!.complete("invalid task data");
  await failedResult;
  const recovered = pool.run("valid task", {});
  workers[1]!.reply();
  await expect(recovered).resolves.toBe("valid task");
  expect(attempts()).toBe(2);
});

it("preserves arbitrary worker recovery without a served-protocol readiness requirement", async () => {
  const { pool, workers } = createPool({ requiresReady: false });
  const failed = pool.run("custom worker exits", {});
  const failedResult = expect(failed).rejects.toMatchObject(unavailable);
  const queued = pool.run("custom response", {});
  workers[0]!.emit("exit", 0);
  await failedResult;
  workers[1]!.reply();
  await expect(queued).resolves.toBe("custom response");
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
