/**
 * Measure refresh notifications through the real cron host and SQLite worker actor.
 * Forty synthetic interval jobs share one store; three have active run markers.
 * Each burst sends 20 notifications before the current operation releases. Compare
 * request counts and CPU/allocation per notification with identical durable jobs.
 * This is an owner workload, not Gateway load or production-frequency evidence.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-refresh-measure.ts \
 *   --mode timing --iterations 100 --output .local/cron-refresh/base.json
 * Repeat with --mode allocation separately; sampled CPU is not timing evidence.
 * --owner accepts a baseline scheduler-actor.ts whose relative imports resolve in
 * this checkout. Counterbalance baseline/candidate launches. State is created next
 * to --output and removed after all actor/worker resources close.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CronJob } from "../../src/cron/types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    owner: { type: "string" },
    output: { type: "string" },
    iterations: { type: "string", default: "100" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
assert(values.output, "--output is required");
assert(global.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 100,
});
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const stateDir = await mkdtemp(path.join(path.dirname(output), "synthetic-state-"));
const configPath = path.join(stateDir, "openclaw.json");
await mkdir(path.join(stateDir, "home"));
await mkdir(path.join(stateDir, "tmp"));
await writeFile(
  configPath,
  JSON.stringify({ agents: { entries: { main: {} } }, plugins: { enabled: false } }),
);
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: stateDir,
  TMPDIR: path.join(stateDir, "tmp"),
};
const ownerUrl = values.owner
  ? pathToFileURL(path.resolve(values.owner))
  : new URL("../../src/cron/service/scheduler-actor.ts", import.meta.url);
const ownerSha256 = createHash("sha256")
  .update(await readFile(ownerUrl))
  .digest("hex");
const owner: typeof import("../../src/cron/service/scheduler-actor.js") = await import(
  ownerUrl.href
);
const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
const { setDiagnosticsEnabledForProcess } = await import("../../src/infra/diagnostic-events.js");
const { onWorkerRequestMetrics } = await import("../../src/infra/worker-request-diagnostics.js");
const { createCronServiceState, prepareCronServiceStore } =
  await import("../../src/cron/service/state.js");
const { ensureLoaded } = await import("../../src/cron/service/store.js");
const { saveCronStore, loadCronStore } = await import("../../src/cron/store.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const nowMs = Date.now();
const storePath = path.join(stateDir, "cron", "jobs.json");
const jobs: CronJob[] = Array.from({ length: 40 }, (_, index) => ({
  id: `synthetic-${index}`,
  name: `Synthetic interval ${index}`,
  agentId: "main",
  enabled: true,
  createdAtMs: nowMs,
  updatedAtMs: nowMs,
  schedule: { kind: "every", everyMs: ((index % 4) + 1) * 3_600_000, anchorMs: nowMs },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "agentTurn", message: "Synthetic scheduled work. ".repeat(40) },
  delivery: { mode: "none" },
  state: {
    nextRunAtMs: nowMs + ((index % 4) + 1) * 3_600_000,
    ...(index < 3 ? { runningAtMs: nowMs, runningReceiptId: `synthetic-run-${index}` } : {}),
  },
}));
const scheduler = new GatewayScheduler();
let preparations = 0;
const errors: unknown[] = [];
const state = createCronServiceState({
  scheduler,
  storePath,
  cronEnabled: true,
  defaultAgentId: "main",
  nowMs: () => nowMs,
  enqueueSystemEvent() {},
  runIsolatedAgentJob: async () => {
    throw new Error("Future jobs must not run during refresh measurement");
  },
  listConfiguredChannels() {
    preparations++;
    return ["synthetic"];
  },
  log: {
    debug() {},
    info() {},
    warn(error) {
      errors.push(error);
    },
    error(error) {
      errors.push(error);
    },
  },
});
const inspector = new Session();
let unsubscribe = () => {};
let completed = 0;
let writerMs = 0;
let changed = () => {};
const burstSize = 20;
const warmup = 5;
async function burst() {
  for (let index = 0; index < burstSize; index++) {
    owner.refreshCronScheduler(state);
  }
  // All notifications share the settled operation. Their host callbacks capture
  // configuration before the next event-loop turn; worker replies may arrive later.
  await nextTurn();
  assert(preparations > 0);
  if (completed < preparations) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Cron refresh did not settle")), 30_000);
      changed = () => {
        if (completed >= preparations) {
          clearTimeout(timer);
          changed = () => {};
          resolve();
        }
      };
      changed();
    });
  }
  await nextTurn();
  assert.deepEqual(errors, []);
  assert.equal(completed, preparations);
}
try {
  await saveCronStore(storePath, { version: 1, jobs });
  await prepareCronServiceStore(state);
  await ensureLoaded(state);
  await owner.startCronScheduler(state, new Set());
  const before = await loadCronStore(storePath);
  preparations = 0;
  setDiagnosticsEnabledForProcess(true);
  unsubscribe = onWorkerRequestMetrics((kind, requestClass, phase, _depth, _wait, durationMs) => {
    if (kind === "sqlite_writer" && requestClass === "cron" && phase === "completed") {
      completed++;
      writerMs += durationMs ?? 0;
      changed();
    }
  });
  for (let index = 0; index < warmup; index++) {
    await burst();
  }
  preparations = completed = writerMs = 0;
  global.gc();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.cpuUsage();
  const threadCpu = process.threadCpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    await burst();
  }
  const elapsedMs = performance.now() - started;
  const cpuUsed = process.cpuUsage(cpu);
  const threadUsed = process.threadCpuUsage(threadCpu);
  const memoryAfter = process.memoryUsage();
  const hostLoadAfter = loadavg();
  const profile =
    values.mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
  const measuredRequests = completed;
  unsubscribe();
  const after = await loadCronStore(storePath);
  assert.deepEqual(after, before);
  const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
  const notifications = iterations * burstSize;
  const report = {
    scope: "Real cron refresh host and SQLite worker; no job execution or whole-Gateway claim",
    mode: values.mode,
    node: process.version,
    owner: ownerUrl.href,
    ownerSha256,
    iterations,
    burstSize,
    notifications,
    jobs: jobs.length,
    activeJobMarkers: 3,
    warmupBursts: warmup,
    workerRequests: measuredRequests,
    writerMs,
    elapsedMs,
    processCpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
    mainThreadCpuMs: (threadUsed.user + threadUsed.system) / 1000,
    sampledMainThreadBytes: profile ? sampledBytes(profile.head) : null,
    unchangedJobs: true,
    scheduleDigest: createHash("sha256")
      .update(
        JSON.stringify(after.jobs.map((job) => [job.id, (job.state.nextRunAtMs ?? 0) - nowMs])),
      )
      .digest("hex"),
    hostLoadBefore,
    hostLoadAfter,
    memoryBefore,
    memoryAfter,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  unsubscribe();
  inspector.disconnect();
  state.stopped = true;
  await owner.stopCronScheduler(state);
  await scheduler.stop();
  await closeOpenClawAgentDatabasesAsync(stateDir);
  await closeOpenClawStateDatabaseAsync();
  await rm(stateDir, { recursive: true, force: true });
}
