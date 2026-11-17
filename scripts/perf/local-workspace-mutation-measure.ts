import { getHeapStatistics } from "node:v8";
import type { Worker } from "node:worker_threads";
import type { SqliteWorkerRequest } from "../../src/infra/sqlite-worker-contract.js";

type Sample = {
  packBytes: number;
  elapsedMs: number;
  maxSyncMs: number;
  mainCpuMs: number;
  allocatedBytes: number;
  serializedBytes: number;
  transferredBytes: number;
  clonedBytes: number;
};

/** Observe the real mutation window without inspecting or decoding its payload. */
export function observeLocalWorkspaceMutations() {
  const samples: Sample[] = [];
  let current: Sample | undefined;
  return {
    samples,
    postMessage(
      worker: Worker,
      message: SqliteWorkerRequest,
      transfers: Parameters<Worker["postMessage"]>[1],
    ) {
      if (current) {
        const buffers = [
          "input" in message ? message.input : undefined,
          ...Object.values(message.transferredInput ?? {}),
        ];
        for (const value of buffers) {
          if (value instanceof Uint8Array) {
            if (transfers?.includes(value.buffer)) {
              current.transferredBytes += value.byteLength;
            } else {
              current.clonedBytes += value.byteLength;
            }
          }
        }
      }
      worker.postMessage(message, transfers);
    },
    serialized(bytes: number) {
      if (current) {
        current.serializedBytes += bytes;
      }
    },
    async run<T>(packBytes: number, run: () => Promise<T>): Promise<T> {
      if (packBytes < 1024 * 1024) {
        return run();
      }
      if (current) {
        throw new Error("Mutation measurement requires serial requests");
      }
      const started = performance.now();
      const cpu = process.threadCpuUsage();
      const allocated = getHeapStatistics().total_allocated_bytes;
      const sample: Sample = {
        packBytes,
        elapsedMs: 0,
        maxSyncMs: 0,
        mainCpuMs: 0,
        allocatedBytes: 0,
        serializedBytes: 0,
        transferredBytes: 0,
        clonedBytes: 0,
      };
      current = sample;
      let lastTick = started;
      const timer = setInterval(() => {
        const now = performance.now();
        sample.maxSyncMs = Math.max(sample.maxSyncMs, now - lastTick);
        lastTick = now;
      }, 1);
      try {
        return await run();
      } finally {
        const used = process.threadCpuUsage(cpu);
        sample.mainCpuMs = (used.user + used.system) / 1000;
        sample.elapsedMs = performance.now() - started;
        sample.allocatedBytes = getHeapStatistics().total_allocated_bytes - allocated;
        // Let the timer observe the final callback and its entire microtask drain.
        // This is an upper bound including the timer's 1 ms resolution.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 2);
        });
        clearInterval(timer);
        samples.push(sample);
        current = undefined;
      }
    },
  };
}
