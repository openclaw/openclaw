// Benchmark-only worker allocation sampling, including objects collected by GC.
// --import 'file:///absolute/path/to/this.mjs?directory=/absolute/output&interval=1000'
// Profiles cover each worker lifetime, including bootstrap. Sampling ends at the
// recorded cutoff; an abrupt terminate can omit the final interval. Keep allocation
// runs separate from timing and allow an interval before closing workers.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import workerThreads, { isMainThread, threadId } from "node:worker_threads";

const params = new URL(import.meta.url).searchParams;
const directory = params.get("directory");
assert(directory && path.isAbsolute(directory), "Profile directory must be absolute");
const interval = Number(params.get("interval") ?? 1000);
assert(Number.isSafeInteger(interval) && interval >= 100);
const NativeWorker = workerThreads.Worker;
workerThreads.Worker = class extends NativeWorker {
  constructor(filename, options = {}) {
    const execArgv = options.execArgv ?? process.execArgv;
    super(filename, {
      ...options,
      execArgv: execArgv.includes(import.meta.url)
        ? execArgv
        : [...execArgv, "--import", import.meta.url],
    });
  }
};
syncBuiltinESMExports();

// The benchmark itself controls warm main-thread sampling independently.
if (!isMainThread) {
  mkdirSync(directory, { recursive: true });
  const inspector = new Session();
  inspector.connect();
  const startedAt = Date.now();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  let pending;
  const flush = () =>
    (pending ??= inspector
      .post("HeapProfiler.getSamplingProfile")
      .then(({ profile }) => {
        writeFileSync(
          path.join(directory, `worker-${process.pid}-${threadId}.heapprofile`),
          JSON.stringify({
            pid: process.pid,
            threadId,
            startedAt,
            capturedAt: Date.now(),
            profile,
          }),
        );
      })
      .finally(() => {
        pending = undefined;
      }));
  const timer = setInterval(() => {
    void flush().catch((error) => console.error("Worker allocation profile failed", error));
  }, interval);
  timer.unref();
  process.once("beforeExit", () => {
    clearInterval(timer);
    void flush().finally(() => inspector.disconnect());
  });
}
