// Diagnostic companion for gateway-shutdown-sweep-measure.ts. No IPC or referenced timers.
import { appendFileSync } from "node:fs";
import { Session } from "node:inspector";
import { loadavg } from "node:os";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const output = `${process.env.OPENCLAW_SHUTDOWN_MEASURE_OUTPUT}/resources.jsonl`;
  let start;
  let cpu;
  let inspector;
  let sampledBytes;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  const gc = [];
  const collectGc = (entries) => {
    if (start !== undefined) {
      gc.push(
        ...entries
          .filter((entry) => entry.startTime >= start)
          .map((entry) => ({
            kind: entry.detail.kind,
            durationMs: entry.duration,
          })),
      );
    }
  };
  const observer = new PerformanceObserver((list) => collectGc(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  function sample(phase) {
    const owner = globalThis[Symbol.for("openclaw.gatewayWorkAdmissionState")];
    appendFileSync(
      output,
      JSON.stringify({
        phase,
        at: Date.now(),
        elapsedMs: start === undefined ? null : performance.now() - start,
        roots: [...(owner?.activeRootWork ?? [])].map(({ origin, references }) => ({
          origin,
          references,
        })),
        mutations: [
          ...(globalThis[Symbol.for("openclaw.sessionControllers")]?.controllers?.values() ?? []),
        ].flatMap((entry) =>
          [...(entry.lifecycle?.mutations ?? [])].map((mutation) => ({
            key: entry.key,
            kind: mutation.kind,
            phase: mutation.phase,
          })),
        ),
        threadCpu: start === undefined ? null : process.threadCpuUsage(cpu),
        memory: process.memoryUsage(),
        hostLoad: loadavg(),
        resources: process.getActiveResourcesInfo(),
        ...(phase === "exit"
          ? { gc, loopSamples: loop.count, loopP99Ms: loop.percentile(99) / 1e6, sampledBytes }
          : {}),
      }) + "\n",
    );
  }
  setInterval(() => sample("running"), 5000).unref();
  process.once("SIGTERM", () => {
    start = performance.now();
    cpu = process.threadCpuUsage();
    loop.enable();
    if (process.env.OPENCLAW_SHUTDOWN_MEASURE_ALLOCATIONS === "1") {
      inspector = new Session();
      inspector.connect();
      inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    sample("signal");
  });
  process.on("exit", () => {
    if (inspector) {
      inspector.post("HeapProfiler.stopSampling", (error, result) => {
        if (!error) {
          const sum = (node) =>
            node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
          sampledBytes = sum(result.profile.head);
        }
      });
      inspector.disconnect();
    }
    loop.disable();
    collectGc(observer.takeRecords());
    observer.disconnect();
    sample("exit");
  });
}
