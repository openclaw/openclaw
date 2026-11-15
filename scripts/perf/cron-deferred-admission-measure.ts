/**
 * Cron's real synchronous scheduling/receipt owner, with synthetic deferral results.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-deferred-admission-measure.ts \
 *   --output /absolute/proof/candidate.json [--revision <baseline-sha>] [--profile]
 * Run five alternating baseline/candidate pairs and A/A controls. Imports, schema
 * admission, fixture construction and cleanup are outside the episode measurement.
 * Acceptance: fewer launches and receipt writes, one retained deferral receipt,
 * lower owner CPU/allocation; preserve the original unconsumed occurrence.
 * This measures the cron worker kernel, not transport, model work, or Gateway latency.
 * Agent transcript bytes/workspace files are outside this owner's read set.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { CronJob } from "../../src/cron/types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    revision: { type: "string" },
    jobs: { type: "string", default: "1000" },
    profile: { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required");
assert(global.gc, "Run with --expose-gc");
const jobCount = Number(values.jobs);
assert(Number.isSafeInteger(jobCount) && jobCount >= 1);
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const root = await mkdtemp(path.join(path.dirname(output), "synthetic-cron-deferred-"));
const configPath = path.join(root, "openclaw.json");
await mkdir(path.join(root, "home"));
await writeFile(
  configPath,
  JSON.stringify({ agents: { entries: { main: {} } }, plugins: { enabled: false } }),
);
const environment = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_SUPERVISOR_MODE: undefined,
};
process.env = environment;
// Load historical owners intact; all unchanged imports keep the checkout's identities.
const owners = [
  "src/cron/service/admission-deferred.ts",
  "src/cron/service/jobs-scheduling.ts",
  "src/cron/service/jobs-mutation.ts",
  "src/cron/service/timer-runnable.ts",
  "src/cron/service/timer-outcomes.ts",
  "src/cron/store/run-finalization.worker.ts",
  "src/cron/store/run-queue.worker.ts",
  "src/cron/store/run-receipt-store.ts",
  "src/cron/store/scheduler-actor.worker.ts",
];
if (values.revision) {
  const sources = new Map(
    owners.map((file) => [
      pathToFileURL(path.resolve(file)).href,
      execFileSync("git", ["show", `${values.revision}:${file}`], { encoding: "utf8" }),
    ]),
  );
  registerHooks({
    load(url, context, next) {
      const source = sources.get(url);
      return source === undefined
        ? next(url, context)
        : { source, format: "module-typescript", shortCircuit: true };
    },
  });
}
const { runWithSqliteWorkerStateContext } =
  await import("../../src/infra/sqlite-worker-state-context.js");
const {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} = await import("../../src/state/openclaw-state-db.js");
const { saveCronStoreInDatabase } = await import("../../src/cron/store/save.kernel.js");
const { ensureCronRunReceiptSchema } = await import("../../src/cron/store/run-receipt-store.js");
const { finalizeCronRunsInWorker } =
  await import("../../src/cron/store/run-finalization.worker.js");
const { runCronSchedulerInWorker, stopCronSchedulerInWorker } =
  await import("../../src/cron/store/scheduler-actor.worker.js");
const { loadCronStoreFromDatabase } = await import("../../src/cron/store/load.kernel.js");
const database = openOpenClawStateDatabase();
const storeKey = path.join(root, "cron", "jobs.json");
const channelName = `cron-benchmark:${root}`;
const now = Date.now();
const dueAt = now + 1;
const minute = 60_000;
const jobs: CronJob[] = Array.from({ length: jobCount }, (_, index) => ({
  id: `synthetic-${index}`,
  name: `Synthetic scheduled job ${index}`,
  agentId: "main",
  enabled: true,
  createdAtMs: now - minute,
  updatedAtMs: now - minute,
  schedule: { kind: "every", everyMs: index === 0 ? minute : 24 * 60 * minute, anchorMs: dueAt },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "command", argv: ["echo", "synthetic"] },
  delivery: { mode: "none" },
  state: {
    nextRunAtMs: index === 0 ? dueAt : now + 24 * 60 * minute,
    lastRunStatus: "ok",
    consecutiveErrors: 0,
  },
}));
const withinWorker = <T>(run: () => T): T => runWithSqliteWorkerStateContext({ environment }, run);
const run = (command: Parameters<typeof runCronSchedulerInWorker>[1]) =>
  withinWorker(() => runCronSchedulerInWorker(database, command));
const inspector = new Session();
try {
  ensureCronRunReceiptSchema(database.db);
  withinWorker(() =>
    runOpenClawStateWriteTransaction(
      () => saveCronStoreInDatabase(database, storeKey, { version: 1, jobs }),
      { database, path: database.path, env: process.env },
    ),
  );
  const started = run({
    type: "cron.schedulerStart",
    input: {
      storeKey,
      channelName,
      nowMs: now,
      monotonicMs: 0,
      snapshot: { config: { cronEnabled: true, defaultAgentId: "main" } },
    },
  });
  assert.equal(started.launches.length, 0);
  global.gc();
  if (values.profile) {
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const allocatedStart = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(allocatedStart), "Node with total_allocated_bytes is required");
  const changesStart = Number(
    database.db.prepare("SELECT total_changes() AS changes").get()?.changes,
  );
  const hostLoadBefore = loadavg();
  const cpu = process.threadCpuUsage();
  const wallStart = performance.now();
  let launches = 0;
  let schedulerTicks = 0;
  let nextWake = started.nextWakeAtMs!;
  // A timer wake is rounded to the reported two-second observation cadence.
  for (let offset = 0; offset < 10 * minute; offset += 2_000) {
    const atMs = dueAt + offset;
    if (nextWake > atMs) {
      continue;
    }
    schedulerTicks++;
    const tick = run({
      type: "cron.schedulerTick",
      input: { storeKey, nowMs: atMs, monotonicMs: atMs - now },
    });
    for (const launch of tick.launches) {
      launches++;
      assert.equal(launch.job.id, "synthetic-0");
      withinWorker(() =>
        finalizeCronRunsInWorker(database, {
          storeKey,
          snapshot: {
            nowMs: atMs,
            defaultAgentId: "main",
            outcomes: [
              {
                jobId: launch.job.id,
                job: launch.job,
                runReceipt: launch.runReceipt,
                startedAt: launch.runReceipt.startedAtMs,
                endedAt: atMs,
                status: "skipped",
                admissionDeferred: true,
                admissionDeferredReason: "busy",
                executionStarted: false,
                summary: "Automation deferred while its agent is busy",
                completionStatus: "failed",
                errorReason: undefined,
                deliveryState: {
                  status: "not-requested",
                  failureNotification: { status: "not-requested" },
                },
              },
            ],
          },
        }),
      );
    }
    nextWake = run({
      type: "cron.schedulerRefresh",
      input: { storeKey, channelName, nowMs: atMs, monotonicMs: atMs - now },
    }).nextWakeAtMs!;
  }
  const wallMs = performance.now() - wallStart;
  const used = process.threadCpuUsage(cpu);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedStart;
  const changes =
    Number(database.db.prepare("SELECT total_changes() AS changes").get()?.changes) - changesStart;
  if (values.profile) {
    await writeFile(
      `${output}.cpuprofile`,
      JSON.stringify((await inspector.post("Profiler.stop")).profile),
    );
  }
  const current = loadCronStoreFromDatabase(database.db, storeKey).store.jobs.find(
    (job) => job.id === "synthetic-0",
  )!;
  assert.equal(current.state.nextRunAtMs, dueAt, "Deferred work must retain its occurrence");
  const receipts = Number(
    database.db
      .prepare("SELECT COUNT(*) AS count FROM cron_run_receipts WHERE store_key = ?")
      .get(storeKey)?.count,
  );
  const report = {
    scope:
      "Admitted synchronous cron worker owner; first deferral is cold; ten modeled minutes at two-second observation cadence; no provider or transport",
    revision: values.revision ?? "working-tree",
    node: process.version,
    jobCount,
    schedulerTicks,
    launches,
    receipts,
    sqliteRowChanges: changes,
    wallMs,
    threadCpuMs: (used.user + used.system) / 1000,
    allocatedBytes,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    nextWakeDelayMs: nextWake - dueAt,
    waiting: current.state.admissionDeferred,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  inspector.disconnect();
  stopCronSchedulerInWorker({ storeKey, channelName });
  await closeOpenClawStateDatabaseAsync();
  await rm(root, { recursive: true, force: true });
}
