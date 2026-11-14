// Optional preload for the isolated restart-lane harness; never load in an operator Gateway.
// OPENCLAW_PERF_RESTART_METRICS_DIR must name an existing private evidence directory.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

if (isMainThread) {
  const directory = process.env.OPENCLAW_PERF_RESTART_METRICS_DIR;
  assert(directory, "Restart metrics require an explicit evidence directory");
  const { onDiagnosticEvent } = await import("../../src/infra/diagnostic-events.ts");
  const inspector = new Session();
  await startCollectedHeapSampling(inspector, 32_768);
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.start");
  const started = performance.now();
  const processCpu = process.cpuUsage();
  const threadCpu = process.threadCpuUsage();
  const hostLoad = loadavg();
  const dequeues: Array<{ lane: string; waitMs: number; queueSize: number; atMs: number }> = [];
  const unsubscribe = onDiagnosticEvent((event) => {
    if (
      event.type === "queue.lane.dequeue" &&
      (event.lane === "cron-nested" || event.lane === "restart-recovery")
    ) {
      dequeues.push({
        lane: event.lane,
        waitMs: event.waitMs,
        queueSize: event.queueSize,
        atMs: performance.now() - started,
      });
    }
  });
  const writeMetrics = async () => {
    unsubscribe();
    const usedProcess = process.cpuUsage(processCpu);
    const usedThread = process.threadCpuUsage(threadCpu);
    const wallMs = performance.now() - started;
    const { profile: allocations } = await inspector.post("HeapProfiler.stopSampling");
    const { profile: cpu } = await inspector.post("Profiler.stop");
    inspector.disconnect();
    const prefix = path.join(directory, String(process.pid));
    writeFileSync(`${prefix}.cpuprofile`, JSON.stringify(cpu));
    writeFileSync(`${prefix}.heapprofile`, JSON.stringify(allocations));
    writeFileSync(
      `${prefix}.json`,
      JSON.stringify({
        pid: process.pid,
        scope:
          "Gateway startup through workload checkpoint; process CPU includes workers; allocation sampling and CPU profile cover main isolate only",
        wallMs,
        processCpuMs: (usedProcess.user + usedProcess.system) / 1000,
        threadCpuMs: (usedThread.user + usedThread.system) / 1000,
        sampledAllocationBytes: sumSampledHeapBytes(allocations.head),
        maxRssKiB: process.resourceUsage().maxRSS,
        hostLoad,
        dequeues,
      }),
    );
  };
  let capturing = false;
  const capture = () => {
    if (capturing) {
      return;
    }
    capturing = true;
    void writeMetrics().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  // This headless fixture owns SIGWINCH; Gateway restart signals retain their owners.
  process.once("SIGWINCH", capture);
  process.once("beforeExit", capture);
}
