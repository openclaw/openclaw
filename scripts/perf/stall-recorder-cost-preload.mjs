// Isolated Gateway instrumentation only; never load in an operator Gateway.
// Pass through transcript-broadcast-measure.ts --gateway-preload <wrapper.mjs>.
// Wrapper: import "./stall-recorder-cost-preload.mjs?interval=25";
// interval=0 disables only the stall recorder; omit interval to observe production.
// Output: STALL_RECORDER_COST JSON each minute (no CPU/heap sampling profiler).
// total_allocated_bytes is V8 main-isolate allocation, not process native allocation.
// Add &proof=1 only for a separate attribution run: inject scoped 300/1000 ms
// crypto stalls 10/30 seconds after whole-soak starts. Never gate latency on it.
import { pbkdf2Sync } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import v8 from "node:v8";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const value = new URL(import.meta.url).searchParams.get("interval");
  const proof = new URL(import.meta.url).searchParams.get("proof") === "1";
  const tasks = proof ? await import("../../src/infra/main-thread-stall.ts") : undefined;
  const interval = value === null ? undefined : Number(value);
  if (interval !== undefined && (!Number.isFinite(interval) || interval < 0)) {
    throw new Error("Invalid recorder interval");
  }
  const start = v8.startCpuProfile;
  const counters = {
    attempts: 0,
    starts: 0,
    stops: 0,
    disposals: 0,
    startMs: 0,
    stopMs: 0,
    bytes: 0,
  };
  v8.startCpuProfile = (options) => {
    if (options?.maxBufferSize !== 1024) {
      throw new Error("Unexpected overlapping profiler invalidates recorder cost measurement");
    }
    counters.attempts++;
    if (interval === 0) {
      throw new Error("Recorder disabled by isolated benchmark");
    }
    const at = performance.now();
    const handle = start(
      interval === undefined ? options : { ...options, sampleInterval: interval },
    );
    counters.startMs += performance.now() - at;
    counters.starts++;
    return {
      stop() {
        const stopAt = performance.now();
        const json = handle.stop();
        counters.stopMs += performance.now() - stopAt;
        counters.stops++;
        counters.bytes += Buffer.byteLength(json);
        return json;
      },
      [Symbol.dispose]() {
        counters.disposals++;
        handle[Symbol.dispose]();
      },
    };
  };
  syncBuiltinESMExports();
  const sample = (phase = "minute") => {
    console.log(
      "STALL_RECORDER_COST " +
        JSON.stringify({
          epochMs: Date.now(),
          atMs: performance.now(),
          phase,
          interval,
          counters,
          cpu: process.threadCpuUsage(),
          memory: process.memoryUsage(),
          heap: v8.getHeapStatistics(),
        }),
    );
  };
  sample("startup");
  setInterval(sample, 60_000).unref();
  process.on("message", (message) => {
    if (message?.channel !== "openclaw-gateway-bench-profile") {
      return;
    }
    if ((message.kind === "cpu" || message.kind === "heap") && message.action === "start") {
      throw new Error("Recorder cost measurement cannot overlap benchmark CPU or heap profiling");
    }
    if (message.kind === "diagnostics") {
      sample(`${message.captureId}:${message.action}`);
      if (tasks && message.captureId === "whole-soak" && message.action === "start") {
        for (const [delayMs, stallMs] of [
          [10_000, 300],
          [30_000, 1_000],
        ]) {
          setTimeout(() => {
            tasks.runWithMainThreadTask("benchmark:synthetic-stall", () => {
              const at = performance.now();
              while (performance.now() - at < stallMs) {
                pbkdf2Sync("synthetic", "synthetic", 10_000, 32, "sha256");
              }
            });
          }, delayMs).unref();
        }
      }
    }
  });
  process.channel?.unref();
  process.once("exit", () => sample("exit"));
}
