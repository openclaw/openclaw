/**
 * Synthetic owner probe, not a Gateway or btrfs reproduction. No operator data.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/memory-origins-prune-measure.mjs <fresh-directory> [rows] [baseline-classifier.ts]
 * Default: 62,000 indexed files, ~1.1 GiB text, 5,000 session origins.
 * Only classification changes: one unchanged owner serves two A/A controls,
 * then five alternating A/B pairs on the same fixture and physical connection.
 * Acceptance is diagnostic coverage, not faster SQL: the owner is unchanged.
 * Reports warm owner CPU/wall time and a separate sampled-allocation pass.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyWorkerRequest } from "../../src/infra/sqlite-worker-request-class.ts";

assert(process.argv[2], "A fresh fixture directory is required");
assert(globalThis.gc, "Run with --expose-gc");
const root = path.resolve(process.argv[2]);
fs.mkdirSync(root);
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const rows = Number(process.argv[3] ?? 62_000);
assert(Number.isSafeInteger(rows) && rows > 0);
const baseline = process.argv[4]
  ? (await import(pathToFileURL(path.resolve(process.argv[4])).href)).classifyWorkerRequest
  : classifyWorkerRequest;
const { installDatabaseProcessRole } =
  await import("../../src/infra/database-engine/admission-scope.ts");
installDatabaseProcessRole("cli-oneshot");
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.ts");
const { bindSqliteWorkerBackend } =
  await import("../../extensions/memory-core/src/memory-entry-origins.worker.ts");
const target = openOpenClawAgentDatabase({
  agentId: "fixture",
  path: path.join(root, "agent.sqlite"),
});
const db = target.db;
let transactions = 0;
const backend = bindSqliteWorkerBackend(
  { kind: "origin" },
  {
    database: db,
    admit(stage) {
      transactions += stage === "transaction";
    },
  },
);
const inspector = new Session();
try {
  const body = "synthetic memory corpus ".repeat(830);
  const insert = db.prepare(`INSERT INTO memory_index_chunks
    (id,path,source,start_line,end_line,hash,model,text,embedding,updated_at)
    VALUES (?,?,'memory',1,1,?,'synthetic',?,X'',1)`);
  const origin = db.prepare(`INSERT INTO memory_entry_origins
    (entry_key,agent_id,session_id,origin_class,observed_at)
    VALUES (?,'fixture',?,'system',1)`);
  db.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < rows; index++) {
    const text =
      index % 100 === 0 ? `${body}<!-- openclaw-memory-promotion:retained-${index} -->` : body;
    insert.run(`chunk-${index}`, `memory/file-${index}.md`, `hash-${index}`, text);
  }
  for (let index = 0; index < 5_000; index++) {
    origin.run(`retained-${index}`, `session-${index}`);
  }
  db.exec("COMMIT");
  const command = { type: "prune", input: { agentId: "fixture", entryKeys: ["obsolete"] } };
  const run = (classify = classifyWorkerRequest) => {
    origin.run("obsolete", "session-obsolete");
    transactions = 0;
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    const requestClass = classify("database.domain.execute", { command });
    assert.equal(backend.execute(command), 1);
    const elapsedMs = performance.now() - started;
    const used = process.threadCpuUsage(cpu);
    assert.equal(transactions, 1);
    return { elapsedMs, cpuMs: (used.user + used.system) / 1000, transactions, requestClass };
  };
  const first = run();
  const hostLoad = loadavg();
  const samples = [];
  const arms = [
    "AA1",
    "AA2",
    "AA3",
    "AA4",
    ...Array.from({ length: 5 }, (_, i) => [`A${i}`, `B${i}`]).flat(),
  ];
  for (const arm of arms) {
    globalThis.gc();
    samples.push({ arm, ...run(arm.startsWith("A") ? baseline : classifyWorkerRequest) });
  }
  inspector.connect();
  const allocations = [];
  for (const [arm, classify] of [
    ["A", baseline],
    ["B", classifyWorkerRequest],
  ]) {
    globalThis.gc();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    run(classify);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocations.push({
      arm,
      sampledBytes: profile.samples.reduce((total, sample) => total + sample.size, 0),
    });
  }
  console.log(
    JSON.stringify({
      node: process.version,
      rows,
      sessionOrigins: 5_000,
      textBytes: rows * Buffer.byteLength(body),
      first,
      samples,
      allocations,
      hostLoad,
    }),
  );
} finally {
  inspector.disconnect();
  backend.close();
  await closeOpenClawAgentDatabasesAsync();
}
