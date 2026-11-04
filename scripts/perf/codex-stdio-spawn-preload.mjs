// Benchmark-only injection: delay the synchronous spawn call, then execute the real child.
// NODE_OPTIONS loads this in both the measured host and its real transport Worker.
import childProcess from "node:child_process";
import { Session } from "node:inspector";
import { syncBuiltinESMExports } from "node:module";
import { isMainThread, parentPort } from "node:worker_threads";

let calls = 0;
let blockedMs = 0;
export const readSpawnProbe = () => ({ calls, blockedMs });

if (process.env.OPENCLAW_STDIO_BENCH_SAMPLE === "1") {
  const started = process.threadCpuUsage();
  const initialHeapBytes = process.memoryUsage().heapUsed;
  let peakHeapBytes = initialHeapBytes;
  const inspector =
    !isMainThread && process.env.OPENCLAW_STDIO_BENCH_ALLOCATION === "1"
      ? new Session()
      : undefined;
  inspector?.connect();
  inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const memoryTimer = !isMainThread
    ? setInterval(() => {
        peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
      }, 10)
    : undefined;
  memoryTimer?.unref();
  const nativeSpawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    // Unrelated runtime helpers and the orchestrator are never delayed.
    if (
      !Array.isArray(args[1]) ||
      !args[1].some((arg) => arg.includes("CODEX_STDIO_BENCH_CHILD"))
    ) {
      return Reflect.apply(nativeSpawn, childProcess, args);
    }
    calls++;
    const before = performance.now();
    const delayMs = Number(process.env.OPENCLAW_STDIO_BENCH_DELAY_MS ?? 0);
    if (delayMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
    blockedMs += performance.now() - before;
    const child = Reflect.apply(nativeSpawn, childProcess, args);
    if (!isMainThread) {
      child.once("close", () => {
        clearInterval(memoryTimer);
        const cpu = process.threadCpuUsage(started);
        const heapBytes = process.memoryUsage().heapUsed;
        const report = (allocationBytes) =>
          parentPort?.postMessage(
            {
              type: "codex-stdio-benchmark",
              calls,
              blockedMs,
              cpuMs: (cpu.user + cpu.system) / 1000,
              initialHeapBytes,
              peakHeapBytes: Math.max(peakHeapBytes, heapBytes),
              finalHeapBytes: heapBytes,
              sampledAllocationBytes: allocationBytes,
            },
            [],
          );
        if (inspector) {
          inspector.post("HeapProfiler.stopSampling", (error, result) => {
            const sum = (node) =>
              node.selfSize + node.children.reduce((total, next) => total + sum(next), 0);
            report(error ? null : sum(result.profile.head));
            inspector.disconnect();
          });
        } else {
          report(null);
        }
      });
    }
    return child;
  };
  syncBuiltinESMExports();
}
