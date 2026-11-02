/**
 * Real transcript lane burst/idle probe over 10,000 synthetic session rows.
 * Run paired arms from this tooling checkout against identical built workers:
 * node --import ./scripts/tsx.mjs scripts/perf/transcript-pool-idle-measure.ts \
 *   --built-root <built-checkout> --output "$PWD/.local/transcript-idle-candidate"
 * Baseline: add --owner-file <frozen-session-transcript-worker-resources.ts>.
 * --iterations 1000 --quiet-seconds 95 --sessions 10000 are the defaults.
 * Iterations are per lane per sustained stage (5,000 total requests by default).
 * Repeat with --mode allocation: collected-object main-thread sampling and the
 * existing worker startup preload are diagnostic passes, never latency gates.
 * Each arm runs concurrency 1 -> 8 -> 1, idles, then repeats to expose cold growth.
 * Five real history/search/projection/maintenance/discovery pools retain their
 * production limits (2/2/1/1/1); eight callers do not imply eight pool slots.
 * Usage, model-context/export and archive lanes are excluded. This measures lane
 * lifetime with presence reads, not their full payload mix or a Gateway load test.
 * RSS is process-wide; worker heaps come from native telemetry. Startup allocation
 * in workers is heap growth plus GC-reclaimed bytes, excluding native allocation.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "built-root": { type: "string" },
    "owner-file": { type: "string" },
    output: { type: "string" },
    iterations: { type: "string", default: "1000" },
    "quiet-seconds": { type: "string", default: "95" },
    sessions: { type: "string", default: "10000" },
    mode: { type: "string", default: "timing" },
  },
});
assert(values["built-root"] && values.output, "--built-root and --output are required");
assert(values.mode === "timing" || values.mode === "allocation");
const positive = (raw: string | undefined, label: string, fallback: number) =>
  parseStrictIntegerOption({ raw, label, fallback, min: 1 });
const iterations = positive(values.iterations, "iterations", 1000);
const quietMs = positive(values["quiet-seconds"], "quiet-seconds", 95) * 1000;
const sessions = positive(values.sessions, "sessions", 10000);
const root = path.resolve(values.output);
assert(!fs.existsSync(root), "--output must name a fresh synthetic directory");
fs.mkdirSync(root, { recursive: true });
for (const directory of ["home", "state", "tmp", "worker-profiles"]) {
  fs.mkdirSync(path.join(root, directory));
}
Object.assign(process.env, {
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  TMPDIR: path.join(root, "tmp"),
});
fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, "{}\n");
const builtRoot = path.resolve(values["built-root"]);
const sourceOwner = new URL(
  "../../src/config/sessions/session-transcript-worker-resources.ts",
  import.meta.url,
);
const ownerFile = values["owner-file"]
  ? path.resolve(values["owner-file"])
  : fileURLToPath(sourceOwner);
const workerFile = path.join(builtRoot, "dist/config/sessions/session-transcript.worker.js");
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const ownerHash = digest(ownerFile);
const workerHash = digest(workerFile);
const sourceEntrypoints = new URL(
  "../../src/infra/runtime-process-entrypoints.ts",
  import.meta.url,
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    return result.url === sourceEntrypoints.href
      ? {
          ...result,
          url: pathToFileURL(path.join(builtRoot, "dist/infra/runtime-process-entrypoints.js"))
            .href,
        }
      : result;
  },
  load(url, context, nextLoad) {
    // Keep the canonical module identity and its relative imports in this checkout.
    return nextLoad(url === sourceOwner.href ? pathToFileURL(ownerFile).href : url, context);
  },
});
if (values.mode === "allocation") {
  process.env.OPENCLAW_BENCH_POOL_CHURN_DIR = path.join(root, "worker-profiles");
  await import("./worker-pool-churn-preload.mjs");
}
const { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { resolveOpenClawAgentSqlitePath } =
  await import("../../src/state/openclaw-agent-db.paths.js");
const { withSessionHistoryWorkerDatabase } =
  await import("../../src/config/sessions/session-transcript-worker-runtime.js");
const { historyLane, transcriptSearchLane, projectionLane, maintenanceLane, targetDiscoveryLane } =
  await import("../../src/config/sessions/session-transcript-worker-resources.js");
const { getTrackedWorkerLifecycleSnapshot, sampleTrackedWorkerMemory } =
  await import("../../src/infra/worker-cpu.js");
const { resolveRuntimeProcessEntrypointUrl } =
  await import("../../src/infra/runtime-process-url.js");
assert.equal(
  resolveRuntimeProcessEntrypointUrl("sessionTranscript").href,
  pathToFileURL(workerFile).href,
);
const lanes = [
  historyLane,
  transcriptSearchLane,
  projectionLane,
  maintenanceLane,
  targetDiscoveryLane,
];
const database = {
  agentId: "main",
  env: process.env,
  path: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
};
const seededAt = performance.now();
runOpenClawAgentWriteTransaction(({ db }) => {
  // Offline fixture construction is outside every measured window.
  const node = db.prepare(`INSERT INTO session_nodes
    (session_key,current_session_id,entry_json,updated_at,status,entry_valid)
    VALUES (?,?,?,?,'done',1)`);
  const window = db.prepare(`INSERT INTO session_windows
    (session_id,session_key,created_at,updated_at,transcript_updated_at,status)
    VALUES (?,?,?,?,?,'done')`);
  for (let index = 0; index < sessions; index++) {
    const id = `synthetic-${index}`;
    const key = `agent:main:subagent:${id}`;
    node.run(
      key,
      id,
      JSON.stringify({ sessionId: id, updatedAt: index + 1, status: "done" }),
      index + 1,
    );
    window.run(id, key, index + 1, index + 1, index + 1);
  }
}, database);
await closeOpenClawAgentDatabasesAsync();
await closeOpenClawStateDatabaseAsync();
const seedMs = performance.now() - seededAt;
const script = "session-transcript.worker.js";
const percentile = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
    maxMs: sorted.at(-1),
  };
};
const stages: object[] = [];
let activeQueueSamples: number[] | undefined;
const taskChannel = channel("openclaw.worker.task");
const observeTask = (message: unknown) => {
  if (
    message &&
    typeof message === "object" &&
    "worker" in message &&
    message.worker === script &&
    "queueMs" in message &&
    typeof message.queueMs === "number"
  ) {
    activeQueueSamples?.push(message.queueMs);
  }
};
taskChannel.subscribe(observeTask);
const inspector = values.mode === "allocation" ? new Session() : undefined;
inspector?.connect();
const keepAlive = setInterval(() => {}, 1000);
const memory = async (label: string) => {
  sampleTrackedWorkerMemory({ refresh: true });
  await delay(100);
  const samples = sampleTrackedWorkerMemory({ refresh: false });
  const heaps = samples.workerHeaps.filter((worker) => worker.script === script);
  const result = {
    label,
    atEpochMs: Date.now(),
    hostLoad: loadavg(),
    process: process.memoryUsage(),
    lanes: lanes.map((lane) => ({ name: lane.name, ...lane.pool.getSnapshot() })),
    workerHeapUsedBytes: heaps.reduce((sum, worker) => sum + worker.heapUsed, 0),
    workerHeaps: heaps,
    missing: samples.workerMemoryMissing.filter((worker) => worker.script === script),
  };
  console.log(JSON.stringify({ phase: "memory", ...result }));
  return result;
};
const read = (index: number) =>
  withSessionHistoryWorkerDatabase(
    database,
    async (owner) => {
      assert(
        await owner.readEntryPresence({
          agentId: "main",
          databaseAgentId: "main",
          storePath: database.path,
          sessionKey: `agent:main:subagent:synthetic-${index % sessions}`,
          env: process.env,
        }),
        "Synthetic session presence was lost",
      );
    },
    lanes[index % lanes.length],
  );
const run = async (label: string, width: number, count: number) => {
  const latency: number[] = [];
  const laneLatency = lanes.map(() => [] as number[]);
  const queue: number[] = [];
  activeQueueSamples = queue;
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const hostLoadBefore = loadavg();
  const cpuBefore = process.cpuUsage();
  const mainBefore = process.threadCpuUsage();
  const start = performance.now();
  for (let offset = 0; offset < count; offset += width) {
    await Promise.all(
      Array.from({ length: Math.min(width, count - offset) }, async (_, slot) => {
        const at = performance.now();
        await read(offset + slot);
        const elapsed = performance.now() - at;
        latency.push(elapsed);
        laneLatency[(offset + slot) % lanes.length]!.push(elapsed);
      }),
    );
  }
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuBefore);
  const mainCpu = process.threadCpuUsage(mainBefore);
  activeQueueSamples = undefined;
  let sampledMainAllocationBytes: number | undefined;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledMainAllocationBytes = 0;
    const pending = [profile.head];
    while (pending.length) {
      const node = pending.pop()!;
      sampledMainAllocationBytes += node.selfSize;
      pending.push(...node.children);
    }
  }
  const result = {
    label,
    width,
    count,
    wallMs,
    latency: percentile(latency),
    laneLatency: lanes.map((lane, index) => ({
      name: lane.name,
      ...percentile(laneLatency[index]!),
    })),
    queueWait: percentile(queue),
    mainThreadCpuMs: (mainCpu.user + mainCpu.system) / 1000,
    processCpuMs: (cpu.user + cpu.system) / 1000,
    sampledMainAllocationBytes,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  };
  stages.push(result);
  console.log(JSON.stringify({ phase: "requests", ...result }));
};
const sustainedRequests = iterations * lanes.length;
try {
  await run("startup-single", 1, 1);
  await run("startup-burst", 8, 8);
  await run("warm-single", 1, sustainedRequests);
  await run("warm-burst", 8, sustainedRequests);
  await run("back-to-single", 1, sustainedRequests);
  const beforeQuiet = await memory("before-quiet");
  const quietStart = performance.now();
  await delay(quietMs);
  const afterQuiet = await memory("after-quiet");
  const observedQuietMs = performance.now() - quietStart;
  await run("regrow-single", 1, 1);
  await run("regrow-burst", 8, 8);
  await run("regrown-single", 1, sustainedRequests);
  await run("regrown-burst", 8, sustainedRequests);
  await run("regrown-back-to-single", 1, sustainedRequests);
  const afterRegrowth = await memory("after-regrowth");
  assert.equal(digest(ownerFile), ownerHash, "Owner changed during measurement");
  assert.equal(digest(workerFile), workerHash, "Built worker changed during measurement");
  const result = {
    mode: values.mode,
    node: process.version,
    ownerHash,
    workerHash,
    sessions,
    iterations,
    sustainedRequests,
    seedMs,
    quietMs,
    observedQuietMs,
    stages,
    beforeQuiet,
    afterQuiet,
    afterRegrowth,
    lifecycle: getTrackedWorkerLifecycleSnapshot(),
    gaps: [
      "Usage and model-context/export lanes excluded",
      "Presence-read payload, not Gateway turn mix",
      "Worker startup allocation excludes native allocations",
    ],
  };
  fs.writeFileSync(path.join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
} finally {
  inspector?.disconnect();
  taskChannel.unsubscribe(observeTask);
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  clearInterval(keepAlive);
}
