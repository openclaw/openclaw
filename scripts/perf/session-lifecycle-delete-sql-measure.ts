/**
 * Native deletion-owner proof on synthetic retained history; no Gateway/model/transport claim.
 * nice -n 19 node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-lifecycle-delete-sql-measure.ts --state-dir .local/lane2033/large
 * Defaults: 1M transcript rows, 10k sessions, 36 KiB/event (~35 GiB), 12,497 completions,
 * 14 deliveries. Completion outcome bodies are synthetic 4 KiB, not sampled production data.
 * --transcript-rows 1000 --payload-bytes 512 provides a setup smoke. Use a fresh directory.
 * The same real reclamation entry kernel runs inside canonical agent writer transactions.
 * Rollback restores identical rows after each sample; timing includes rollback, excludes admission
 * before BEGIN and worker receipt transport. Two A/A controls precede five counterbalanced pairs.
 * Separate heap-sampling passes include collected JS allocations, not native SQLite allocation.
 * Acceptance: preserved fixture census/digest, completion/delivery scans removed, shorter median
 * writer hold and CPU without a material allocation regression. Index build costs are reported.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { SqliteSessionReclamationPlan } from "../../src/config/sessions/session-accessor.sqlite-lifecycle-types.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "transcript-rows": { type: "string", default: "1000000" },
    "payload-bytes": { type: "string", default: "36864" },
    samples: { type: "string", default: "5" },
    iterations: { type: "string", default: "20" },
  },
});
assert(values["state-dir"], "--state-dir must identify a fresh synthetic fixture directory");
assert(global.gc, "Run with --expose-gc");
const root = path.resolve(values["state-dir"]);
assert(!existsSync(root), "Use a fresh state directory; existing data is never replaced");
mkdirSync(root, { recursive: true });
const integer = (key: "transcript-rows" | "payload-bytes" | "samples" | "iterations") =>
  parseStrictIntegerOption({ raw: values[key], label: `--${key}`, min: 1, fallback: 1 });
const transcriptRows = integer("transcript-rows");
const payloadBytes = integer("payload-bytes");
const samples = integer("samples");
const iterations = integer("iterations");
const sessionCount = 10_000;
const completionCount = 12_497;
const deliveryCount = 14;
const completionOutcomeBytes = 4096;
const indexes = [
  {
    name: "idx_agent_session_input_completions_session_key",
    sql: "CREATE INDEX IF NOT EXISTS idx_agent_session_input_completions_session_key ON session_input_completions(session_key)",
  },
  {
    name: "idx_agent_conversation_deliveries_source_session",
    sql: "CREATE INDEX IF NOT EXISTS idx_agent_conversation_deliveries_source_session ON conversation_deliveries(source_session_key, operation_id)",
  },
];
// Keep the baseline admission contract fixed while the candidate adds harmless extra indexes.
// This avoids reopening baseline samples through a candidate owner that repairs the missing index.
const schemaUrl = new URL("../../src/state/openclaw-agent-schema.ts", import.meta.url);
const schema = readFileSync(
  new URL("../../src/state/openclaw-agent-schema.sql", import.meta.url),
  "utf8",
);
const baselineSchema = indexes.reduce(
  (sql, index) =>
    sql.replace(new RegExp(`CREATE INDEX IF NOT EXISTS ${index.name}\\b[^;]*;`, "gu"), ""),
  schema,
);
registerHooks({
  load(url, context, nextLoad) {
    return url === schemaUrl.href
      ? {
          format: "module",
          source: `export const OPENCLAW_AGENT_SCHEMA_SQL = ${JSON.stringify(baselineSchema)};`,
          shortCircuit: true,
        }
      : nextLoad(url, context);
  },
});
const options = {
  agentId: "main",
  path: path.join(root, "agent.sqlite"),
  env: {
    ...process.env,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  },
};
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: options.env.OPENCLAW_CONFIG_PATH,
});
writeFileSync(options.env.OPENCLAW_CONFIG_PATH, "{}\n");
const {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  closeOpenClawAgentDatabasesAsync,
} = await import("../../src/state/openclaw-agent-db.js");
const { readLifecycleTargetSnapshot } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const { readSessionStateDeleteSnapshot } =
  await import("../../src/config/sessions/session-accessor.sqlite-delete-snapshot.js");
const { reclaimSqliteSessionInTransaction, resolveSessionReclamationDatabaseOptions } =
  await import("../../src/config/sessions/session-accessor.sqlite-reclamation.js");
const database = openOpenClawAgentDatabase(options);
const { db } = database;
const outputs: unknown[] = [];
const record = (value: unknown) => {
  outputs.push(value);
  console.log(JSON.stringify(value));
  writeFileSync(path.join(root, "measurements.json"), JSON.stringify(outputs, null, 2) + "\n");
};
const key = (index: number) => `agent:main:synthetic-${index}`;
const id = (index: number) => `synthetic-${index}`;
const targetKey = "agent:main:delete-target";
const targetId = "delete-target";
const targetEntry = { sessionId: targetId, updatedAt: 1 };
const setupStart = performance.now();
const node = db.prepare(
  "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at,entry_valid) VALUES(?,?,?,1,1)",
);
const window = db.prepare(
  "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES(?,?,1,1)",
);
runOpenClawAgentWriteTransaction(() => {
  for (let index = 0; index < sessionCount; index++) {
    node.run(key(index), id(index), JSON.stringify({ sessionId: id(index), updatedAt: 1 }));
    window.run(id(index), key(index));
  }
  node.run(targetKey, targetId, JSON.stringify(targetEntry));
  window.run(targetId, targetKey);
  const insert = db.prepare(
    "INSERT INTO session_input_completions(session_key,session_id,idempotency_key,run_id,request_hash,outcome_json,succeeded,completed_at) VALUES(?,?,?,?,?,?,1,1)",
  );
  const outcome = JSON.stringify({ synthetic: "x".repeat(completionOutcomeBytes) });
  for (let index = 0; index < completionCount; index++) {
    const target = index === 0;
    insert.run(
      target ? targetKey : key(index % sessionCount),
      target ? targetId : id(index % sessionCount),
      `key-${index}`,
      `run-${index}`,
      "synthetic",
      outcome,
    );
  }
  db.exec(
    "INSERT INTO conversations(conversation_id,channel,account_id,kind,peer_id,delivery_target,created_at,updated_at) VALUES('conversation','synthetic','synthetic','direct','synthetic','synthetic',1,1)",
  );
  const delivery = db.prepare(
    "INSERT INTO conversation_deliveries(operation_id,operation_kind,conversation_id,source_session_key,message_hash,status,created_at,updated_at) VALUES(?,'send','conversation',?,'synthetic','sent',1,1)",
  );
  for (let index = 0; index < deliveryCount; index++) {
    delivery.run(`delivery-${index}`, index === 0 ? targetKey : key(index));
  }
  db.exec(
    "INSERT INTO cache_entries(scope,key,value_json,updated_at) VALUES('conversation-progress','delivery-0','{}',1)",
  );
}, options);
const transcript = db.prepare(
  "INSERT INTO transcript_events(session_id,seq,event_json,created_at,navigation_type,message_role) VALUES(?,?,?,1,'message','toolResult')",
);
const payload = JSON.stringify({
  type: "message",
  message: {
    role: "toolResult",
    content: [
      {
        type: "text",
        text: "synthetic ".repeat(Math.ceil(payloadBytes / 10)).slice(0, payloadBytes),
      },
    ],
  },
});
for (let offset = 0; offset < transcriptRows; offset += 2000) {
  runOpenClawAgentWriteTransaction(
    () => {
      for (let index = offset; index < Math.min(offset + 2000, transcriptRows); index++) {
        transcript.run(id(index % sessionCount), Math.floor(index / sessionCount) + 1, payload);
      }
    },
    options,
    { operationLabel: "benchmark.seed" },
  );
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  if (offset % 100_000 === 0) {
    record({
      phase: "seed",
      rows: Math.min(offset + 2000, transcriptRows),
      elapsedMs: performance.now() - setupStart,
    });
  }
}
const scalar = (sql: string) => Number(db.prepare(sql).get()?.n);
const census = () => ({
  nodes: scalar("SELECT count(*) AS n FROM session_nodes"),
  windows: scalar("SELECT count(*) AS n FROM session_windows"),
  transcript: scalar("SELECT count(*) AS n FROM transcript_events"),
  completions: scalar("SELECT count(*) AS n FROM session_input_completions"),
  deliveries: scalar("SELECT count(*) AS n FROM conversation_deliveries"),
  cache: scalar("SELECT count(*) AS n FROM cache_entries WHERE scope='conversation-progress'"),
});
const digest = () => {
  const hash = createHash("sha256");
  for (const sql of [
    "SELECT session_key,current_session_id,entry_json FROM session_nodes ORDER BY session_key",
    "SELECT session_key,session_id,idempotency_key,outcome_json FROM session_input_completions ORDER BY session_id,idempotency_key",
    "SELECT * FROM conversation_deliveries ORDER BY operation_id",
    "SELECT event_json FROM transcript_events WHERE session_id='synthetic-42' ORDER BY seq",
  ]) {
    for (const row of db.prepare(sql).iterate()) {
      hash.update(JSON.stringify(row)).update("\n");
    }
  }
  return hash.digest("hex");
};
const initial = { census: census(), digest: digest() };
record({
  phase: "fixture",
  sourceSchemaSha256: createHash("sha256").update(baselineSchema).digest("hex"),
  node: process.version,
  sqlite: db.prepare("SELECT sqlite_version() AS version").get(),
  bytes: statSync(database.path).size,
  transcriptRows,
  payloadBytes: Buffer.byteLength(payload),
  completionOutcomeBytes,
  ...initial,
  seedMs: performance.now() - setupStart,
});
const rollback = new Error("restore synthetic deletion input");
const nativeExec = db.exec.bind(db);
let transactionStarted: number | undefined;
let writerHoldMs = 0;
db.exec = (sql) => {
  if (sql === "BEGIN IMMEDIATE") {
    const result = nativeExec(sql);
    transactionStarted = performance.now();
    return result;
  }
  try {
    return nativeExec(sql);
  } finally {
    if ((sql === "ROLLBACK" || sql === "COMMIT") && transactionStarted !== undefined) {
      writerHoldMs += performance.now() - transactionStarted;
      transactionStarted = undefined;
    }
  }
};
const plan: Extract<SqliteSessionReclamationPlan, { kind: "entry" }> = {
  kind: "entry",
  databaseOptions: resolveSessionReclamationDatabaseOptions(options),
  deleteParams: {
    agentId: "main",
    storePath: database.path,
    target: { canonicalKey: targetKey, storeKeys: [targetKey] },
    archiveTranscript: false,
    deleteTranscriptWithoutArchive: true,
    deleteDeliveryArtifacts: true,
    expectedEntry: targetEntry,
  },
  preparedTargetSnapshot: readLifecycleTargetSnapshot(database, {
    canonicalKey: targetKey,
    storeKeys: [targetKey],
  }),
  materializedPlans: [
    {
      agentId: "main",
      archiveDirectory: path.join(root, "archives"),
      archiveTranscript: false,
      databasePath: database.path,
      reason: "deleted",
      sessionId: targetId,
      snapshot: readSessionStateDeleteSnapshot(db, targetId),
      archive: null,
      archivedTranscript: null,
    },
  ],
};
function remove(deletionPlan = plan, removedNode = true) {
  try {
    runOpenClawAgentWriteTransaction(
      () => {
        const result = reclaimSqliteSessionInTransaction(deletionPlan);
        assert(result.kind === "entry" && result.value.deleted);
        assert.equal(
          scalar(
            "SELECT count(*) AS n FROM session_nodes WHERE session_key='agent:main:delete-target'",
          ),
          removedNode ? 0 : 1,
        );
        assert.equal(
          scalar(
            "SELECT count(*) AS n FROM conversation_deliveries WHERE operation_id='delivery-0'",
          ),
          0,
        );
        throw rollback;
      },
      options,
      { operationLabel: "session.lifecycle.delete" },
    );
  } catch (error) {
    if (error !== rollback) {
      throw error;
    }
  }
}
function indexArm(indexed: boolean) {
  for (const index of indexes) {
    db.exec(indexed ? index.sql : `DROP INDEX IF EXISTS ${index.name}`);
  }
  const nodePlan = db
    .prepare("EXPLAIN QUERY PLAN DELETE FROM session_nodes WHERE session_key=?")
    .all(targetKey);
  assert.equal(
    nodePlan.some((row) => row.detail === "SCAN session_input_completions"),
    !indexed,
  );
  const deliveryPlan = db
    .prepare("EXPLAIN QUERY PLAN DELETE FROM conversation_deliveries WHERE source_session_key=?")
    .all(targetKey);
  assert.equal(
    deliveryPlan.some((row) => row.detail === "SCAN conversation_deliveries"),
    !indexed,
  );
}
const inspector = new Session();
inspector.connect();
async function measure(mode: "timing" | "allocation", arm: string) {
  global.gc?.();
  if (mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuBefore = process.threadCpuUsage();
  const hostLoad = loadavg();
  const times: number[] = [];
  const writerHolds: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    writerHoldMs = 0;
    const started = performance.now();
    remove();
    times.push(performance.now() - started);
    writerHolds.push(writerHoldMs);
  }
  const cpu = process.threadCpuUsage(cpuBefore);
  const allocation =
    mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  record({
    phase: mode,
    arm,
    iterations,
    times,
    writerHolds,
    cpuMs: (cpu.user + cpu.system) / 1000,
    allocatedBytes: allocation ? sumSampledHeapBytes(allocation.profile.head) : undefined,
    hostLoad,
    rss: process.memoryUsage().rss,
  });
}
try {
  indexArm(false);
  remove();
  await measure("timing", "A/A-first");
  await measure("timing", "A/A-second");
  for (let sample = 0; sample < samples; sample++) {
    for (const indexed of sample % 2 === 0 ? [false, true] : [true, false]) {
      indexArm(indexed);
      await measure("timing", `${indexed ? "indexed" : "base"}-${sample}`);
    }
  }
  for (let sample = 0; sample < samples; sample++) {
    for (const indexed of sample % 2 === 0 ? [false, true] : [true, false]) {
      indexArm(indexed);
      await measure("allocation", `${indexed ? "indexed" : "base"}-${sample}`);
    }
  }
  indexArm(false);
  for (const index of indexes) {
    const builds = [];
    for (let sample = 0; sample < samples; sample++) {
      const before = process.threadCpuUsage();
      const start = performance.now();
      db.exec(index.sql);
      const cpu = process.threadCpuUsage(before);
      builds.push({ wallMs: performance.now() - start, cpuMs: (cpu.user + cpu.system) / 1000 });
      db.exec(`DROP INDEX ${index.name}`);
    }
    record({ phase: "index-build", name: index.name, builds });
  }
  assert.deepEqual(census(), initial.census);
  assert.equal(digest(), initial.digest);
  record({
    phase: "verified",
    ...initial,
    limitation:
      "Native owner/kernel with rollback; no worker transport, production tail attribution, native allocation, or btrfs/workspace proof. Transcript payload digest samples one untouched session; exact row counts cover all transcripts.",
  });
  // Maximum Board HTML envelope: one row-bound artifact delete may still free many pages.
  // zeroblob creates the fixture in SQLite without a 480 MiB JavaScript allocation.
  indexArm(true);
  runOpenClawAgentWriteTransaction(() => {
    db.prepare(
      "INSERT INTO board_tabs(session_key,tab_id,title,position,created_by,revision) VALUES(?,'synthetic','Synthetic',0,'user',1)",
    ).run(targetKey);
    const widget = db.prepare(
      "INSERT INTO board_widgets(session_key,name,tab_id,content_kind,html,sha256,view_generation,revision,size_w,size_h,position,created_by,created_at,updated_at) VALUES(?,?,'synthetic','html',zeroblob(10485760),'synthetic','synthetic',1,1,1,?,'user',1,1)",
    );
    for (let index = 0; index < 48; index++) {
      widget.run(targetKey, `widget-${index}`, index);
    }
  }, options);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const heavyPlan = {
    ...plan,
    materializedPlans: [],
    preparedTargetSnapshot: readLifecycleTargetSnapshot(database, plan.deleteParams.target),
    deleteParams: { ...plan.deleteParams, deleteTranscriptWithoutArchive: false },
  };
  for (let sample = 0; sample < 3; sample++) {
    writerHoldMs = 0;
    const cpuBefore = process.threadCpuUsage();
    const start = performance.now();
    remove(heavyPlan, false);
    const cpu = process.threadCpuUsage(cpuBefore);
    record({
      phase: "board-envelope",
      sample,
      widgetRows: 48,
      htmlBytes: 48 * 10 * 1024 ** 2,
      wallMs: performance.now() - start,
      writerHoldMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
    });
  }
  assert.equal(scalar("SELECT count(*) AS n FROM board_widgets"), 48);
} finally {
  inspector.disconnect();
  await closeOpenClawAgentDatabasesAsync();
}
