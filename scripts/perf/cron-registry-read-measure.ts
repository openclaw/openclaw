/**
 * Cron registry inventory through the real owner, with 40 synthetic plugin command
 * schedules and a retained session. A mix cycle includes 134 started-scheduler
 * list reads, 4 mocked-agent job runs (real durable receipts), 40 unchanged command
 * declarations, 60 passive reads, and 60 registry sweeps: one modeled hour. Counts describe this declared mix,
 * not attribution of production's aggregated cron request label.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-registry-read-measure.ts \
 *   --mode timing --iterations 5 --output .local/cron-registry/base.json
 * For a declared high-churn hour use --turns 120 --declaration-passes 60 (2 turns/min,
 * 40 identical declarations/min). These are stress assumptions, not measured Team rates.
 * Repeat --mode allocation independently; --workload registry isolates one sweep
 * per iteration. --owner-dir supplies a sparse repo-relative source overlay. --worker-root
 * uses already-built cron reader artifacts, avoiding source-loader cost. All state is synthetic.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CronStoredJob } from "../../src/cron/types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    "owner-dir": { type: "string" },
    workload: { type: "string", default: "mix" },
    "worker-root": { type: "string" },
    output: { type: "string" },
    iterations: { type: "string", default: "5" },
    turns: { type: "string", default: "4" },
    "declaration-passes": { type: "string", default: "1" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
assert(values.workload === "registry" || values.workload === "mix");
assert(values.output, "--output is required");
assert(global.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 5,
});
const turns = parseStrictIntegerOption({
  raw: values.turns,
  label: "--turns",
  min: 1,
  fallback: 4,
});
const declarationPasses = parseStrictIntegerOption({
  raw: values["declaration-passes"],
  label: "--declaration-passes",
  min: 1,
  fallback: 1,
});
assert(
  values.workload === "registry" || Math.ceil(turns / 40) * (iterations + 1) <= 100,
  "Requested turns exceed the real plugin command run budget",
);
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const stateDir = await mkdtemp(path.join(path.dirname(output), "synthetic-state-"));
const configPath = path.join(stateDir, "openclaw.json");
await mkdir(path.join(stateDir, "home"));
await mkdir(path.join(stateDir, "tmp"));
const config = { agents: { entries: { main: {} } }, plugins: { enabled: false } };
await writeFile(configPath, JSON.stringify(config));
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: stateDir,
  TMPDIR: path.join(stateDir, "tmp"),
};
const overlay = values["owner-dir"]
  ? path.resolve(values["owner-dir"])
  : path.join(stateDir, "overlay");
await mkdir(overlay, { recursive: true });
process.env.OPENCLAW_BENCH_BASELINE_DIR = overlay;
const workerThreads = createRequire(import.meta.url)(
  "node:worker_threads",
) as typeof import("node:worker_threads");
const NativeWorker = workerThreads.Worker;
await import("./worker-retained-heap-preload.ts");
// Only host owners differ; compiled workers are shared by both arms. Keep the
// overlay preload out of nested runtime children that deliberately filter env.
workerThreads.Worker = NativeWorker;
syncBuiltinESMExports();
if (values["worker-root"]) {
  const workerRoot = path.resolve(values["worker-root"]);
  workerThreads.Worker = class extends NativeWorker {
    constructor(filename: string | URL, options?: import("node:worker_threads").WorkerOptions) {
      const source = filename instanceof URL ? fileURLToPath(filename) : filename;
      const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
      const compiled = source.startsWith(sourceRoot)
        ? path.join(
            workerRoot,
            "dist",
            source.slice(sourceRoot.length).replace(/\.[cm]?ts$/, ".js"),
          )
        : undefined;
      const useCompiled = compiled && existsSync(compiled);
      super(
        useCompiled ? compiled : filename,
        useCompiled ? { ...options, execArgv: [] } : options,
      );
    }
  };
  syncBuiltinESMExports();
}
const owner = await import("../../src/cron/session-registry-maintenance.js");
const ownerFiles = [
  "src/cron/session-registry-maintenance.ts",
  "src/cron/service/schedule-maintenance.ts",
  "src/cron/service/store.ts",
  "src/cron/store/read-only.ts",
];
const ownerSha256 = createHash("sha256");
for (const file of ownerFiles) {
  const overlaid = path.join(overlay, file);
  ownerSha256.update(
    await readFile(existsSync(overlaid) ? overlaid : new URL(`../../${file}`, import.meta.url)),
  );
}
const ownerDigest = ownerSha256.digest("hex");
const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
const { setDiagnosticsEnabledForProcess } = await import("../../src/infra/diagnostic-events.js");
const { onWorkerRequestMetrics } = await import("../../src/infra/worker-request-diagnostics.js");
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { replaceSessionEntry, loadSessionEntry } =
  await import("../../src/config/sessions/session-accessor.js");
const { saveCronStore } = await import("../../src/cron/store.js");
const { CronService } = await import("../../src/cron/service.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { pluginCommandSchedule } =
  await import("../../src/cron/plugin-command-schedule.test-support.js");
const { PLUGIN_COMMAND_SCHEDULE_MESSAGE } =
  await import("../../src/cron/plugin-command-schedule.types.js");
setRuntimeConfigSnapshot(config);
const nowMs = Date.now();
const storePath = path.join(stateDir, "cron", "jobs.json");
const session = {
  storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
  sessionKey: "agent:main:cron:synthetic-0:run:active",
};
const jobs: CronStoredJob[] = Array.from({ length: 40 }, (_, index) => ({
  id: `synthetic-${index}`,
  name: `Synthetic interval ${index}`,
  declarationKey: `plugin:synthetic:${index}`,
  agentId: "main",
  enabled: true,
  createdAtMs: nowMs,
  updatedAtMs: nowMs,
  schedule: { kind: "every", everyMs: 86_400_000, anchorMs: nowMs },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: {
    kind: "agentTurn",
    message: PLUGIN_COMMAND_SCHEDULE_MESSAGE,
    toolsAllow: ["sessions_spawn", "agents_wait"],
  },
  pluginCommand: pluginCommandSchedule(nowMs, {
    maxRuns: 100,
    deadlineAtMs: nowMs + 7 * 86_400_000,
    parent: {
      agentId: "main",
      sessionKey: `agent:main:parent-${index}`,
      sessionId: `parent-${index}`,
    },
  }),
  delivery: { mode: "none" },
  state: { nextRunAtMs: nowMs + 86_400_000, pluginCommandRuns: 0 },
}));
const scheduler = new GatewayScheduler();
const errors: unknown[] = [];
let mockCalls = 0;
const deps = {
  scheduler,
  storePath,
  cronEnabled: true,
  defaultAgentId: "main",
  nowMs: () => nowMs,
  enqueueSystemEvent() {},
  runIsolatedAgentJob: async () => {
    mockCalls++;
    return { status: "ok" as const };
  },
  log: {
    debug() {},
    info() {},
    warn() {},
    error(error: unknown) {
      errors.push(error);
    },
  },
};
const active = new CronService(deps);
const passive = new CronService({ ...deps, cronEnabled: false });
const inspector = new Session();
let phase = "warmup";
let counts: Record<string, number> = {};
let unsubscribe = () => {};
async function registrySweep() {
  const result = await owner.runSessionRegistryMaintenance({
    apply: false,
    cronStorePath: storePath,
  });
  assert.equal(result.skippedReason, undefined);
}
async function cycle() {
  if (values.workload === "registry") {
    phase = "registry";
    await registrySweep();
    return;
  }
  phase = "list";
  for (let i = 0; i < 134; i++) {
    assert.equal((await active.listPage()).total, 40);
  }
  phase = "turns";
  const beforeTurns = mockCalls;
  for (let i = 0; i < turns; i++) {
    assert.deepEqual(await active.run(`synthetic-${i % jobs.length}`, "force"), {
      ok: true,
      ran: true,
    });
  }
  assert.equal(mockCalls - beforeTurns, turns, "Every requested turn must reach the mock provider");
  phase = "pluginDeclarations";
  for (let pass = 0; pass < declarationPasses; pass++) {
    for (const job of jobs) {
      const { state: _state, pluginCommand, ...input } = job;
      const result = await active.add(input, { pluginCommand });
      assert.equal("updated" in result ? result.updated : undefined, false);
    }
  }
  phase = "passive";
  for (let i = 0; i < 60; i++) {
    assert.equal((await passive.listPage()).total, 40);
  }
  phase = "registry";
  for (let i = 0; i < 60; i++) {
    await registrySweep();
  }
  assert.deepEqual(errors, []);
}
try {
  await saveCronStore(storePath, { version: 1, jobs: [] });
  for (const job of jobs) {
    const { state: _state, pluginCommand, ...input } = job;
    await active.add(input, { pluginCommand });
  }
  await replaceSessionEntry(session, { sessionId: "synthetic-active-session", updatedAt: nowMs });
  if (values.workload === "mix") {
    await active.start();
  }
  setDiagnosticsEnabledForProcess(true);
  unsubscribe = onWorkerRequestMetrics((kind, requestClass, event) => {
    if (kind === "sqlite_writer" && requestClass === "cron" && event === "completed") {
      counts[phase] = (counts[phase] ?? 0) + 1;
    }
  });
  await cycle();
  counts = {};
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
  const cpu = process.cpuUsage();
  const thread = process.threadCpuUsage();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    await cycle();
  }
  const elapsedMs = performance.now() - started;
  const processCpu = process.cpuUsage(cpu);
  const mainCpu = process.threadCpuUsage(thread);
  const profile =
    values.mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
  const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
  assert(loadSessionEntry(session));
  const report = {
    scope: "Cron owner synthetic mix, not Gateway or production-frequency attribution",
    ownerSha256: ownerDigest,
    mode: values.mode,
    iterations,
    workload: values.workload,
    jobs: jobs.length,
    listReads: values.workload === "mix" ? 134 * iterations : 0,
    mockTurns: values.workload === "mix" ? turns * iterations : 0,
    pluginDeclarations: values.workload === "mix" ? 40 * declarationPasses * iterations : 0,
    passiveReads: values.workload === "mix" ? 60 * iterations : 0,
    registrySweeps: (values.workload === "mix" ? 60 : 1) * iterations,
    cronWriterRequestsByPhase: counts,
    writerRequestsPerModeledMinute:
      values.workload === "mix"
        ? Object.values(counts).reduce((sum, n) => sum + n, 0) / (60 * iterations)
        : null,
    elapsedMs,
    processCpuMs: (processCpu.user + processCpu.system) / 1000,
    mainThreadCpuMs: (mainCpu.user + mainCpu.system) / 1000,
    sampledMainThreadBytes: profile ? sampledBytes(profile.head) : null,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    memory: process.memoryUsage(),
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  unsubscribe();
  inspector.disconnect();
  active.stop();
  passive.stop();
  await Promise.all([active.waitForIdle(), passive.waitForIdle()]);
  await scheduler.stop();
  await closeOpenClawAgentDatabasesAsync(stateDir);
  await closeOpenClawStateDatabaseAsync();
  await rm(stateDir, { recursive: true, force: true });
}
