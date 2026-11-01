/**
 * Measures the real cron history planner over 6,000 synthetic completed runs / 200 jobs.
 * This isolates planner cost; it does not measure worker plan reuse, prune reuse, or Gateway load.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-history-plan-measure.ts \
 *   --mode timing --iterations 2000 --output .local/cron-history/timing.json
 * Repeat with --mode allocation in a separate process; sampling includes collected objects.
 * --kernel /absolute/path/run-history.kernel.ts selects baseline source whose relative imports
 * resolve in this checkout. Compare matching iterations, checksum, and fixture counts.
 * Use --iterations 250 for short runs on constrained hosts; counterbalance base/candidate order.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CronRunRecord } from "../../src/cron/store/run-history.types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
    kernel: { type: "string" },
    output: { type: "string" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
assert(values.output, "--output is required");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 2000,
});
const kernel = values.kernel
  ? pathToFileURL(path.resolve(values.kernel))
  : new URL("../../src/cron/store/run-history.kernel.ts", import.meta.url);
const {
  planCronRunHistoryMaintenance,
}: typeof import("../../src/cron/store/run-history.kernel.js") = await import(kernel.href);
const day = 86_400_000;
const nowMs = 1_800_000_000_000;
const records: CronRunRecord[] = Array.from({ length: 6000 }, (_, index) => ({
  id: `task-${index}`,
  jobId: `job-${index % 200}`,
  runId: `run-${index}`,
  createdAt: nowMs - (index % 9) * day - 1000,
  endedAt: nowMs - (index % 9) * day,
  status: "succeeded",
  detail: {
    storeKey: `store-${index % 2}`,
    ...(index % 3 === 0 ? { kind: "cron-run" } : {}),
  },
}));
const protectedJobs = new Set<string>();
const warmup = 50;
for (let index = 0; index < warmup; index++) {
  planCronRunHistoryMaintenance(records, nowMs, protectedJobs);
}
global.gc?.();
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const memoryBefore = process.memoryUsage();
let reconciliations = 0;
let summedNextSweepAtMs = 0;
const startedCpu = process.cpuUsage();
const started = performance.now();
for (let index = 0; index < iterations; index++) {
  const plan = planCronRunHistoryMaintenance(records, nowMs, protectedJobs);
  reconciliations += plan.reconciliations.length;
  summedNextSweepAtMs += plan.nextSweepAtMs ?? 0;
}
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(startedCpu);
const memoryAfter = process.memoryUsage();
const hostLoadAfter = loadavg();
let sampledBytes: number | null = null;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
}
const result = { reconciliations, summedNextSweepAtMs };
const report = {
  scope: "cron history planner only; excludes worker plan/prune reuse and Gateway effects",
  mode: values.mode,
  kernel: kernel.href,
  node: process.version,
  records: records.length,
  jobs: 200,
  warmup,
  iterations,
  result,
  checksum: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
  hostLoadBefore,
  hostLoadAfter,
  elapsedMs,
  cpuMs: (cpu.user + cpu.system) / 1000,
  cpuMsPerIteration: (cpu.user + cpu.system) / 1000 / iterations,
  sampledBytes,
  sampledBytesPerIteration: sampledBytes === null ? null : sampledBytes / iterations,
  memoryBefore,
  memoryAfter,
};
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
