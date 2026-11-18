/**
 * node --expose-gc --import tsx scripts/perf/main-thread-task-context-measure.ts
 *   --baseline /path/to/baseline-owner.ts --fixture /path/to/synthetic-workspace
 * Five serial A1/B/A2 controls; --allocations measures sampled bytes separately.
 * --scenario named-promises --concurrency 20 --stores 21 models busy async contexts.
 * --max-owner-bytes 2 with --allocations checks the candidate continuation allocation budget.
 * --stall-ms 1200 instead injects native staging delay and reports real CPU samples.
 * Run native profiling in an isolated child with a timeout (Darwin profiler risk).
 * The baseline owner must retain its source imports. No production data is read.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { root } from "@openclaw/fs-safe/root";
import * as candidate from "../../src/infra/main-thread-stall.js";
import { createStallFlightRecorder } from "../../src/logging/diagnostic-stall-flight-recorder.js";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    fixture: { type: "string" },
    scenario: { type: "string" },
    "max-owner-bytes": { type: "string" },
    concurrency: { type: "string", default: "1" },
    stores: { type: "string", default: "0" },
    samples: { type: "string", default: "5" },
    iterations: { type: "string", default: "100" },
    warmups: { type: "string", default: "20" },
    "promise-iterations": { type: "string", default: "100000" },
    allocations: { type: "boolean", default: false },
    "stall-ms": { type: "string", default: "0" },
  },
});
assert(values.baseline && values.fixture, "--baseline and --fixture are required");
assert(global.gc, "Run with --expose-gc");
const baseline: typeof candidate = await import(pathToFileURL(path.resolve(values.baseline)).href);
const fixture = path.resolve(values.fixture);
await fs.mkdir(fixture, { recursive: true });
const scoped = await root(fixture);
const filename = `task-context-${process.pid}.json`;
const bytes = Buffer.alloc(1024, 65);
const samples = Number(values.samples);
const iterations = Number(values.iterations);
const warmups = Number(values.warmups);
const promiseIterations = Number(values["promise-iterations"]);
const concurrency = Number(values.concurrency);
const storeCount = Number(values.stores);
assert(Number.isSafeInteger(storeCount) && storeCount >= 0);
const stores = Array.from({ length: storeCount }, () => new AsyncLocalStorage());
const filenames = Array.from({ length: concurrency }, (_, lane) => `${filename}.${lane}`);
const stallMs = Number(values["stall-ms"]);
assert(
  [samples, iterations, warmups, promiseIterations, concurrency].every(
    (value) => Number.isSafeInteger(value) && value > 0,
  ),
);
assert(Number.isSafeInteger(stallMs) && stallMs >= 0 && !(stallMs && values.allocations));
assert(iterations % concurrency === 0 && promiseIterations % concurrency === 0);
const scenarios = ["named-promises", "unnamed-promises", "sync-phase", "root-write"] as const;
assert(!values.scenario || scenarios.some((scenario) => scenario === values.scenario));
const maxOwnerBytes =
  values["max-owner-bytes"] === undefined ? undefined : Number(values["max-owner-bytes"]);
assert(
  maxOwnerBytes === undefined ||
    (values.allocations &&
      values.scenario === "named-promises" &&
      Number.isFinite(maxOwnerBytes) &&
      maxOwnerBytes >= 0),
);
const ownerSources = new Set([
  pathToFileURL(path.resolve(values.baseline)).href,
  new URL("../../src/infra/main-thread-stall.ts", import.meta.url).href,
]);
const profiles = new Session();
if (values.allocations) {
  profiles.connect();
  await profiles.post("HeapProfiler.enable");
}
try {
  if (stallMs) {
    // Instrument only this isolated probe's native owner; never mutate the package on disk.
    const native: {
      getNativeBinding(name: string): { createStagedFile: (...args: unknown[]) => unknown };
    } = await import(new URL("native.js", import.meta.resolve("@openclaw/fs-safe/root")).href);
    const binding = native.getNativeBinding("createStagedFile");
    const original = binding.createStagedFile;
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    for (const [label, owner] of [
      ["A", baseline],
      ["B", candidate],
    ] as const) {
      let injected = false;
      binding.createStagedFile = function (...args: unknown[]) {
        if (!injected) {
          injected = true;
          Atomics.wait(waiter, 0, 0, stallMs);
        }
        return Reflect.apply(original, this, args);
      };
      const monitor = owner.createMainThreadStallMonitor();
      monitor.setEventLoopSampling(true);
      const warnings: string[] = [];
      const recorder = createStallFlightRecorder((message) => warnings.push(message));
      try {
        await owner.runWithMainThreadTask("synthetic:root-write", async () => {
          await Promise.resolve();
          await scoped.write(filename, bytes);
        });
        assert(injected, "The native staging path did not run");
        const stalls = monitor.drain().stalls;
        const report = recorder.sample(stalls[0]);
        if (label === "B") {
          assert.equal(stalls[0]?.task, "synthetic:root-write");
          assert(report, "Expected a native stall profile");
          assert(report.includes("[async task:synthetic:root-write]"), report);
          assert(!report.includes("openclaw:"), report);
          assert(Buffer.byteLength(report) <= 2048);
        }
        console.log(JSON.stringify({ label, stalls, report, warnings }));
      } finally {
        recorder.stop();
        monitor.stop();
        binding.createStagedFile = original;
      }
    }
  } else {
    for (let pass = 0; pass < samples; pass++) {
      for (const enabled of [false, true]) {
        for (const scenario of scenarios) {
          if (values.scenario && values.scenario !== scenario) {
            continue;
          }
          const count = scenario === "root-write" ? iterations : promiseIterations;
          for (const [label, owner] of [
            ["A1", baseline],
            ["B", candidate],
            ["A2", baseline],
          ] as const) {
            const monitor = owner.createMainThreadStallMonitor();
            monitor.setEventLoopSampling(enabled);
            try {
              const noop = () => {};
              const work = async (length: number, lane: number) => {
                for (let index = 0; index < length; index++) {
                  if (scenario === "root-write") {
                    await scoped.write(filenames[lane]!, bytes);
                  } else if (scenario === "sync-phase") {
                    owner.runWithMainThreadTask("synthetic:write-owner", noop, "write");
                  } else {
                    await Promise.resolve();
                  }
                }
              };
              const run = (length: number) =>
                stores.reduceRight(
                  (inner, storage) => () => storage.run(true, inner),
                  () =>
                    Promise.all(
                      filenames.map((_, lane) => {
                        const scopedWork = () => work(Math.ceil(length / concurrency), lane);
                        return scenario === "unnamed-promises" || scenario === "sync-phase"
                          ? scopedWork()
                          : owner.runWithMainThreadTask("synthetic:write-owner", scopedWork);
                      }),
                    ),
                )();
              await run(scenario === "root-write" ? warmups : 10000);
              global.gc();
              if (values.allocations) {
                await profiles.post("HeapProfiler.startSampling", {
                  samplingInterval: 4096,
                  includeObjectsCollectedByMajorGC: true,
                  includeObjectsCollectedByMinorGC: true,
                });
              }
              const allocated = getHeapStatistics().total_allocated_bytes;
              const cpu = process.cpuUsage();
              const thread = process.threadCpuUsage();
              const at = performance.now();
              await run(count);
              const elapsedMs = performance.now() - at;
              const used = process.cpuUsage(cpu);
              const usedThread = process.threadCpuUsage(thread);
              const exactBytes = getHeapStatistics().total_allocated_bytes - allocated;
              let ownerBytes = 0;
              let afterBytes = 0;
              let allocationBytes: number | undefined;
              if (values.allocations) {
                const { profile } = await profiles.post("HeapProfiler.stopSampling");
                const pending = [profile.head];
                allocationBytes = 0;
                for (const node of pending) {
                  allocationBytes += node.selfSize;
                  if (ownerSources.has(node.callFrame.url)) {
                    ownerBytes += node.selfSize;
                    if (node.callFrame.functionName === "after") {
                      afterBytes += node.selfSize;
                    }
                  }
                  pending.push(...node.children);
                }
              }
              if (maxOwnerBytes !== undefined && label === "B" && enabled) {
                assert(
                  ownerBytes / count <= maxOwnerBytes,
                  `Monitor allocated ${ownerBytes / count} B/continuation; budget ${maxOwnerBytes}`,
                );
              }
              console.log(
                JSON.stringify({
                  pass,
                  label,
                  enabled,
                  scenario,
                  count,
                  concurrency,
                  stores: stores.length,
                  exactBytes: exactBytes / count,
                  ownerBytes: values.allocations ? ownerBytes / count : undefined,
                  afterBytes: values.allocations ? afterBytes / count : undefined,
                  load1: loadavg()[0],
                  elapsedUs: (elapsedMs * 1000) / count,
                  cpuUs: (used.user + used.system) / count,
                  threadCpuUs: (usedThread.user + usedThread.system) / count,
                  allocationBytes:
                    allocationBytes === undefined ? undefined : allocationBytes / count,
                }),
              );
            } finally {
              monitor.stop();
            }
          }
        }
      }
    }
  }
} finally {
  profiles.disconnect();
  await Promise.all(
    [filename, ...filenames].map((name) => fs.rm(path.join(fixture, name), { force: true })),
  );
}
