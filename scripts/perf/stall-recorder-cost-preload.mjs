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
// proof=interrupt-periodic adds six such spins, 10 seconds apart, for a 60 s run.
import { pbkdf2Sync } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import v8 from "node:v8";
import { isMainThread } from "node:worker_threads";

// Isolated follow-up only: interrupts=measure|noop|off instruments the built
// observer worker. Never wrap the main capture function: that changes its frames.
const interruptMode = new URL(import.meta.url).searchParams.get("interrupts");
if (interruptMode !== null) {
  if (!["measure", "noop", "off"].includes(interruptMode)) {
    throw new Error("Invalid benchmark interrupt mode");
  }
  const workerThreads = (await import("node:worker_threads")).default;
  const { pathToFileURL } = await import("node:url");
  const observer = isMainThread
    ? new URL("./logging/diagnostic-stall-observer.worker.js", pathToFileURL(process.argv[1]))
    : new URL(new URL(import.meta.url).searchParams.get("observerUrl") ?? import.meta.url);
  if (isMainThread) {
    const workerPreload = new URL(import.meta.url);
    workerPreload.searchParams.set("observerUrl", observer.href);
    const NativeWorker = workerThreads.Worker;
    workerThreads.Worker = class extends NativeWorker {
      constructor(filename, options) {
        super(
          filename,
          String(filename) === observer.href
            ? {
                ...options,
                execArgv: [...(options?.execArgv ?? []), "--import", workerPreload.href],
              }
            : options,
        );
      }
    };
    syncBuiltinESMExports();
  } else if (process.argv[1] && pathToFileURL(process.argv[1]).href === observer.href) {
    const { Session } = await import("node:inspector/promises");
    const { writeSync } = await import("node:fs");
    const { workerData, threadId } = workerThreads;
    const now = () => performance.now() + (performance.timeOrigin - workerData.timeOrigin);
    const emit = (row) =>
      writeSync(
        2,
        "STALL_INTERRUPT_COST " + JSON.stringify({ mode: interruptMode, threadId, ...row }) + "\n",
      );
    emit({ event: "ready", atMs: now() });
    const sampleObserver = () =>
      emit({
        event: "observer",
        atMs: now(),
        cpu: process.threadCpuUsage(),
        heapUsed: process.memoryUsage().heapUsed,
      });
    sampleObserver();
    setInterval(sampleObserver, 10_000).unref();
    const heartbeat = new BigInt64Array(workerData.heartbeat);
    const records = new WeakMap();
    let attempts = 0;
    // These originals always receive their Session explicitly through .call(this) below.
    const { connectToMainThread: connect, post, disconnect } = Session.prototype;
    Session.prototype.connectToMainThread = function () {
      const row = { attempt: ++attempts, atMs: now(), failed: 0 };
      records.set(this, row);
      emit({ event: "start", ...row });
      const at = performance.now();
      try {
        if (interruptMode !== "off") {
          connect.call(this);
        }
      } catch (error) {
        row.failed = 1;
        throw error;
      } finally {
        row.connectCallMs = performance.now() - at;
      }
    };
    Session.prototype.post = async function (method, parameters) {
      const row = records.get(this);
      const at = now();
      row.postAtMs = at;
      const beat = Atomics.load(heartbeat, 0);
      row.captureRequest = Number(
        parameters?.expression ===
          'globalThis[Symbol.for("openclaw.stallFlightRecorder.capture")]?.()',
      );
      try {
        const result =
          interruptMode === "off"
            ? { result: { type: "undefined" } }
            : await post.call(
                this,
                method,
                interruptMode === "noop" && row.captureRequest
                  ? { ...parameters, expression: "undefined" }
                  : parameters,
              );
        const snapshot = result.result?.value;
        row.captureMs = snapshot?.captureMs ?? null;
        row.dispatchMs = snapshot?.endedAt === undefined ? null : snapshot.endedAt - at;
        row.sampleCount = snapshot?.stacks?.length ?? 0;
        row.frameCount = snapshot?.stacks?.[0]?.frames?.length ?? 0;
        row.late = Number((row.dispatchMs ?? 0) > 100);
        row.exception = Number(Boolean(result.exceptionDetails));
        return result;
      } catch (error) {
        row.failed = 1;
        throw error;
      } finally {
        row.roundTripMs = now() - at;
        row.heartbeatChanged = Number(Atomics.load(heartbeat, 0) !== beat);
      }
    };
    Session.prototype.disconnect = function () {
      const row = records.get(this);
      const at = performance.now();
      try {
        if (interruptMode !== "off") {
          disconnect.call(this);
        }
      } finally {
        row.disconnectCallMs = performance.now() - at;
        emit({ event: "end", ...row });
        records.delete(this);
      }
    };
  }
}

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
        (proof === "interrupt" || proof === "interrupt-periodic") &&
        message.captureId === "whole-soak" &&
        message.action === "start"
      ) {
        void import("../../src/logging/diagnostic-stall-cpu.test-support.ts").then(
          ({ stallCpuOwner }) => {
            const count = proof === "interrupt-periodic" ? 6 : 1;
            for (let index = 0; index < count; index++) {
              setTimeout(() => stallCpuOwner(1_200), 5_000 + index * 10_000).unref();
            }
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
