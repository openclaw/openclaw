// Benchmark-only supplement for transcript-broadcast-measure.ts --scenario memory-soak.
// See provider-rate-limit-retention.md. Primary runs measure CPU/memory without an inspector.
// OPENCLAW_RATE_LIMIT_STRESS_ALLOCATION=1 adds one 30-second allocation window, separately.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  assert(process.send && process.env.OPENCLAW_STATE_DIR, "Requires an owned benchmark Gateway");
  const allocation = process.env.OPENCLAW_RATE_LIMIT_STRESS_ALLOCATION === "1";
  const output = path.join(
    process.env.OPENCLAW_STATE_DIR,
    allocation ? "stress-allocation-probe.json" : "stress-probe.json",
  );
  const report = { allocation, allocationWindows: [], errors: [], samples: [] };
  let sampleTimer;
  let allocationTimer;
  let sampling = false;
  let beforeCpu;
  let started;
  const persist = () => writeFileSync(output, JSON.stringify(report, null, 2));
  const sample = () =>
    report.samples.push({ elapsedMs: performance.now() - started, memory: process.memoryUsage() });

  async function captureAllocation() {
    const inspector = new Session();
    inspector.connect();
    sampling = true;
    const windowStarted = performance.now();
    try {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 30_000);
      });
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const durationMs = performance.now() - windowStarted;
      const sampledBytes = profile.samples.reduce((sum, entry) => sum + entry.size, 0);
      report.allocationWindows.push({
        durationMs,
        sampledBytes,
        sampledMiBPerSecond: sampledBytes / 1048576 / (durationMs / 1000),
      });
    } catch (error) {
      report.errors.push(String(error));
    } finally {
      sampling = false;
      inspector.disconnect();
      persist();
    }
  }

  process.on("message", (message) => {
    if (
      message?.channel !== "openclaw-gateway-bench-profile" ||
      message.kind !== "diagnostics" ||
      message.captureId !== "whole-soak"
    ) {
      return;
    }
    if (message.action === "start") {
      started = performance.now();
      beforeCpu = process.threadCpuUsage();
      report.startedAtEpochMs = Date.now();
      sample();
      sampleTimer = setInterval(sample, 5000);
      if (allocation) {
        allocationTimer = setTimeout(() => void captureAllocation(), 5000);
      }
    } else if (message.action === "stop") {
      const cpu = process.threadCpuUsage(beforeCpu);
      report.elapsedMs = performance.now() - started;
      report.mainThreadCpuMs = (cpu.user + cpu.system) / 1000;
      report.mainThreadCpuPercent = (report.mainThreadCpuMs / report.elapsedMs) * 100;
      clearInterval(sampleTimer);
      clearTimeout(allocationTimer);
      sample();
      if (sampling) {
        report.errors.push("Load ended during an allocation window");
      }
      persist();
    }
  });
  process.channel?.unref();
}
