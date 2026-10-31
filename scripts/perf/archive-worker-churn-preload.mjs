// Optional V8 accounting for archive-worker-churn-measure.ts; never loaded by production.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { GCProfiler, getHeapStatistics } from "node:v8";
import { isMainThread, parentPort, threadId, workerData } from "node:worker_threads";

const output = process.env.OPENCLAW_ARCHIVE_CHURN_PROFILE_DIR;
if (!isMainThread && output && workerData?.type === "sqlite-transcript-archive-v2") {
  const profiler = new GCProfiler();
  const started = performance.now();
  const cpu = process.threadCpuUsage();
  const memory = process.memoryUsage();
  const allocated = getHeapStatistics().total_allocated_bytes;
  let first = true;
  let reclaimedBytes = 0;
  let gcMicroseconds = 0;
  let collections = 0;
  profiler.start();
  const record = (phase) => {
    const used = process.threadCpuUsage(cpu);
    const current = process.memoryUsage();
    const profile = profiler.stop();
    for (const collection of profile.statistics) {
      reclaimedBytes +=
        collection.beforeGC.heapStatistics.usedHeapSize -
        collection.afterGC.heapStatistics.usedHeapSize;
      gcMicroseconds += collection.cost;
      collections++;
    }
    writeFileSync(
      path.join(output, `${threadId}-${phase}.json`),
      JSON.stringify({
        threadId,
        operation: workerData.operation,
        phase,
        elapsedMs: performance.now() - started,
        threadCpuMs: (used.user + used.system) / 1000,
        estimatedV8AllocatedBytes: current.heapUsed - memory.heapUsed + reclaimedBytes,
        v8AllocatedBytes: getHeapStatistics().total_allocated_bytes - allocated,
        reclaimedBytes,
        gcMs: gcMicroseconds / 1000,
        collections,
        heapUsedBytes: current.heapUsed,
        heapDeltaBytes: current.heapUsed - memory.heapUsed,
        processRssDeltaBytes: current.rss - memory.rss,
      }),
    );
    if (phase === "first-result") {
      profiler.start();
    }
  };
  const post = parentPort.postMessage.bind(parentPort);
  parentPort.postMessage = (...args) => {
    if (first && Array.isArray(args[0]?.results)) {
      first = false;
      record("first-result");
    }
    return post(...args);
  };
  process.once("beforeExit", () => record("exit"));
}
