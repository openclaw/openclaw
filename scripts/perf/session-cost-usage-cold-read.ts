/**
 * Synthetic cold-usage refresh proof through the production host and worker entry.
 * Prepare once, then copy the CLOSED fixture to a fresh directory for every arm:
 *   node --import ./scripts/tsx.mjs scripts/perf/session-cost-usage-cold-read.ts \
 *     --prepare --state-dir "$PWD/.local/usage-fixture" --sessions 128 --events 64 --body-kib 16
 *   cp -R .local/usage-fixture .local/usage-base-1
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-cost-usage-cold-read.ts \
 *     --state-dir "$PWD/.local/usage-base-1" [--allocation | --writer-timing]
 * Run the same script against baseline and candidate source; never reuse mutated state.
 * Refresh runs once over every archived session; every per-session/date token and cost
 * result is checked independently. Cold marker loss counts restores in this isolated
 * flow. Process CPU/RSS cover all worker threads; sampled heap/GC/loop cover only the
 * main isolate. Reservation durations include preparation and delivery, not SQL-lock
 * time. This is owner integration proof, not whole-Gateway load/latency proof.
 * --allocation is a SEPARATE instrumented pass. Worker sampling starts at refresh;
 * workers created during refresh include their imports. Collected objects are included.
 * The output names missing worker profiles; missing coverage is not zero allocation.
 * --writer-timing separately traces native worker DatabaseSync.exec transactions:
 * successful BEGIN IMMEDIATE/EXCLUSIVE return through successful COMMIT/ROLLBACK
 * return. This matches the production SQLite transaction owner. BEGIN lock waits,
 * deferred/autocommit/main-thread transactions and other native APIs are excluded.
 * Missing worker reports or open transactions mean incomplete timing coverage.
 * Timing conclusions must use uninstrumented runs. Fixture creation is never timed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { zstdCompressSync } from "node:zlib";
import type { SessionColdRecord } from "../../src/config/sessions/session-cold-storage-codec.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { DB } from "../../src/state/openclaw-agent-db.generated.js";

const { values } = parseArgs({
  options: {
    prepare: { type: "boolean" },
    "state-dir": { type: "string" },
    sessions: { type: "string", default: "128" },
    events: { type: "string", default: "64" },
    "body-kib": { type: "string", default: "16" },
    allocation: { type: "boolean" },
    "writer-timing": { type: "boolean" },
  },
});
assert(values["state-dir"], "--state-dir is required");
assert(
  !(values.allocation && values["writer-timing"]),
  "Run allocation and writer timing separately",
);
const root = path.resolve(values["state-dir"]);
const options = { agentId: "main", path: path.join(root, "agent.sqlite") };
const stamp = Date.UTC(2026, 8, 1, 12);
const config: OpenClawConfig = {
  plugins: { enabled: false },
  agents: { entries: { main: { workspace: path.join(root, "workspace") } } },
  session: { store: options.path },
};
type Fixture = { sessions: number; events: number; bodyKiB: number };
const fixturePath = path.join(root, "fixture.json");
const positive = (value: string) => {
  const n = Number(value);
  assert(Number.isSafeInteger(n) && n > 0);
  return n;
};
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = path.join(root, "home");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
process.env.TMPDIR = path.join(root, "tmp");

const agent = await import("../../src/state/openclaw-agent-db.js");
const state = await import("../../src/state/openclaw-state-db.js");
const { executeSqliteQuerySync: query, getNodeSqliteKysely: sql } =
  await import("../../src/infra/kysely-sync.js");
const { formatSqliteSessionFileMarker } =
  await import("../../src/config/sessions/legacy-sqlite-marker.js");
const sessionId = (index: number) => `cold-usage-${index}`;
const fileFor = (index: number) =>
  formatSqliteSessionFileMarker({
    agentId: "main",
    storePath: options.path,
    sessionId: sessionId(index),
  });

async function prepare() {
  mkdirSync(root, { mode: 0o700 });
  for (const directory of ["home", "tmp", "workspace"]) {
    mkdirSync(path.join(root, directory));
  }
  writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
  const fixture: Fixture = {
    sessions: positive(values.sessions),
    events: positive(values.events),
    bodyKiB: positive(values["body-kib"]),
  };
  const { replaceSessionEntrySync } =
    await import("../../src/config/sessions/session-accessor.sqlite-entry.js");
  const { resolveSessionColdArchivePath, MAX_COLD_ARCHIVE_BYTES } =
    await import("../../src/config/sessions/session-cold-storage-codec.js");
  const text = "synthetic payload ".repeat(Math.ceil((fixture.bodyKiB * 1024) / 18));
  for (let index = 0; index < fixture.sessions; index++) {
    const id = sessionId(index);
    const generation = `usage-generation-${index}`;
    replaceSessionEntrySync(
      { agentId: "main", storePath: options.path, sessionKey: `agent:main:${id}` },
      { sessionId: id, updatedAt: stamp },
    );
    const records: SessionColdRecord[] = [
      { kind: "header", version: 1, sessionId: id, generation },
    ];
    let rawBytes = -1;
    for (let seq = 1; seq <= fixture.events; seq++) {
      const timestamp = stamp + (seq % 2) * 86_400_000;
      const event = {
        type: "message",
        id: `event-${seq}`,
        parentId: seq === 1 ? null : `event-${seq - 1}`,
        timestamp: new Date(timestamp).toISOString(),
        message: {
          role: "assistant",
          provider: "fixture",
          model: "fixture",
          timestamp,
          content: [{ type: "text", text }],
          usage: {
            input: 7,
            output: 3,
            totalTokens: 10,
            cost: { input: 0.007, output: 0.003, total: 0.01 },
          },
        },
      };
      const encoded = JSON.stringify(event);
      rawBytes += Buffer.byteLength(encoded) + 1;
      records.push({ kind: "event", row: { seq, event_json: encoded, created_at: timestamp } });
    }
    for (let seq = 1; seq <= fixture.events; seq++) {
      records.push({
        kind: "identity",
        row: {
          event_id: `event-${seq}`,
          seq,
          event_type: "message",
          parent_id: seq === 1 ? null : `event-${seq - 1}`,
          message_idempotency_key: null,
          created_at: stamp,
        },
      });
    }
    for (let seq = 1; seq <= fixture.events; seq++) {
      records.push({
        kind: "active",
        row: {
          active_position: seq - 1,
          event_seq: seq,
          message_position: seq - 1,
          context_eligible: 1,
        },
      });
    }
    records.push({
      kind: "index",
      row: {
        indexed_seq: fixture.events,
        leaf_event_id: `event-${fixture.events}`,
        needs_rebuild: 0,
        active_event_count: fixture.events,
        active_message_count: fixture.events,
        updated_at: stamp,
      },
    });
    const envelope = Buffer.from(records.map((record) => JSON.stringify(record)).join("\n"));
    assert(
      envelope.length <= MAX_COLD_ARCHIVE_BYTES,
      "Reduce --events or --body-kib below the archive chunk bound",
    );
    const bytes = zstdCompressSync(envelope);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const archivePath = resolveSessionColdArchivePath(options.path, `${hash}.jsonl.zst`);
    mkdirSync(path.dirname(archivePath), { recursive: true });
    writeFileSync(archivePath, bytes);
    agent.runOpenClawAgentWriteTransaction(({ db }) => {
      const k = sql<DB>(db);
      query(
        db,
        k
          .updateTable("session_windows")
          .set({ transcript_updated_at: stamp })
          .where("session_id", "=", id),
      );
      query(
        db,
        k
          .insertInto("transcript_rewrite_watermarks")
          .values({ session_id: id, generation, updated_at: stamp })
          .onConflict((oc) =>
            oc.column("session_id").doUpdateSet({ generation, updated_at: stamp }),
          ),
      );
      query(
        db,
        k.insertInto("session_transcript_cold_archives").values({
          session_id: id,
          generation,
          archive_name: `${hash}.jsonl.zst`,
          archive_sha256: hash,
          event_count: fixture.events,
          raw_bytes: rawBytes,
          archive_bytes: bytes.length,
          last_seq: fixture.events,
          archived_at: stamp,
          storage: "file",
          archive_blob: null,
        }),
      );
    }, options);
  }
  writeFileSync(fixturePath, JSON.stringify(fixture));
  console.log(JSON.stringify({ prepared: root, ...fixture }));
}

function installAllocationPreload() {
  const directory = path.join(root, "allocation");
  mkdirSync(directory);
  const preload = path.join(directory, "sample.cjs");
  writeFileSync(
    preload,
    `
const fs = require('node:fs');
const path = require('node:path');
const { threadId, isMainThread } = require('node:worker_threads');
if (!isMainThread) {
  const inspector = require('node:inspector');
  const directory = ${JSON.stringify(directory)};
  const session = new inspector.Session();
  let started = false;
  let stopped = false;
  const start = () => {
    if (started || stopped || !fs.existsSync(path.join(directory, 'start')) || fs.existsSync(path.join(directory, 'stop'))) return;
    started = true; session.connect();
    fs.writeFileSync(path.join(directory, threadId + '.started'), '');
    session.post('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  };
  start();
  const capture = () => session.post('HeapProfiler.getSamplingProfile', (error, result) => {
    if (!error) fs.writeFileSync(path.join(directory, threadId + '.json'), JSON.stringify(result.profile));
  });
  const timer = setInterval(() => {
    start();
    if (fs.existsSync(path.join(directory, 'stop'))) {
      if (started) { capture(); session.disconnect(); }
      stopped = true; clearInterval(timer);
    }
  }, 25); timer.unref();
  process.once('exit', () => { if (started && !stopped) capture(); });
}
`,
  );
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--require=${JSON.stringify(preload)}`]
    .filter(Boolean)
    .join(" ");
  return directory;
}

type WriterTiming = {
  threadId: number;
  completed: number;
  holdMs: number;
  maxHoldMs: number;
  openTransactions: number;
};

function installWriterTimingPreload() {
  const directory = path.join(root, "writer-timing");
  mkdirSync(directory);
  const preload = path.join(directory, "sample.cjs");
  writeFileSync(
    preload,
    `
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { threadId, isMainThread } = require('node:worker_threads');
if (!isMainThread) {
  const { DatabaseSync } = require('node:sqlite');
  const directory = ${JSON.stringify(directory)};
  const active = new Map();
  const result = { threadId, completed: 0, holdMs: 0, maxHoldMs: 0, openTransactions: 0 };
  let started = false;
  let stopped = false;
  const start = () => {
    if (started || stopped || !fs.existsSync(path.join(directory, 'start')) || fs.existsSync(path.join(directory, 'stop'))) return;
    started = true;
    fs.writeFileSync(path.join(directory, threadId + '.started'), '');
  };
  const capture = () => {
    if (!started) return;
    result.openTransactions = active.size;
    fs.writeFileSync(path.join(directory, threadId + '.json'), JSON.stringify(result));
  };
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    const command = sql.trim().replace(/;\\s*$/, '').toUpperCase();
    const begin = /^BEGIN (IMMEDIATE|EXCLUSIVE)$/.test(command);
    if (begin) start();
    const output = Reflect.apply(exec, this, [sql]);
    if (begin && started && !stopped) active.set(this, performance.now());
    else if ((command === 'COMMIT' || command === 'ROLLBACK') && active.has(this)) {
      const elapsed = performance.now() - active.get(this);
      active.delete(this);
      result.completed++; result.holdMs += elapsed;
      result.maxHoldMs = Math.max(result.maxHoldMs, elapsed);
    }
    return output;
  };
  start();
  const timer = setInterval(() => {
    start();
    if (fs.existsSync(path.join(directory, 'stop'))) {
      capture(); stopped = true; clearInterval(timer);
    }
  }, 25); timer.unref();
  process.once('exit', () => { if (!stopped) capture(); });
}
`,
  );
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--require=${JSON.stringify(preload)}`]
    .filter(Boolean)
    .join(" ");
  return directory;
}

async function measure() {
  const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
  const allocationDirectory = values.allocation ? installAllocationPreload() : undefined;
  const writerTimingDirectory = values["writer-timing"] ? installWriterTimingPreload() : undefined;
  const { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } =
    await import("../../src/config/runtime-snapshot.js");
  const { refreshCostUsageCacheForAgent } =
    await import("../../src/infra/session-cost-usage-aggregation.js");
  const { prepareUsageCostWorker, runUsageCostWorker } =
    await import("../../src/infra/session-cost-usage-worker-runtime.js");
  const { resolveUsageCostPricingFingerprint } =
    await import("../../src/infra/session-cost-usage-pricing-context.js");
  setRuntimeConfigSnapshot(config);
  const database = agent.openOpenClawAgentDatabase(options);
  const counts = () => {
    const k = sql<DB>(database.db);
    return {
      cold: query(
        database.db,
        k
          .selectFrom("session_transcript_cold_archives")
          .select((eb) => eb.fn.countAll<number>().as("n")),
      ).rows[0]!.n,
      hotRows: query(
        database.db,
        k.selectFrom("transcript_events").select((eb) => eb.fn.countAll<number>().as("n")),
      ).rows[0]!.n,
    };
  };
  const before = counts();
  assert.equal(before.cold, fixture.sessions, "Use a fresh copy of the prepared fixture");
  assert.equal(before.hotRows, 0);
  const sessionFiles = Array.from({ length: fixture.sessions }, (_, index) => fileFor(index));
  const requests = {
    config,
    agentId: "main",
    databasePath: options.path,
    storePath: options.path,
    sessionFiles,
  };
  // Resolve pricing before the measured refresh, as the UI ordinarily does.
  const prepared = prepareUsageCostWorker(requests);
  const fingerprint = await resolveUsageCostPricingFingerprint(config, prepared.agentDir);
  const reservations: {
    operation: string;
    writerExecutionMs: number;
    transactionCount?: number;
    workerOperations?: string[];
  }[] = [];
  const diagnostics = channel("openclaw.agent-database.reservation");
  const observe = (message: unknown) => {
    reservations.push(message as (typeof reservations)[number]);
  };
  const gc: { ms: number; count: number; maxMs: number } = { ms: 0, count: 0, maxMs: 0 };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.ms += entry.duration;
      gc.count++;
      gc.maxMs = Math.max(gc.maxMs, entry.duration);
    }
  });
  const allocation = values.allocation ? new Session() : undefined;
  allocation?.connect();
  assert(global.gc, "Run with --expose-gc");
  global.gc();
  if (allocation) {
    await allocation.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const tracingDirectory = allocationDirectory ?? writerTimingDirectory;
  if (tracingDirectory) {
    writeFileSync(path.join(tracingDirectory, "start"), "");
    await delay(50);
  }
  observer.observe({ entryTypes: ["gc"] });
  diagnostics.subscribe(observe);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const hostLoadBefore = loadavg();
  const baselineRss = process.memoryUsage.rss();
  let peakRss = baselineRss;
  let mainHeapPeak = process.memoryUsage().heapUsed;
  const sample = setInterval(() => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    mainHeapPeak = Math.max(mainHeapPeak, m.heapUsed);
  }, 5);
  const cpu = process.cpuUsage();
  const started = performance.now();
  let result: Awaited<ReturnType<typeof refreshCostUsageCacheForAgent>>;
  try {
    result = await refreshCostUsageCacheForAgent(requests);
  } finally {
    clearInterval(sample);
    diagnostics.unsubscribe(observe);
  }
  const elapsedMs = performance.now() - started;
  const usedCpu = process.cpuUsage(cpu);
  const peakProcessRss = process.resourceUsage().maxRSS * 1024;
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
  loop.disable();
  if (allocationDirectory && allocation) {
    writeFileSync(path.join(allocationDirectory, "stop"), "");
    const profile = await allocation.post("HeapProfiler.stopSampling");
    writeFileSync(path.join(allocationDirectory, "main.json"), JSON.stringify(profile.profile));
    allocation.disconnect();
    await delay(350);
  }
  if (writerTimingDirectory) {
    writeFileSync(path.join(writerTimingDirectory, "stop"), "");
    await delay(350);
  }
  await delay(0);
  observer.disconnect();
  assert.equal(result, "refreshed");
  const after = counts();
  const report = await runUsageCostWorker(prepared, {
    kind: "sessions",
    pricingFingerprint: fingerprint,
    sessions: sessionFiles.map((sessionFile) => ({ sessionFile })),
    dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
  });
  assert.equal(report.kind, "sessions");
  if (report.kind !== "sessions") {
    throw new Error("Unexpected report");
  }
  assert.equal(report.summaries.length, fixture.sessions);
  const verified = report.summaries.map((summary, index) => {
    assert(summary);
    assert.equal(summary.totalTokens, fixture.events * 10);
    assert(Math.abs(summary.totalCost - fixture.events * 0.01) < 1e-9);
    const daily = summary
      .dailyBreakdown!.map(({ date, tokens, cost }) => ({
        date,
        tokens,
        cost,
      }))
      .toSorted((a, b) => a.date.localeCompare(b.date));
    assert.deepEqual(
      daily.map((day) => ({ ...day, cost: Number(day.cost.toFixed(9)) })),
      [0, 1]
        .map((day) => {
          const count = day === 0 ? Math.floor(fixture.events / 2) : Math.ceil(fixture.events / 2);
          return {
            date: new Date(stamp + day * 86_400_000).toISOString().slice(0, 10),
            tokens: count * 10,
            cost: Number((count * 0.01).toFixed(9)),
          };
        })
        .filter((day) => day.tokens > 0),
    );
    return {
      session: index,
      tokens: summary.totalTokens,
      cost: summary.totalCost,
      daily,
    };
  });
  let sampledAllocationBytes: number | null = null;
  let missingWorkerProfiles: string[] = [];
  let sampledIsolates = 0;
  if (allocationDirectory) {
    const files = readdirSync(allocationDirectory);
    missingWorkerProfiles = files.filter(
      (file) => file.endsWith(".started") && !files.includes(file.replace(".started", ".json")),
    );
    const sum = (node: { selfSize: number; children?: (typeof node)[] }): number =>
      node.selfSize + (node.children ?? []).reduce((total, child) => total + sum(child), 0);
    sampledAllocationBytes = files
      .filter((file) => file.endsWith(".json"))
      .reduce((total, file) => {
        sampledIsolates++;
        return (
          total + sum(JSON.parse(readFileSync(path.join(allocationDirectory, file), "utf8")).head)
        );
      }, 0);
  }
  let writerTiming: { workers: WriterTiming[]; missingWorkerProfiles: string[] } | null = null;
  if (writerTimingDirectory) {
    const files = readdirSync(writerTimingDirectory);
    writerTiming = {
      workers: files
        .filter((file) => file.endsWith(".json"))
        .map((file) => JSON.parse(readFileSync(path.join(writerTimingDirectory, file), "utf8"))),
      missingWorkerProfiles: files.filter(
        (file) => file.endsWith(".started") && !files.includes(file.replace(".started", ".json")),
      ),
    };
  }
  console.log(
    JSON.stringify({
      scope: "production cold-usage refresh; isolated synthetic state",
      node: process.version,
      fixture,
      result,
      before,
      after,
      restores: before.cold - after.cold,
      elapsedMs,
      processCpuMs: (usedCpu.user + usedCpu.system) / 1000,
      baselineRss,
      peakRss,
      peakRssDelta: peakRss - baselineRss,
      peakProcessRss,
      mainHeapPeak,
      mainGc: gc,
      mainLoopP99Ms: loop.percentile(99) / 1e6,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      reservationCount: reservations.length,
      reservationExecutionMs: reservations.reduce((sum, row) => sum + row.writerExecutionMs, 0),
      reservations,
      writerTimingPass: Boolean(values["writer-timing"]),
      writerTiming,
      allocationPass: Boolean(values.allocation),
      sampledAllocationBytes,
      sampledIsolates,
      missingWorkerProfiles,
      usageDigest: createHash("sha256").update(JSON.stringify(verified)).digest("hex"),
    }),
  );
  clearRuntimeConfigSnapshot();
}

try {
  if (values.prepare) {
    await prepare();
  } else {
    await measure();
  }
} finally {
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
}
