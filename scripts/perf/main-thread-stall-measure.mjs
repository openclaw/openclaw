// Run with node --import ./scripts/tsx.mjs on the approved Node 26 benchmark host.
// Native control polling: main-thread-stall-measure.mjs worker-service 21 1000000
// Compare five counterbalanced base/candidate pairs. Allocation is sampled separately
// from untraced wall/CPU time; this measures the monitored decode probe, not a Gateway.
// Leaf-attribution proof: main-thread-stall-measure.mjs flight (Node 26 native profiler).
// Native launch cost: --expose-gc main-thread-stall-measure.mjs native-spawn 5 50
// Use Linux with jemalloc for fork measurements; heap is ~1.76 GB of resident doubles.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { pbkdf2Sync, scryptSync } from "node:crypto";
import { once } from "node:events";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import {
  createMainThreadStallMonitor,
  getMainThreadTaskName,
  runWithMainThreadTask,
} from "../../src/infra/main-thread-stall.ts";
import { createStallFlightRecorder } from "../../src/logging/diagnostic-stall-flight-recorder.ts";

const [mode = "phase", countText = "21", iterationsText = "200000"] = process.argv.slice(2);
if (mode === "native-spawn") {
  const count = Number(countText);
  const iterations = Number(iterationsText);
  assert(Number.isSafeInteger(count) && count > 0);
  assert(Number.isSafeInteger(iterations) && iterations > 0);
  assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc");
  const { spawnProcess } = await import("../../src/process/spawn-utils.ts");
  const retained = Array.from({ length: 220 }, (_, index) =>
    Array.from({ length: 1_000_000 }, () => index + 0.5),
  );
  globalThis.gc();
  const monitor = createMainThreadStallMonitor();
  try {
    for (let sample = 0; sample < count; sample++) {
      const spans = [];
      let cpuMs = 0;
      let allocatedBytes = 0;
      for (let index = 0; index < iterations; index++) {
        const allocated = getHeapStatistics().total_allocated_bytes;
        assert(Number.isFinite(allocated), "Requires Node 26.12+ allocation counter");
        const cpu = process.threadCpuUsage();
        const startedAt = performance.now();
        const child = spawnProcess("/bin/true", [], { stdio: "ignore" });
        spans.push(performance.now() - startedAt);
        const usedCpu = process.threadCpuUsage(cpu);
        cpuMs += (usedCpu.user + usedCpu.system) / 1000;
        allocatedBytes += getHeapStatistics().total_allocated_bytes - allocated;
        assert.equal((await once(child, "close"))[0], 0);
      }
      spans.sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          sample,
          spawns: iterations,
          retainedArrays: retained.length,
          memory: process.memoryUsage(),
          hostLoad: loadavg(),
          launchMs: spans.reduce((sum, value) => sum + value, 0),
          medianMs: spans[Math.floor(spans.length / 2)],
          p95Ms: spans[Math.ceil(spans.length * 0.95) - 1],
          maxMs: spans.at(-1),
          cpuMs,
          allocatedBytes,
          stalls: monitor.drain().stalls,
        }),
      );
    }
  } finally {
    monitor.stop();
  }
  process.exit(0);
}
if (mode === "flight") {
  const warnings = [];
  const recorder = createStallFlightRecorder((message) => warnings.push(message));
  try {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const startedAt = performance.now();
    runWithMainThreadTask("benchmark:synthetic-stall", () => {
      while (performance.now() - startedAt < 1_200) {
        pbkdf2Sync("synthetic", "synthetic", 10_000, 32, "sha256");
      }
    });
    const endedAt = performance.now();
    while (performance.now() - endedAt < 600) {
      scryptSync("synthetic", "synthetic", 32);
    }
    const report = recorder.sample({ startedAt, endedAt });
    assert.equal(warnings.length, 0);
    assert.ok(report?.includes("self="));
    assert.ok(report.includes("pbkdf2Sync@node:internal/crypto/pbkdf2"));
    assert.ok(report.includes("openclaw:src/infra/main-thread-stall.ts"));
    assert.ok(!report.includes("scryptSync"));
    assert.ok(Buffer.byteLength(report) <= 2_048);
    console.log(
      JSON.stringify({ node: process.version, bytes: Buffer.byteLength(report), report }),
    );
  } finally {
    recorder.stop();
  }
  process.exit(0);
}
const count = Number(countText);
const iterations = Number(iterationsText);
if (
  !["entry", "same-name", "phase", "worker-service"].includes(mode) ||
  !Number.isSafeInteger(count) ||
  count < 0 ||
  !Number.isSafeInteger(iterations) ||
  iterations < 1
) {
  throw new Error(
    "Usage: main-thread-stall-measure.mjs <entry|same-name|phase|worker-service> <stores> <iterations>",
  );
}
const name = mode === "worker-service" ? "worker:control-decode" : "gateway:rpc:sessions.list";
const channel = mode === "worker-service" ? new MessageChannel() : undefined;
let calls = 0;
const work = () => {
  if (getMainThreadTaskName() !== name) {
    throw new Error("Lost task attribution");
  }
  calls++;
  if (channel && receiveMessageOnPort(channel.port1) !== undefined) {
    throw new Error("Idle control port unexpectedly received a message");
  }
};
const scope = () =>
  runWithMainThreadTask(name, work, mode === "phase" ? "session-rows:select" : undefined);
const monitor = createMainThreadStallMonitor();
const stores = Array.from({ length: count }, () => new AsyncLocalStorage());
const withinStores = (run) =>
  stores.reduceRight((inner, storage) => () => storage.run(true, inner), run)();

await withinStores(async () => {
  const inspector = new Session();
  inspector.connect();
  const measure = async () => {
    for (let index = 0; index < 20000; index++) {
      scope();
    }
    const hostLoad = loadavg();
    const cpuBefore = process.threadCpuUsage();
    const started = performance.now();
    for (let index = 0; index < iterations; index++) {
      scope();
    }
    const elapsedMs = performance.now() - started;
    const cpu = process.threadCpuUsage(cpuBefore);
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: mode === "worker-service" ? 16_384 : 512,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const before = calls;
    for (let index = 0; index < iterations; index++) {
      scope();
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const bytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
    const sampledCalls = calls - before;
    console.log(
      JSON.stringify({
        node: process.version,
        mode,
        stores: count,
        sampledCalls,
        sampledBytes: bytes,
        allocationSamples: profile.samples.length,
        bytesPerCall: bytes / sampledCalls,
        timedCalls: iterations,
        elapsedMs,
        callsPerSecond: (iterations * 1000) / elapsedMs,
        nanosecondsPerCall: (elapsedMs * 1e6) / iterations,
        cpuNanosecondsPerCall: ((cpu.user + cpu.system) * 1000) / iterations,
        hostLoad,
      }),
    );
  };
  try {
    await inspector.post("HeapProfiler.enable");
    if (mode === "same-name") {
      await runWithMainThreadTask(name, measure);
    } else {
      await measure();
    }
  } finally {
    inspector.disconnect();
    monitor.stop();
    channel?.port1.close();
    channel?.port2.close();
  }
});
