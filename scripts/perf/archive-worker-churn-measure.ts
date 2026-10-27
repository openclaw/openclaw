/**
 * Real cold-maintenance owner, isolated synthetic state; no Gateway or live data.
 * node --import ./scripts/tsx.mjs scripts/perf/archive-worker-churn-measure.ts
 *   --output .local/archive-base --owner-dir /absolute/base-overlay --iterations 40
 * --owner-dir contains only replaced source files at their repository-relative paths;
 * the canonical worker-retained-heap preload applies these bytes in every isolate.
 * Repeat against candidate, counterbalancing order. Defaults: 10k finished windows,
 * two stores. --interval-ms 30000 measures cadence; default 0 isolates work counts.
 * Run --allocations separately: main Inspector sampling plus worker GCProfiler.
 * Worker first-result cost includes entry imports and one empty selection, excludes
 * the loader/preload prelude and native allocation. V8 estimate = heap delta + GC
 * reclaimed bytes, without forced GC. RSS is process-wide, never per-worker RSS.
 * Acceptance: identical empty sweeps and archive/restore bytes, fewer starts, lower
 * CPU and allocation per sweep. Seed and correctness checks are outside timing.
 * This owner benchmark makes no whole-Gateway latency or client-load claim.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "owner-dir": { type: "string" },
    iterations: { type: "string", default: "40" },
    sessions: { type: "string", default: "10000" },
    stores: { type: "string", default: "2" },
    "interval-ms": { type: "string", default: "0" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values.output, "--output must name a new, task-owned directory");
const root = path.resolve(values.output);
const owner = values["owner-dir"] ? path.resolve(values["owner-dir"]) : null;
const repository = fileURLToPath(new URL("../../", import.meta.url));
const integer = (value: string, min = 1) => {
  const number = Number(value);
  assert(Number.isSafeInteger(number) && number >= min, `invalid count: ${value}`);
  return number;
};
const iterations = integer(values.iterations);
const sessions = integer(values.sessions);
const stores = integer(values.stores);
const intervalMs = integer(values["interval-ms"], 0);
assert(sessions >= stores);
await mkdir(path.dirname(root), { recursive: true });
await mkdir(root);
for (const directory of ["home", "tmp", "state", "worker-profiles"]) {
  await mkdir(path.join(root, directory));
}
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  OPENCLAW_SKIP_CHANNELS: "1",
  TMPDIR: path.join(root, "tmp"),
});
// Both arms pay the same preload/hook cost, including when no source is replaced.
const overlay = owner ?? path.join(root, "empty-overlay");
if (!owner) {
  await mkdir(overlay);
}
process.env.OPENCLAW_BENCH_BASELINE_DIR = overlay;
await import("./worker-retained-heap-preload.ts");
const load = (relative: string) => import(pathToFileURL(path.join(repository, relative)).href);
const agentDb: typeof import("../../src/state/openclaw-agent-db.js") = await load(
  "src/state/openclaw-agent-db.ts",
);
const stateDb: typeof import("../../src/state/openclaw-state-db.js") = await load(
  "src/state/openclaw-state-db.ts",
);
const cold: typeof import("../../src/config/sessions/session-cold-storage.js") = await load(
  "src/config/sessions/session-cold-storage.ts",
);
const coldState: typeof import("../../src/config/sessions/session-cold-storage-state.js") =
  await load("src/config/sessions/session-cold-storage-state.ts");
const codec: typeof import("../../src/config/sessions/session-cold-storage-codec.js") = await load(
  "src/config/sessions/session-cold-storage-codec.ts",
);
const workers: typeof import("../../src/infra/worker-cpu.js") =
  await load("src/infra/worker-cpu.ts");
const lifecycle: typeof import("../../src/shared/global-singleton.js") = await load(
  "src/shared/global-singleton.ts",
);
const role: typeof import("../../src/infra/database-engine/admission-scope.js") = await load(
  "src/infra/database-engine/admission-scope.ts",
);
role.installDatabaseProcessRole("gateway");
const agentIds = Array.from({ length: stores }, (_, index) =>
  index ? `fixture-${index}` : "main",
);
const config: OpenClawConfig = {
  agents: { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) },
  session: { maintenance: { mode: "warn", coldStorage: { enabled: true, afterDays: 365000 } } },
};
await writeFile(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
const oldId = "synthetic-0";
const oldKey = "agent:main:subagent:synthetic-0";
const original = [
  { type: "session", id: oldId, version: 3 },
  { type: "message", id: "proof", message: { role: "assistant", content: "Synthetic 🦞 archive" } },
];
const seededAt = performance.now();
for (const [agentIndex, agentId] of agentIds.entries()) {
  agentDb.runOpenClawAgentWriteTransaction(
    ({ db }) => {
      // Offline synthetic fixture only; prepared inserts avoid timing fixture-generation SQL.
      const node = db.prepare(`INSERT INTO session_nodes
      (session_key,current_session_id,entry_json,updated_at,status,entry_valid)
      VALUES (?,?,?,?,'done',1)`);
      const window = db.prepare(`INSERT INTO session_windows
      (session_id,session_key,created_at,updated_at,transcript_updated_at,status)
      VALUES (?,?,?,?,?,'done')`);
      const watermark = db.prepare(`INSERT INTO transcript_rewrite_watermarks
      (session_id,generation,updated_at) VALUES (?,?,?)`);
      const event = db.prepare(`INSERT INTO transcript_events
      (session_id,seq,event_json,event_utf8_bytes,created_at) VALUES (?,?,?,?,?)`);
      for (let index = agentIndex; index < sessions; index += stores) {
        const sessionId = `synthetic-${index}`;
        const sessionKey = `agent:${agentId}:subagent:${sessionId}`;
        const now = index === 0 ? 1 : Date.now();
        node.run(
          sessionKey,
          sessionId,
          JSON.stringify({ sessionId, updatedAt: now, status: "done" }),
          now,
        );
        window.run(sessionId, sessionKey, now, now, now);
        watermark.run(sessionId, `generation-${index}`, now);
        const events = index === 0 ? original : [{ type: "session", id: sessionId, version: 3 }];
        for (const [seq, value] of events.entries()) {
          const json = JSON.stringify(value);
          event.run(sessionId, seq, json, Buffer.byteLength(json), now);
        }
      }
    },
    { agentId, env: process.env },
  );
}
await agentDb.closeOpenClawAgentDatabasesAsync();
await stateDb.closeOpenClawStateDatabaseAsync();
const seedMs = performance.now() - seededAt;
if (values.allocations) {
  process.env.OPENCLAW_ARCHIVE_CHURN_PROFILE_DIR = path.join(root, "worker-profiles");
  const preload = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "archive-worker-churn-preload.mjs"),
  ).href;
  const workerThreads: typeof import("node:worker_threads") = createRequire(import.meta.url)(
    "node:worker_threads",
  );
  const NativeWorker = workerThreads.Worker;
  // Runtime workers choose explicit execArgv. Instrument only this benchmark process,
  // preserving the source loader and leaving untraced timing passes untouched.
  workerThreads.Worker = class extends NativeWorker {
    constructor(filename: string | URL, options: import("node:worker_threads").WorkerOptions = {}) {
      const target =
        options.workerData?.type === "sqlite-transcript-archive-v2" &&
        ["cold-prepare", "archive-session"].includes(options.workerData.operation);
      super(
        filename,
        target
          ? {
              ...options,
              execArgv: [...(options.execArgv ?? process.execArgv), "--import", preload],
            }
          : options,
      );
    }
  };
  syncBuiltinESMExports();
}
const inspector = new Session();
const loop = monitorEventLoopDelay({ resolution: 10 });
const counts = () =>
  workers
    .getTrackedWorkerLifecycleSnapshot()
    .workerLifecycle.find(({ script }) => script === "session-accessor.sqlite-archive.worker.js");
const before = counts();
const memoryBefore = process.memoryUsage();
let peakRssBytes = memoryBefore.rss;
const sampler = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 25);
sampler.unref();
const measurements = [];
let sampledMainBytes: number | null = null;
let measurementEnd: ReturnType<typeof process.memoryUsage> | undefined;
try {
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  loop.enable();
  for (let iteration = 0; iteration < iterations; iteration++) {
    const started = performance.now();
    const cpu = process.cpuUsage();
    const thread = process.threadCpuUsage();
    const startedWorkers = counts()?.started ?? 0;
    const result = await cold.runSessionColdStorageMaintenance({ config });
    const used = process.cpuUsage(cpu);
    const main = process.threadCpuUsage(thread);
    assert.deepEqual(result, { archivedTranscripts: 0, externalizedTranscripts: 0 });
    measurements.push({
      elapsedMs: performance.now() - started,
      processCpuMs: (used.user + used.system) / 1000,
      mainThreadCpuMs: (main.user + main.system) / 1000,
      archiveStarts: (counts()?.started ?? 0) - startedWorkers,
      load: loadavg(),
    });
    if (iteration + 1 < iterations && intervalMs > 0) {
      await delay(Math.max(0, intervalMs - (performance.now() - started)));
    }
  }
  loop.disable();
  clearInterval(sampler);
  measurementEnd = process.memoryUsage();
  const after = counts();
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    await writeFile(path.join(root, "main.heapprofile"), JSON.stringify(profile));
    sampledMainBytes = 0;
    const nodes = [profile.head];
    for (const node of nodes) {
      sampledMainBytes += node.selfSize;
      nodes.push(...node.children);
    }
  }
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
  const workerProfiles = await Promise.all(
    (await readdir(path.join(root, "worker-profiles"))).map(async (file) =>
      JSON.parse(await readFile(path.join(root, "worker-profiles", file), "utf8")),
    ),
  );
  delete process.env.OPENCLAW_ARCHIVE_CHURN_PROFILE_DIR;
  const correctnessConfig: OpenClawConfig = {
    ...config,
    session: { maintenance: { mode: "warn", coldStorage: { enabled: true, afterDays: 30 } } },
  };
  assert.deepEqual(await cold.runSessionColdStorageMaintenance({ config: correctnessConfig }), {
    archivedTranscripts: 1,
    externalizedTranscripts: 0,
  });
  const options = { agentId: "main", env: process.env };
  const database = agentDb.openOpenClawAgentDatabase(options);
  const archive = coldState.readSessionColdTranscript(database.db, oldId);
  assert(archive);
  assert.equal(archive.storage, "file");
  const bytes = await codec.readVerifiedSessionColdArchive({
    storePath: database.path,
    archive: { ...archive, archive_blob: null },
  });
  const records = Array.from(codec.decodeSessionColdRecords(bytes, archive));
  assert.deepEqual(
    records
      .filter((record) => record.kind === "event")
      .map((record) => JSON.parse(record.row.event_json)),
    original,
  );
  await cold.restoreSessionColdTranscript({
    agentId: "main",
    storePath: database.path,
    sessionKey: oldKey,
    sessionId: oldId,
  });
  const restored = agentDb
    .openOpenClawAgentDatabase(options)
    .db.prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
    .all(oldId);
  assert.deepEqual(
    restored.map((row) => JSON.parse(String(row.event_json))),
    original,
  );
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
  await lifecycle.drainGlobalSingletonLifecycleState("close");
  const summary = {
    format: "archive-worker-churn-v1",
    owner,
    iterations,
    sessions,
    stores,
    intervalMs,
    allocations: values.allocations,
    seedMs,
    measurements,
    archiveStarts: (after?.started ?? 0) - (before?.started ?? 0),
    lifecycleBefore: before,
    lifecycleAfter: after,
    sampledMainBytes,
    memoryBefore,
    memoryAfter: measurementEnd,
    peakRssBytes,
    loop: { samples: loop.count, p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6 },
    workerProfiles,
    correctness: "one eligible archive and restored event bytes match",
    gaps: "Owner workload only. Worker V8 allocation is estimated; RSS is process-wide. First-result profiles include module load plus one preparation. Profiling timings are not gates.",
  };
  await writeFile(path.join(root, "result.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  clearInterval(sampler);
  loop.disable();
  if (values.allocations) {
    inspector.disconnect();
  }
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
  await lifecycle.drainGlobalSingletonLifecycleState("close");
  await (await import("esbuild")).stop();
}
