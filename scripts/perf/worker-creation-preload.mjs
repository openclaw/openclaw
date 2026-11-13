// Benchmark-only constructor attribution. Use transcript-broadcast-measure.ts
// --worker-creation-counts in a separate counting pass, never latency/GC gates.
// Records bounded operation labels and timings, never worker payloads or paths.
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import workerThreads from "node:worker_threads";

const output = process.env.OPENCLAW_BENCH_WORKER_CREATION_FILE;
if (workerThreads.isMainThread && output) {
  const NativeWorker = workerThreads.Worker;
  const archiveOperations = new Set([
    "archive-session",
    "canonical-validation-pool",
    "materialize",
    "publish",
    "cold-prepare",
    "maintenance-size",
    "cold-mutate",
    "reclaim",
  ]);
  workerThreads.Worker = class extends NativeWorker {
    constructor(filename, options) {
      const startedAt = performance.now();
      const cpu = process.threadCpuUsage();
      super(filename, options);
      const elapsedMs = performance.now() - startedAt;
      const cpuUsed = process.threadCpuUsage(cpu);
      const operation = options?.workerData?.operation;
      appendFileSync(
        output,
        `${JSON.stringify({
          epochMs: performance.timeOrigin + startedAt,
          threadId: this.threadId,
          script: options?.eval ? "eval" : path.basename(String(filename)),
          operation: archiveOperations.has(operation) ? operation : undefined,
          elapsedMs,
          cpuMicros: cpuUsed.user + cpuUsed.system,
        })}\n`,
      );
    }
  };
  syncBuiltinESMExports();
}
