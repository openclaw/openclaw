/**
 * Synthetic schema-39 append-owner benchmark. Never reads production state.
 * Save pre-fix runtime-store.sqlite.ts/runtime-retention.sqlite.ts alongside their
 * originals as runtime-store.baseline-2045.ts/runtime-retention.baseline-2045.ts,
 * changing only the baseline store's retention import to the baseline module.
 * nice -n 19 node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/trajectory-runtime-append-hold.ts --state-dir .local/append-hold
 * Default: 1M 36-KiB transcript rows (~35 GiB), 10k sessions, 100k hot trajectory rows.
 * --transcript-rows 100 --sessions 100 --hot-rows 1000 is a setup smoke.
 * A/A then five counterbalanced pairs; timing and allocation run separately.
 * Acceptance: no per-append retention aggregate, reduced active-sweep hold, preserved
 * accounting, no material total CPU/allocation regression including deferred selection.
 * Excludes worker transport/live grants, startup, seeding, and global sweep discovery.
 * --reuse reuses only a matching completed synthetic fixture; --profile adds CPU traces.
 * --bulk-only adds a focused whole-window discard probe to an existing fixture.
 * Includes native COMMIT. No btrfs, filesystem-workspace or Gateway latency claim.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "transcript-rows": { type: "string", default: "1000000" },
    sessions: { type: "string", default: "10000" },
    "hot-rows": { type: "string", default: "100000" },
    samples: { type: "string", default: "5" },
    reuse: { type: "boolean", default: false },
    profile: { type: "boolean", default: false },
    "bulk-only": { type: "boolean", default: false },
  },
});
assert(global.gc && values["state-dir"], "Use --expose-gc and a fresh --state-dir");
const root = path.resolve(values["state-dir"]);
if (values.reuse) {
  const previous: Array<{
    phase?: string;
    transcriptRows?: number;
    hotRows?: number;
    sessions?: number;
  }> = JSON.parse(readFileSync(path.join(root, "results.json"), "utf8"));
  const fixture = previous.find((row) => row.phase === "fixture");
  assert(
    fixture &&
      fixture.transcriptRows === Number(values["transcript-rows"]) &&
      fixture.hotRows === Number(values["hot-rows"]) &&
      fixture.sessions === Number(values.sessions),
    "Reuse requires this benchmark's matching synthetic fixture",
  );
} else {
  assert(!existsSync(root), "Refusing to overwrite a fixture");
  mkdirSync(root, { recursive: true });
}
const integer = (key: "transcript-rows" | "sessions" | "hot-rows" | "samples") =>
  parseStrictIntegerOption({ raw: values[key], min: 1, fallback: 1, label: `--${key}` });
const [transcriptRows, sessions, hotRows, samples] = [
  integer("transcript-rows"),
  integer("sessions"),
  integer("hot-rows"),
  integer("samples"),
];
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
});
writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, "{}\n");
const {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction: transaction,
  closeOpenClawAgentDatabasesAsync,
} = await import("../../src/state/openclaw-agent-db.js");
const currentStore = await import("../../src/trajectory/runtime-store.sqlite.js");
const currentRetention = await import("../../src/trajectory/runtime-retention.sqlite.js");
// Pre-fix modules are temporary evidence, not production imports or test seams.
const beforeStore: typeof currentStore = await import(
  pathToFileURL(path.resolve("src/trajectory/runtime-store.baseline-2045.ts")).href
);
const beforeRetention: typeof currentRetention = await import(
  pathToFileURL(path.resolve("src/trajectory/runtime-retention.baseline-2045.ts")).href
);
const variants = {
  before: { ...beforeStore, ...beforeRetention },
  after: { ...currentStore, ...currentRetention },
};
const options = { agentId: "main", path: path.join(root, "agent.sqlite"), env: process.env };
const database = openOpenClawAgentDatabase(options);
const { db } = database;
const results: unknown[] = [];
const record = (result: unknown) => {
  results.push(result);
  console.log(JSON.stringify(result));
  writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2));
};
const event = { type: "tool.result", ts: "2026-10-01T00:00:00Z", data: "synthetic" };
const line = JSON.stringify(event);
const bytes = Buffer.byteLength(line) + 1;
const maxRuntimeBytes = 10 * 1024 * 1024;
assert(hotRows * bytes < maxRuntimeBytes, "Hot fixture must fit the real rolling budget");
const key = (n: number) => `agent:main:synthetic-${n}`;
const id = (n: number) => `synthetic-${n}`;
const started = performance.now();
if (!values.reuse) {
  const node = db.prepare(
    "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at,entry_valid) VALUES(?,?,?,1,1)",
  );
  const window = db.prepare(
    "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES(?,?,1,1)",
  );
  const insert = db.prepare(
    "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at,event_utf8_bytes) VALUES(?,?,?, ?,1,?)",
  );
  transaction(() => {
    for (let index = 0; index < sessions; index++) {
      node.run(key(index), id(index), JSON.stringify({ sessionId: id(index), updatedAt: 1 }));
      window.run(id(index), key(index));
      if (index) {
        for (let seq = 0; seq < 10; seq++) {
          insert.run(id(index), seq, `run-${seq % 3}`, line, bytes - 1);
        }
      }
    }
    for (let seq = 0; seq < hotRows; seq++) {
      insert.run(id(0), seq, `run-${seq % 10}`, line, bytes - 1);
    }
  }, options);
  const transcript = db.prepare(
    "INSERT INTO transcript_events(session_id,seq,event_json,created_at,navigation_type,message_role) VALUES(?,?,?,1,'message','toolResult')",
  );
  const payload = JSON.stringify({
    type: "message",
    message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(36864) }] },
  });
  for (let offset = 0; offset < transcriptRows; offset += 2000) {
    transaction(() => {
      for (let n = offset; n < Math.min(offset + 2000, transcriptRows); n++) {
        transcript.run(id(n % sessions), Math.floor(n / sessions) + 1, payload);
      }
    }, options);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (offset % 100000 === 0) {
      record({
        phase: "seed",
        rows: Math.min(offset + 2000, transcriptRows),
        elapsedMs: performance.now() - started,
      });
    }
  }
}
const plans = [
  "SELECT seq,coalesce(event_utf8_bytes,octet_length(event_json)) FROM trajectory_runtime_events WHERE session_id=? ORDER BY seq DESC",
  "SELECT seq,coalesce(event_utf8_bytes,octet_length(event_json)) FROM trajectory_runtime_events WHERE session_id=? ORDER BY seq ASC",
  "SELECT run_id,MAX(created_at),SUM(coalesce(event_utf8_bytes,octet_length(event_json))+1),COUNT(*) FROM trajectory_runtime_events WHERE session_id=? GROUP BY session_id,run_id",
  "DELETE FROM trajectory_runtime_events WHERE session_id=? AND seq<=0",
].map((sql) => ({ sql, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(id(0)) }));
record({
  phase: "fixture",
  size: statSync(database.path).size,
  transcriptRows,
  sessions,
  hotRows,
  hotBytes: hotRows * bytes,
  node: process.version,
  schema: db.prepare("PRAGMA user_version").get(),
  plans,
  load: loadavg(),
});
const nativeExec = db.exec.bind(db);
let measuring = false;
let begin = 0;
let holds: number[] = [];
db.exec = (sql) => {
  const result = nativeExec(sql);
  if (measuring && sql === "BEGIN IMMEDIATE") {
    begin = performance.now();
  }
  if (measuring && sql === "COMMIT") {
    holds.push(performance.now() - begin);
  }
  return result;
};
const inspector = new Session();
inspector.connect();
const snapshot = currentRetention.prepareTrajectoryRuntimeRetention(
  db,
  { sessionId: id(0) },
  Date.now(),
);
const baseBytes = snapshot.runs.reduce((sum, run) => sum + run.bytes, 0);
async function measure(
  variant: keyof typeof variants,
  mode: "timing" | "allocation",
  arm: string,
  batch: number,
  cold = false,
  discard = false,
) {
  const api = variants[variant];
  const lease = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(lease, 0, cold ? 0 : 1);
  const sweepId = api.beginTrajectoryRuntimeRetention(db, lease);
  let facts = { nextSeq: hotRows, retainedBytes: hotRows * bytes };
  global.gc?.();
  if (mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuStart = process.threadCpuUsage();
  const start = performance.now();
  holds = [];
  measuring = true;
  const appendMs: number[] = [];
  for (let index = 0; index < batch; index++) {
    const at = performance.now();
    facts = api.appendSqliteTrajectoryRuntimeEventsWithWriter(
      {
        sessionId: id(0),
        windowFacts: cold ? undefined : facts,
        maxRuntimeBytes,
        discardPrevious: discard && index === 0,
        events: [{ line, ts: event.ts, runId: "new-run" }],
      },
      database,
      (operationLabel, write) => transaction(write, options, { operationLabel }),
    ).receipt.windowFacts;
    appendMs.push(performance.now() - at);
  }
  measuring = false;
  const selectionStarted = performance.now();
  const selected = cold
    ? undefined
    : api.selectTrajectoryRuntimeRetentionBatch(db, { sweepId, snapshot });
  const selectionMs = performance.now() - selectionStarted;
  const wallMs = performance.now() - start;
  const cpu = process.threadCpuUsage(cpuStart);
  const allocation =
    mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  assert.equal(facts.nextSeq, hotRows + batch);
  assert.equal(facts.retainedBytes, ((discard ? 0 : hotRows) + batch) * bytes);
  if (selected) {
    // Protected target never deletes; all other fixture runs are deliberately old.
    const outcome = transaction(
      () => api.deleteTrajectoryRuntimeRetention(database, { ...selected, runs: [] }),
      options,
    );
    assert.equal(outcome.totalBytes, baseBytes + batch * bytes - (discard ? hotRows * bytes : 0));
    assert.equal(outcome.refresh, false);
  }
  Atomics.store(lease, 0, 0);
  record({
    phase: mode,
    variant,
    arm,
    batch,
    cold,
    discard,
    holds,
    appendMs,
    selectionMs,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    allocatedBytes: allocation ? sumSampledHeapBytes(allocation.profile.head) : undefined,
    load: loadavg(),
  });
  transaction(
    () =>
      db
        .prepare("DELETE FROM trajectory_runtime_events WHERE session_id=? AND seq>=?")
        .run(id(0), hotRows),
    options,
  );
  if (discard) {
    transaction(() => {
      const restore = db.prepare(
        "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at,event_utf8_bytes) VALUES(?,?,?,?,1,?)",
      );
      for (let seq = 0; seq < hotRows; seq++) {
        restore.run(id(0), seq, `run-${seq % 10}`, line, bytes - 1);
      }
    }, options);
  }
}
try {
  if (!values["bulk-only"]) {
    for (let warmup = 0; warmup < 5; warmup++) {
      for (const variant of ["before", "after"] as const) {
        await measure(variant, "timing", "warmup", 32);
      }
    }
    await measure("before", "timing", "A/A-1", 32);
    await measure("before", "timing", "A/A-2", 32);
    for (const mode of ["timing", "allocation"] as const) {
      for (let pair = 0; pair < samples; pair++) {
        for (const variant of pair % 2
          ? (["after", "before"] as const)
          : (["before", "after"] as const)) {
          await measure(variant, mode, `pair-${pair}`, 32);
          await measure(variant, mode, `single-${pair}`, 1);
        }
      }
    }
    for (let pair = 0; pair < samples; pair++) {
      await measure("after", "timing", `cold-${pair}`, 1, true);
    }
    for (let pair = 0; pair < samples; pair++) {
      await measure("after", "allocation", `cold-${pair}`, 1, true);
    }
  }
  for (let pair = 0; pair < samples; pair++) {
    for (const variant of pair % 2
      ? (["after", "before"] as const)
      : (["before", "after"] as const)) {
      await measure(variant, "timing", `discard-${pair}`, 1, false, true);
    }
  }
  if (values.profile) {
    await inspector.post("Profiler.enable");
    for (const variant of ["before", "after"] as const) {
      await inspector.post("Profiler.start");
      await measure(variant, "timing", "profile", 32);
      const { profile } = await inspector.post("Profiler.stop");
      writeFileSync(path.join(root, `${variant}.cpuprofile`), JSON.stringify(profile));
    }
  }
} finally {
  measuring = false;
  db.exec = nativeExec;
  inspector.disconnect();
  await closeOpenClawAgentDatabasesAsync();
}
