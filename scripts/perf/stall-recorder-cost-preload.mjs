// Isolated Gateway instrumentation only; never load in an operator Gateway.
// Pass through transcript-broadcast-measure.ts --gateway-preload <wrapper.mjs>.
// Wrapper: import "./stall-recorder-cost-preload.mjs?interval=25";
// interval=0 disables native recorder starts; omit interval to observe production.
// mode=inspector starts one experimental 10 ms inspector CPU profile before boot,
// stopping at whole-soak:stop or watchdogMs (default 120000). Use a caller timeout
// too: V8's inspector sample buffer is uncapped and its calls can block the timer.
// Output: STALL_RECORDER_COST JSON each minute; inspector costs have separate phases.
// total_allocated_bytes is V8 main-isolate allocation, not process native allocation.
// Add &proof=1 only for a separate attribution run: inject scoped 300/1000 ms
// crypto stalls 10/30 seconds after whole-soak starts. proof=interrupt injects
// one unscoped 1200 ms JS spin after 5 seconds. Never gate latency on either.
import { pbkdf2Sync } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import v8 from "node:v8";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const params = new URL(import.meta.url).searchParams;
  const value = params.get("interval");
  const proof = params.get("proof");
  const mode = params.get("mode");
  const watchdogMs = Number(params.get("watchdogMs") ?? 120_000);
  if (mode !== null && mode !== "inspector") {
    throw new Error("Invalid recorder cost mode");
  }
  if (mode === "inspector" && (!Number.isFinite(watchdogMs) || watchdogMs <= 0)) {
    throw new Error("Invalid inspector watchdog duration");
  }
  const tasks = proof === "1" ? await import("../../src/infra/main-thread-stall.ts") : undefined;
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
  const sample = (phase = "minute", inspector = null) => {
    console.log(
      "STALL_RECORDER_COST " +
        JSON.stringify({
          epochMs: Date.now(),
          atMs: performance.now(),
          phase,
          interval,
          ...(mode ? { mode } : {}),
          ...(inspector ? { inspector } : {}),
          counters,
          cpu: process.threadCpuUsage(),
          processCpu: process.cpuUsage(),
          memory: process.memoryUsage(),
          heap: v8.getHeapStatistics(),
        }),
    );
  };
  sample("startup");
  let stopInspector;
  if (mode === "inspector") {
    // Node's --cpu-prof uses these same inspector commands. This is an experiment,
    // not a production fallback; cold startup and profile extraction are separate.
    const { Session } = await import("node:inspector");
    const session = new Session();
    session.connect();
    const post = (method, parameters) =>
      new Promise((resolve, reject) => {
        session.post(method, parameters, (error, result) => {
          if (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          } else {
            resolve(result);
          }
        });
      });
    let stopping = false;
    const watchdog = setTimeout(() => void stopInspector("watchdog"), watchdogMs);
    watchdog.unref();
    stopInspector = async (reason) => {
      if (stopping) {
        return;
      }
      stopping = true;
      clearTimeout(watchdog);
      const at = performance.now();
      try {
        const { profile } = await post("Profiler.stop");
        const stopExtractMs = performance.now() - at;
        const serializeAt = performance.now();
        const serializedBytes = Buffer.byteLength(JSON.stringify(profile));
        sample("inspector:stopped", {
          reason,
          stopExtractMs,
          serializeMs: performance.now() - serializeAt,
          samples: profile.samples?.length ?? 0,
          nodes: profile.nodes.length,
          serializedBytes,
        });
      } catch (error) {
        sample("inspector:error", { reason, message: String(error) });
      } finally {
        session.disconnect();
      }
    };
    try {
      const at = performance.now();
      await post("Profiler.enable");
      await post("Profiler.setSamplingInterval", { interval: 10_000 });
      const enableMs = performance.now() - at;
      const startAt = performance.now();
      await post("Profiler.start");
      sample("inspector:started", {
        enableMs,
        startMs: performance.now() - startAt,
        samplingIntervalMicros: 10_000,
        watchdogMs,
      });
    } catch (error) {
      clearTimeout(watchdog);
      session.disconnect();
      throw error;
    }
    process.once("beforeExit", () => void stopInspector("before-exit"));
    process.once("exit", () => session.disconnect());
  }
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
      if (message.captureId === "whole-soak" && message.action === "stop") {
        void stopInspector?.("whole-soak");
      }
      if (
        proof === "interrupt" &&
        message.captureId === "whole-soak" &&
        message.action === "start"
      ) {
        void import("../../src/logging/diagnostic-stall-cpu.test-support.ts").then(
          ({ stallCpuOwner }) => {
            setTimeout(() => stallCpuOwner(1_200), 5_000).unref();
          },
        );
      }
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
