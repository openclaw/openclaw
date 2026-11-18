// Isolated Gateway only: transcript-broadcast-measure.ts --scenario memory-soak
// --diagnostics --stress-tools --stress-shell-words 6000
// --gateway-preload scripts/perf/bash-parser-gateway-preload.mjs
// Shell words add bounded no-op arguments before pwd; verified worktree output stays unchanged.
// BASH_PARSER_MEMORY records first use, linear-heap growth, and whole-soak counters.
// Use identical instrumentation on both arms. Untraced allocation counts cover V8's
// main isolate, not native allocations; linear-memory capacity is not resident RSS.
import { registerHooks } from "node:module";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import v8 from "node:v8";
import { isMainThread, threadId } from "node:worker_threads";

let runtime;
let parses = 0;
let measuredParses = 0;
let previousWasmBytes = 0;
let measuredStart;
const emit = (phase, extra = {}) => {
  const value = {
    phase,
    atEpochMs: Date.now(),
    monotonicMs: performance.now(),
    pid: process.pid,
    threadId,
    isMainThread,
    wasmHeapBytes: runtime?.HEAP8?.byteLength ?? 0,
    parses,
    measuredParses,
    cpu: process.threadCpuUsage(),
    memory: process.memoryUsage(),
    totalAllocatedBytes: v8.getHeapStatistics().total_allocated_bytes,
    ...extra,
  };
  console.log(`BASH_PARSER_MEMORY ${JSON.stringify(value)}`);
  return value;
};
globalThis.openclawBashParserMemoryObserver = {
  beforeLoad() {
    emit("before-first-load");
  },
  initialized(value) {
    runtime = value;
    previousWasmBytes = value.HEAP8.byteLength;
    emit("runtime-initialized");
  },
  parsed(sourceChars) {
    parses++;
    if (measuredStart) {
      measuredParses++;
    }
    const bytes = runtime?.HEAP8?.byteLength ?? 0;
    if (parses === 1 || bytes !== previousWasmBytes) {
      emit(parses === 1 ? "first-parse" : "heap-grew", { sourceChars, previousWasmBytes });
      previousWasmBytes = bytes;
    }
  },
};
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (result.source == null) {
      return result;
    }
    const source =
      typeof result.source === "string" ? result.source : Buffer.from(result.source).toString();
    if (
      !source.includes("async function loadParser()") ||
      !source.includes("MAX_COMMAND_EXPLANATION_SOURCE_CHARS")
    ) {
      return result;
    }
    const load = /async function loadParser\(\)\s*\{/;
    const init = /await TreeSitter\.Parser\.init\(\);/;
    const afterParse = /if \(!tree\) \{/;
    if (![load, init, afterParse].every((needle) => needle.test(source))) {
      throw new Error(`Bash parser memory observer source anchors changed: ${url}`);
    }
    emit("instrumented", { url });
    return {
      ...result,
      source: source
        .replace(
          load,
          (match) => `${match} globalThis.openclawBashParserMemoryObserver.beforeLoad();`,
        )
        .replace(
          init,
          "await TreeSitter.Parser.init({ onRuntimeInitialized() { globalThis.openclawBashParserMemoryObserver.initialized(this); } });",
        )
        .replace(
          afterParse,
          (match) => `globalThis.openclawBashParserMemoryObserver.parsed(source.length); ${match}`,
        ),
    };
  },
});

if (isMainThread) {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  emit("preload");
  setInterval(() => emit("minute"), 60_000).unref();
  process.on("message", (message) => {
    if (
      message?.channel !== "openclaw-gateway-bench-profile" ||
      message.kind !== "diagnostics" ||
      message.captureId !== "whole-soak"
    ) {
      return;
    }
    if (message.action === "start") {
      measuredParses = 0;
      measuredStart = emit("whole-soak-start");
      loop.reset();
      loop.enable();
    }
    if (message.action === "stop") {
      loop.disable();
      const finish = emit("whole-soak-stop");
      if (measuredStart) {
        const wallMs = finish.monotonicMs - measuredStart.monotonicMs;
        const cpuUs =
          finish.cpu.user + finish.cpu.system - measuredStart.cpu.user - measuredStart.cpu.system;
        const allocatedBytes = finish.totalAllocatedBytes - measuredStart.totalAllocatedBytes;
        console.log(
          `BASH_PARSER_MEMORY ${JSON.stringify({
            phase: "whole-soak-summary",
            wallMs,
            mainThreadCpuPercent: cpuUs / wallMs / 10,
            allocatedBytes,
            allocatedMiBPerSecond: allocatedBytes / 1024 ** 2 / (wallMs / 1000),
            measuredParses,
            start: measuredStart,
            finish,
            eventLoop: {
              resolutionMs: 10,
              count: loop.count,
              maxMs: loop.max / 1e6,
              p50Ms: loop.count ? loop.percentile(50) / 1e6 : null,
              p95Ms: loop.count ? loop.percentile(95) / 1e6 : null,
              p99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
            },
          })}`,
        );
      }
      measuredStart = undefined;
    }
  });
  process.channel?.unref();
  process.once("exit", () => emit("exit"));
}
