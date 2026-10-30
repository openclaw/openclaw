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
 * --workload runs instead executes four concurrent mock job executions per iteration
 * through the service's real request, queue, finalization, and refresh owners.
 * Add --count-commands for a separate producer census; its instrumentation distorts
 * CPU/allocation and those fields must not be used as performance evidence.
 * Counts/min use 20 synthetic completed runs/min,
 * not an estimate of the production request mix.
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
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CronJob } from "../../src/cron/types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    owner: { type: "string" },
    output: { type: "string" },
    iterations: { type: "string", default: "100" },
    workload: { type: "string", default: "refresh" },
    "count-commands": { type: "boolean", default: false },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
assert(values.workload === "refresh" || values.workload === "runs");
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
const { run } = await import("../../src/cron/service/ops-run.js");
const { waitForCronRunQueue } = await import("../../src/cron/service/run-queue.js");
const { saveCronStore, loadCronStore } = await import("../../src/cron/store.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
let nowMs = Date.now();
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
    ...(values.workload === "refresh" && index < 3
      ? { runningAtMs: nowMs, runningReceiptId: `synthetic-run-${index}` }
      : {}),
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
    assert.equal(values.workload, "runs", "Future jobs must not run during refresh measurement");
    return { status: "ok", summary: "Synthetic provider completed" };
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
let queued = 0;
let writerMs = 0;
let changed = () => {};
const burstSize = 20;
const warmup = 5;
const commands = new Map<string, number>();
const postDescriptor = Object.getOwnPropertyDescriptor(Worker.prototype, "postMessage");
const originalPost: unknown = postDescriptor?.value;
assert(postDescriptor && typeof originalPost === "function");
if (values["count-commands"]) {
  Worker.prototype.postMessage = function (...args: Parameters<Worker["postMessage"]>) {
    const [request] = args;
    if (isRecord(request) && request.type === "execute" && request.input instanceof Uint8Array) {
      const command: unknown = deserialize(request.input);
      if (
        isRecord(command) &&
        typeof command.type === "string" &&
        command.type.startsWith("cron.")
      ) {
        commands.set(command.type, (commands.get(command.type) ?? 0) + 1);
      }
    }
    Reflect.apply(originalPost, this, args);
  };
}

async function burst() {
  if (values.workload === "runs") {
    nowMs += 100;
    const results = await Promise.all(jobs.slice(0, 4).map((job) => run(state, job.id, "force")));
    assert(results.every((result) => result.ok && "ran" in result && result.ran));
    await waitForCronRunQueue(state);
    // Join post-completion scheduler refreshes before the next measurement unit.
    await nextTurn();
    if (completed < queued) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Cron run requests did not settle")),
          30_000,
        );
        changed = () => {
          if (completed >= queued) {
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
    return;
  }
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
  commands.clear();
  setDiagnosticsEnabledForProcess(true);
  unsubscribe = onWorkerRequestMetrics((kind, requestClass, phase, _depth, _wait, durationMs) => {
    if (kind !== "sqlite_writer" || requestClass !== "cron") {
      return;
    }
    if (phase === "queued") {
      queued++;
    }
    if (phase === "completed") {
      completed++;
      writerMs += durationMs ?? 0;
      changed();
    }
  });
  for (let index = 0; index < warmup; index++) {
    await burst();
  }
  preparations = completed = queued = writerMs = 0;
  commands.clear();
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
  const measuredCommands = Object.fromEntries(commands);
  unsubscribe();
  const after = await loadCronStore(storePath);
  if (values.workload === "refresh") {
    assert.deepEqual(after, before);
  } else {
    assert(after.jobs.slice(0, 4).every((job) => job.state.lastRunStatus === "ok"));
  }
  const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
  const notifications = values.workload === "refresh" ? iterations * burstSize : undefined;
  const report = {
    scope:
      values.workload === "runs"
        ? "Real cron request/queue/finalization owners with mock job execution; no whole-Gateway claim"
        : "Real cron refresh host and SQLite worker; no job execution or whole-Gateway claim",
    mode: values.mode,
    workload: values.workload,
    node: process.version,
    owner: ownerUrl.href,
    ownerSha256,
    iterations,
    burstSize: values.workload === "refresh" ? burstSize : 4,
    notifications,
    jobs: jobs.length,
    activeJobMarkers: values.workload === "refresh" ? 3 : 0,
    warmupBursts: warmup,
    workerRequests: measuredRequests,
    commandCensus: values["count-commands"],
    commands: measuredCommands,
    ...(values.workload === "runs"
      ? {
          syntheticRunsPerMinute: 20,
          writerRequestsPerSyntheticMinute: (measuredRequests / iterations) * 5,
        }
      : {}),
    writerMs,
    elapsedMs,
    processCpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
    mainThreadCpuMs: (threadUsed.user + threadUsed.system) / 1000,
    sampledMainThreadBytes: profile ? sampledBytes(profile.head) : null,
    unchangedJobs: values.workload === "refresh",
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
  if (values["count-commands"]) {
    Object.defineProperty(Worker.prototype, "postMessage", postDescriptor);
  }
  inspector.disconnect();
  state.stopped = true;
  await owner.stopCronScheduler(state);
  await scheduler.stop();
  await closeOpenClawAgentDatabasesAsync(stateDir);
  await closeOpenClawStateDatabaseAsync();
  await rm(stateDir, { recursive: true, force: true });
}
