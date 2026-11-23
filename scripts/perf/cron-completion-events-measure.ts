/**
 * Real CronService admission, persistence and completion, with a synthetic runner.
 * node --import ./scripts/tsx.mjs scripts/perf/cron-completion-events-measure.ts \
 *   --output .local/cron-completion-events/candidate.json [--revision <base-sha>] \
 *   [--iterations 2000] [--allocations]
 * Run base/candidate in alternating order. Allocation sampling is a separate pass;
 * its CPU numbers are instrumentation context, not timing evidence. Each pass has
 * 200 resident jobs and 200 warmup completions outside the measurement. The callback
 * uses the real Gateway/hook projections and serializes once per event; it does
 * not simulate socket fanout. Acceptance: fewer events with identical final
 * client runtime state, lower owner CPU/allocation, and no changed run outcome.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CronJob } from "../../src/cron/types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    revision: { type: "string" },
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be positive");
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const root = await mkdtemp(path.join(path.dirname(output), "cron-completion-owner-"));
const configPath = path.join(root, "openclaw.json");
await mkdir(path.join(root, "home"));
await writeFile(
  configPath,
  JSON.stringify({ agents: { entries: { main: {} } }, plugins: { enabled: false } }),
);
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
};
const owner = "src/cron/service/timer-outcome-finalization.ts";
const url = pathToFileURL(path.resolve(owner)).href;
const source = values.revision
  ? execFileSync("git", ["show", `${values.revision}:${owner}`], {
      encoding: "utf8",
      env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
    })
  : await readFile(owner, "utf8");
let ownerLoaded = false;
// Both arms use identical native type erasure instead of mixing it with tsx transforms.
registerHooks({
  load(requested, context, next) {
    if (requested !== url) {
      return next(requested, context);
    }
    ownerLoaded = true;
    return { source, format: "module-typescript", shortCircuit: true };
  },
});

const { CronService } = await import("../../src/cron/service.js");
assert(ownerLoaded, "Finalizer overlay was not loaded");
const { saveCronStore } = await import("../../src/cron/store.js");
const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { toCronBroadcastEvent, toPluginCronChangedEvent } =
  await import("../../src/gateway/server-cron-plugin-job.js");
type Projection = ReturnType<typeof toCronBroadcastEvent>;
const jobCount = 200;
const minute = 60_000;
let nowMs = Date.parse("2026-10-01T00:00:00.000Z");
const storePath = path.join(root, "cron", "jobs.json");
const jobs: CronJob[] = Array.from({ length: jobCount }, (_, index) => ({
  id: `synthetic-${index}`,
  name: `Synthetic scheduled job ${index}`,
  agentId: "main",
  enabled: true,
  createdAtMs: nowMs - minute,
  updatedAtMs: nowMs - minute,
  schedule: { kind: "every", everyMs: minute, anchorMs: nowMs },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Synthetic completion measurement. ".repeat(20) },
  delivery: { mode: "none" },
  state: { nextRunAtMs: nowMs },
}));
const actions = new Map<string, number>();
const views = new Map<string, NonNullable<Projection["job"]>>();
let frameBytes = 0;
let runnerCalls = 0;
const scheduler = new GatewayScheduler();
const cron = new CronService({
  scheduler,
  storePath,
  cronEnabled: false,
  defaultAgentId: "main",
  nowMs: () => nowMs,
  log: { debug() {}, info() {}, warn() {}, error() {} },
  enqueueSystemEvent() {},
  runIsolatedAgentJob: async () => {
    runnerCalls++;
    return { status: "ok", summary: "Synthetic completion" };
  },
  onEvent(event) {
    const projected = toCronBroadcastEvent(event);
    toPluginCronChangedEvent(event, event.job);
    actions.set(event.action, (actions.get(event.action) ?? 0) + 1);
    frameBytes += Buffer.byteLength(
      JSON.stringify({ type: "event", event: "cron", payload: projected }),
    );
    if (projected.job) {
      views.set(event.jobId, projected.job);
    }
  },
});
const inspector = new Session();
const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
async function run(count: number) {
  for (let index = 0; index < count; index++) {
    const id = jobs[index % jobCount]!.id;
    const nextRunAtMs = cron.getJob(id)?.state.nextRunAtMs;
    assert(nextRunAtMs !== undefined, "Recurring job must keep its schedule");
    nowMs = Math.max(nowMs, nextRunAtMs);
    assert.deepEqual(await cron.run(id, "due"), { ok: true, ran: true });
  }
}
try {
  await saveCronStore(storePath, { version: 1, jobs });
  await cron.list({ includeDisabled: true });
  await run(jobCount);
  actions.clear();
  frameBytes = runnerCalls = 0;
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  await run(iterations);
  const wallMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  const allocationBytes = values.allocations
    ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  assert.equal(runnerCalls, iterations);
  assert.equal(actions.get("finished"), iterations);
  for (const job of await cron.list({ includeDisabled: true })) {
    assert.deepEqual(
      views.get(job.id),
      toCronBroadcastEvent({ action: "scheduled", jobId: job.id, job }).job,
      "The final event must leave the same client runtime row as cron.list",
    );
  }
  const report = {
    revision: values.revision ?? "working-tree",
    node: process.version,
    mode: values.allocations ? "allocation" : "timing",
    scope:
      "Real CronService with worker persistence and synthetic runner; Gateway projection without sockets",
    jobCount,
    iterations,
    actions: Object.fromEntries(actions),
    eventsPerCompletion: [...actions.values()].reduce((sum, count) => sum + count, 0) / iterations,
    frameBytesPerCompletion: frameBytes / iterations,
    wallMs,
    cpuUsPerCompletion: (used.user + used.system) / iterations,
    allocatedBytesPerCompletion:
      allocationBytes === undefined ? undefined : allocationBytes / iterations,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    finalRuntimeRowsMatch: true,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  inspector.disconnect();
  cron.stop();
  await cron.waitForIdle();
  await scheduler.stop();
  await closeOpenClawStateDatabaseAsync();
  await rm(root, { recursive: true, force: true });
}
