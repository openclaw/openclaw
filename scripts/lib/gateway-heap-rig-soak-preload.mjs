// Rig-only IPC. Keep the heap domain alive across native snapshots so object IDs
// remain comparable. No allocation tracing or forced GC between checkpoints.
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { getHeapSpaceStatistics, writeHeapSnapshot } from "node:v8";
import { isMainThread } from "node:worker_threads";

if (isMainThread && process.send) {
  const inspector = new Session();
  inspector.connect();
  await inspector.post("HeapProfiler.enable");
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let gcMs = 0;
  let gcCount = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcMs += entry.duration;
      gcCount++;
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  let cpu = process.threadCpuUsage();
  let startedAt = performance.now();
  process.on("message", (message) => {
    if (message?.channel !== "heap-rig-retention") {
      return;
    }
    try {
      const path = message.snapshotPath ? writeHeapSnapshot(message.snapshotPath) : undefined;
      const now = performance.now();
      const used = process.threadCpuUsage(cpu);
      const observation = {
        pid: process.pid,
        atEpochMs: Date.now(),
        elapsedMs: now - startedAt,
        cpuMs: (used.user + used.system) / 1000,
        memory: process.memoryUsage(),
        spaces: getHeapSpaceStatistics(),
        hostLoad: loadavg(),
        gcMs,
        gcCount,
        loopP99Ms: loop.percentile(99) / 1e6,
        loopSamples: loop.count,
        path,
      };
      process.send?.({ channel: message.channel, id: message.id, observation });
      cpu = process.threadCpuUsage();
      startedAt = performance.now();
      gcMs = 0;
      gcCount = 0;
      loop.reset();
    } catch (error) {
      process.send?.({ channel: message.channel, id: message.id, error: String(error) });
    }
  });
  process.channel?.unref();
}
