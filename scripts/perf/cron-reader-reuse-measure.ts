/**
 * Cron reader lifecycle, real workers and 40 synthetic jobs; no live state.
 * node --import ./scripts/tsx.mjs scripts/perf/cron-reader-reuse-measure.ts
 *   --worker-root .artifacts/vitest-workers/run-cache-0 --iterations 4 --samples 5 [--owner-dir /absolute/base-overlay] [--allocations]
 * --worker-root selects already-built workers; omit only for source-loader diagnosis.
 * Overlay contains changed source files at repo-relative paths. Both arms use
 * the same main-only canonical overlay loader. Worker sources are unchanged;
 * compiled workers run without source/measurement preloads. Allocation sampling is a separate pass;
 * it measures main-thread JS allocation, not worker/native allocation.
 * Acceptance: unchanged rows, fewer worker starts and lower CPU/allocation/read.
 * Cold first read stays in each sample; database close is outside timing.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import workerThreads from "node:worker_threads";

const { values } = parseArgs({
  options: {
    "owner-dir": { type: "string" },
    "worker-root": { type: "string" },
    iterations: { type: "string", default: "4" },
    samples: { type: "string", default: "5" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
const samples = Number(values.samples);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(samples) && samples > 0);
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/cron-reader-measure-"));
Object.assign(process.env, {
  HOME: root,
  OPENCLAW_HOME: root,
  OPENCLAW_STATE_DIR: root,
  TMPDIR: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
});
const overlay = values["owner-dir"]
  ? path.resolve(values["owner-dir"])
  : path.join(root, "overlay");
await mkdir(overlay, { recursive: true });
process.env.OPENCLAW_BENCH_BASELINE_DIR = overlay;
const NativeWorker = workerThreads.Worker;
await import("./worker-retained-heap-preload.ts");
if (values["worker-root"]) {
  const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
  const workerRoot = path.resolve(values["worker-root"], "dist");
  workerThreads.Worker = class extends NativeWorker {
    constructor(filename: string | URL, options: import("node:worker_threads").WorkerOptions = {}) {
      const source = typeof filename === "string" ? filename : fileURLToPath(filename);
      const relative = path.relative(sourceRoot, source);
      const entry = path.join(workerRoot, relative.replace(/\.ts$/, ".js"));
      const compiled = !relative.startsWith("..") && existsSync(entry);
      super(compiled ? entry : filename, compiled ? { ...options, execArgv: [] } : options);
    }
  };
  syncBuiltinESMExports();
}
const { saveCronJobsStore, loadCronJobsStoreWithConfigJobsReadOnly } =
  await import("../../src/cron/store.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { getTrackedWorkerLifecycleSnapshot } = await import("../../src/infra/worker-cpu.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const storePath = path.join(root, "cron", "jobs.json");
const jobs = Array.from({ length: 40 }, (_, index) => ({
  id: `synthetic-${index}`,
  name: `Synthetic scheduled job ${index}`,
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 1,
  schedule: { kind: "every" as const, everyMs: 60_000 },
  sessionTarget: "main" as const,
  wakeMode: "now" as const,
  payload: { kind: "systemEvent" as const, text: "Synthetic recurring event" },
  state: { nextRunAtMs: 60_001 },
}));
const starts = () =>
  getTrackedWorkerLifecycleSnapshot()
    .workerLifecycle.filter(({ script }) => script.includes("read-only.worker"))
    .reduce((sum, row) => sum + row.started, 0);
const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
const inspector = new Session();
try {
  await saveCronJobsStore(storePath, { version: 1, jobs });
  await closeOpenClawStateDatabaseAsync();
  inspector.connect();
  for (let sample = 0; sample < samples; sample++) {
    if (values.allocations) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const before = starts();
    const cpu = process.cpuUsage();
    const thread = process.threadCpuUsage();
    const start = performance.now();
    for (let index = 0; index < iterations; index++) {
      const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(storePath);
      assert.equal(loaded.store.jobs.length, 40);
      assert.equal(loaded.store.jobs[0].name, jobs[0].name);
    }
    const wallMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const main = process.threadCpuUsage(thread);
    const bytes = values.allocations
      ? sum((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
    console.log(
      JSON.stringify({
        sample,
        iterations,
        workerStarts: starts() - before,
        wallMs,
        processCpuMs: (used.user + used.system) / 1000,
        mainCpuMs: (main.user + main.system) / 1000,
        allocatedMainBytes: bytes,
        memory: process.memoryUsage(),
        load: loadavg(),
      }),
    );
    await closeOpenClawStateDatabaseAsync();
  }
} finally {
  inspector.disconnect();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
  await rm(root, { recursive: true, force: true });
}
