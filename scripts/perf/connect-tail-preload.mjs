// Native diagnostics for connect-tail-measure.ts --gateway-preload <this-file>.
// Captures bounded RPC/worker timings and one-second process samples, never message contents.
// Loop p99 values are per interval; they are not a pooled run percentile.
import { channel } from "node:diagnostics_channel";
import { writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
if (isMainThread) {
  const started = performance.now(),
    epochMs = Date.now(),
    records = [],
    samples = [];
  const keys = [
    "method",
    "operation",
    "phase",
    "outcome",
    "kind",
    "requestClass",
    "workerClass",
    "worker",
    "durationMs",
    "queueWaitMs",
    "admissionMs",
    "responseBytes",
    "threadCpuMs",
    "queueMs",
    "preparationMs",
    "hostWaitMs",
    "runMs",
    "transferMs",
    "pendingTasks",
    "pendingBytes",
    "activeTasks",
    "workers",
    "workersCreated",
  ];
  for (const name of ["openclaw.gateway.rpc", "openclaw.worker.task"]) {
    channel(name).subscribe((raw) => {
      if (records.length >= 100000) {
        return;
      }
      const record = { source: name, atMs: performance.now() - started };
      for (const key of keys) {
        if (["number", "string", "boolean"].includes(typeof raw?.[key])) {
          record[key] = raw[key];
        }
      }
      records.push(record);
    });
  }
  const dir = path.dirname(process.argv[1]);
  const file = readdirSync(dir).find((f) => /^worker-request-diagnostics-.*\.mjs$/.test(f));
  if (file) {
    const module = await import(path.join(dir, file));
    const subscribe = Object.values(module).find(
      (v) => typeof v === "function" && v.name === "onWorkerRequestMetrics",
    );
    if (subscribe) {
      subscribe((kind, requestClass, phase, queueDepth, queueWaitMs, durationMs, timing) => {
        if (records.length < 100000) {
          records.push({
            source: "worker.request",
            atMs: performance.now() - started,
            kind,
            requestClass,
            phase,
            queueDepth,
            queueWaitMs,
            durationMs,
            timing: { ...timing },
          });
        }
      });
    }
  }
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let gcMs = 0,
    gcCount = 0,
    cpu = process.threadCpuUsage(),
    at = performance.now();
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      gcMs += e.duration;
      gcCount++;
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const timer = setInterval(() => {
    const now = performance.now(),
      used = process.threadCpuUsage(cpu);
    cpu = process.threadCpuUsage();
    samples.push({
      atMs: now - started,
      durationMs: now - at,
      cpuMs: (used.user + used.system) / 1000,
      gcMs,
      gcCount,
      loopP99Ms: loop.percentile(99) / 1e6,
      loopMaxMs: loop.max / 1e6,
      ...process.memoryUsage(),
    });
    gcMs = 0;
    gcCount = 0;
    at = now;
    loop.reset();
  }, 1000);
  timer.unref();
  process.on("exit", () => {
    clearInterval(timer);
    observer.disconnect();
    loop.disable();
    writeFileSync(
      path.join(path.dirname(process.env.OPENCLAW_CONFIG_PATH), "telemetry.json"),
      JSON.stringify({
        started,
        epochMs,
        durationMs: performance.now() - started,
        records,
        samples,
      }),
    );
  });
}
