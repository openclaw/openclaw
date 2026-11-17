import { createHook } from "node:async_hooks";
import { getHeapStatistics } from "node:v8";
import { Worker } from "node:worker_threads";

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
  let segmentStart = 0;
  const finishSegment = () => {
    if (current) {
      current.maxSyncMs = Math.max(current.maxSyncMs, performance.now() - segmentStart);
    }
  };
  const hook = createHook({
    before() {
      segmentStart = performance.now();
    },
    after: finishSegment,
  }).enable();
  // Saved for restoration; every invocation below supplies the original Worker receiver.
  // oxlint-disable-next-line typescript/unbound-method
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, transfers) {
    if (current && message && typeof message === "object") {
      const buffers = [message.input, ...Object.values(message.transferredInput ?? {})];
      for (const value of buffers) {
        if (value instanceof Uint8Array) {
          if (Array.isArray(transfers) && transfers.includes(value.buffer)) {
            current.transferredBytes += value.byteLength;
          } else {
            current.clonedBytes += value.byteLength;
          }
        }
      }
    }
    return post.call(this, message, transfers);
  };
  return {
    samples,
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
      current = {
        packBytes,
        elapsedMs: 0,
        maxSyncMs: 0,
        mainCpuMs: 0,
        allocatedBytes: 0,
        serializedBytes: 0,
        transferredBytes: 0,
        clonedBytes: 0,
      };
      try {
        return await run();
      } finally {
        finishSegment();
        const used = process.threadCpuUsage(cpu);
        current.mainCpuMs = (used.user + used.system) / 1000;
        current.elapsedMs = performance.now() - started;
        current.allocatedBytes = getHeapStatistics().total_allocated_bytes - allocated;
        samples.push(current);
        current = undefined;
      }
    },
    close() {
      hook.disable();
      Worker.prototype.postMessage = post;
    },
  };
}
