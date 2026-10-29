/**
 * Synthetic 200-job definition publication; no database, Gateway, or live state.
 * node --import ./scripts/tsx.mjs scripts/perf/cron-definition-publication-measure.ts
 *   [--owner-dir /absolute/base-overlay] [--allocations] [--iterations 1000]
 * Overlay uses the canonical benchmark loader; include the baseline service/state.ts.
 * Run base/candidate in alternating order; allocation sampling is a separate pass.
 * Worker preparation is reported separately: candidate prepares 200 revisions per
 * reload; baseline computes 400 on the main thread. Cloning/IPC is outside this
 * owner benchmark. Acceptance: unchanged notifications, lower total CPU/allocation
 * (publication plus preparation), and no main-thread revision derivation on reload.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { CronJob } from "../../src/cron/types.js";

const { values } = parseArgs({
  options: {
    "owner-dir": { type: "string" },
    allocations: { type: "boolean", default: false },
    iterations: { type: "string", default: "1000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const overlay = path.resolve(values["owner-dir"] ?? ".local/cron-definition-empty-overlay");
mkdirSync(overlay, { recursive: true });
process.env.OPENCLAW_BENCH_BASELINE_DIR = overlay;
await import("./worker-retained-heap-preload.ts");
const { createCronServiceState, emitCronDefinitionChanges } =
  await import("../../src/cron/service/state.js");
const { captureCronJobConfigRevision } = await import("../../src/cron/config-revision.js");
const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
const jobs: CronJob[] = Array.from({ length: 200 }, (_, index) => ({
  id: `synthetic-${index}`,
  name: `Synthetic scheduled job ${index}`,
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 1,
  schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Synthetic scheduled work. ".repeat(40) },
  delivery: { mode: "none" },
  state: { nextRunAtMs: 60_001, lastRunAtMs: 1, lastRunStatus: "ok" },
}));
const next = structuredClone(jobs);
const prepare = () => new Map(jobs.map((job) => [job.id, captureCronJobConfigRevision(job)]));
const revisions = prepare();
let notifications = 0;
const state = createCronServiceState({
  scheduler: new GatewayScheduler(),
  log: { debug() {}, info() {}, warn() {}, error() {} },
  storePath: path.resolve(".local/synthetic-definition/jobs.json"),
  cronEnabled: false,
  enqueueSystemEvent() {},
  runIsolatedAgentJob: async () => ({ status: "ok" }),
  onDefinitionChange() {
    notifications++;
  },
});
// The fourth argument is deliberately ignored by the baseline owner.
emitCronDefinitionChanges(state, [], jobs, revisions);
notifications = 0;
const inspector = new Session();
const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
inspector.connect();
try {
  for (const phase of ["publication", "preparation"] as const) {
    const run = () =>
      phase === "publication" ? emitCronDefinitionChanges(state, jobs, next, revisions) : prepare();
    for (let index = 0; index < 100; index++) {
      run();
    }
    if (values.allocations) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    for (let index = 0; index < iterations; index++) {
      run();
    }
    const wallMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    const bytes = values.allocations
      ? sum((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
    console.log(
      JSON.stringify({
        phase,
        iterations,
        jobs: jobs.length,
        load: loadavg(),
        wallUsPerPublish: (wallMs * 1000) / iterations,
        cpuUsPerPublish: (used.user + used.system) / iterations,
        allocatedBytesPerPublish: bytes === undefined ? undefined : bytes / iterations,
      }),
    );
  }
  assert.equal(notifications, 0);
} finally {
  inspector.disconnect();
}
