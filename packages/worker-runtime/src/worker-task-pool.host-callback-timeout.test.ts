import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkerLifecycle } from "./worker-lifecycle.js";
import { createWorkerComputeCapacity } from "./worker-task-capacity.js";
import type { WorkerTaskHost } from "./worker-task-host.js";
import { WorkerTaskPoolCore } from "./worker-task-pool-core.js";
import type { WorkerTaskResponse } from "./worker-task-pool.types.js";

class FixtureWorker extends EventEmitter implements WorkerLifecycle {
  threadId: number;
  lastRequestId = 0;
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
    this.inputs.push({ taskId: (value as { taskId: number }).taskId, input: value });
  }

  ready() {
    this.emit("message", { status: "ready" });
  }

  private task() {
    const task = this.inputs.at(-1);
    if (!task) {
      throw new Error("No worker task was dispatched");
    }
    return task.taskId;
  }

  request(id: number, value: unknown) {
    const taskId = this.task();
    if (id > 1) {
      this.emit("message", { status: "consumed", taskId, id: id - 1 });
    }
    this.lastRequestId = id;
    this.emit("message", { status: "request", taskId, id, value });
  }

  reply(value: unknown) {
    const taskId = this.task();
    if (this.lastRequestId > 0) {
      this.emit("message", { status: "consumed", taskId, id: this.lastRequestId });
    }
    this.emit("message", { status: "ok", taskId, value });
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
  await Promise.all(pools.splice(0).map((pool) => pool.close().catch(() => undefined)));
});

function createPool() {
  const workers: FixtureWorker[] = [];
  const host: WorkerTaskHost = {
    requiresReady: true,
    createWorker() {
      const worker = new FixtureWorker(workers.length + 1);
      workers.push(worker);
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
    { workerUrl: new URL("file:///synthetic-worker.mjs"), maxWorkers: 1, idleTimeoutMs: 5_000 },
    host,
  );
  pools.push(pool);
  return { pool, workers };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

it("times out a deadline-less streaming task whose host request handler never settles", async () => {
  const { pool, workers } = createPool();
  const never = new Promise<WorkerTaskResponse>(() => {});
  const task = pool.run("stream", {
    hostCallbackTimeoutMs: 30,
    onRequest: () => never,
  });
  const worker = workers[0]!;
  worker.ready();
  worker.request(1, { kind: "export-chunk" });
  await expect(task).rejects.toMatchObject({
    code: "timeout",
    message: "worker task timed out waiting for host callback export-chunk",
  });
  // Cancellation must reach the parked worker so it can unwind and release pinned resources.
  await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalled());
  await pool.close();
});

it("does not let the host-callback watchdog cap a healthy multi-chunk stream", async () => {
  const { pool, workers } = createPool();
  const chunks = 6;
  let served = 0;
  const task = pool.run("stream", {
    hostCallbackTimeoutMs: 200,
    async onRequest() {
      served += 1;
      await sleep(25); // slower per phase than the tightest watchdog used above
      return { input: null, timeoutMs: 5_000 };
    },
  });
  const worker = workers[0]!;
  worker.ready();
  worker.request(1, { kind: "export-chunk" });
  for (let id = 1; id < chunks; id += 1) {
    await vi.waitFor(() => expect(served).toBe(id));
    // The host response resumes the worker; it then streams its next chunk.
    await sleep(30);
    worker.request(id + 1, { kind: "export-chunk" });
  }
  await vi.waitFor(() => expect(served).toBe(chunks));
  worker.reply("streamed");
  await expect(task).resolves.toBe("streamed");
  expect(worker.terminate).not.toHaveBeenCalled();
  await pool.close();
});

it("keeps owner-managed host waits unbounded when hostTimeout is owner", async () => {
  const { pool, workers } = createPool();
  const never = new Promise<WorkerTaskResponse>(() => {});
  let rejected = false;
  const task = pool.run("approval", { hostTimeout: "owner", onRequest: () => never });
  void task.catch(() => {
    rejected = true;
  });
  const worker = workers[0]!;
  worker.ready();
  worker.request(1, { kind: "approval-request" });
  await sleep(60);
  expect(rejected).toBe(false);
  expect(worker.terminate).not.toHaveBeenCalled();
  await pool.close();
  await expect(task).rejects.toMatchObject({ code: "unavailable" });
});

it("lets an explicit task deadline remain the authority over the watchdog", async () => {
  const { pool, workers } = createPool();
  const never = new Promise<WorkerTaskResponse>(() => {});
  const task = pool.run("bounded", {
    timeoutMs: 30,
    hostCallbackTimeoutMs: 5_000,
    onRequest: () => never,
  });
  const worker = workers[0]!;
  worker.ready();
  worker.request(1, { kind: "bounded-chunk" });
  await expect(task).rejects.toMatchObject({ code: "timeout" });
  await pool.close();
});
