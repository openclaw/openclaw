/**
 * Synthetic lifecycle-delete SQL probe (no schema changes or live state).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-lifecycle-delete-measure.ts
 *   --output .local/delete-base --iterations 20 [--allocation]
 * Run serially on base/candidate, reversing order on the next pair. Compare CPU
 * and sampled V8 allocation (SQLite native allocations are not sampled), then
 * require identical remaining-row digests. Timings exclude fixture generation.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { deleteSessionEntryRows } from "../../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { readSessionReferenceOwners } from "../../src/config/sessions/session-accessor.sqlite-references.js";
import { deriveSessionPredicateColumns } from "../../src/config/sessions/session-predicate-columns.js";
import { runSqliteImmediateTransactionSync } from "../../src/infra/sqlite-transaction.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../src/state/openclaw-state-db.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    iterations: { type: "string", default: "20" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values.output, "--output must name a fresh fixture directory");
const output = path.resolve(values.output);
assert(!fs.existsSync(output), "Refusing to overwrite a fixture");
fs.mkdirSync(output, { recursive: true });
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 20,
});
const env = { OPENCLAW_STATE_DIR: path.join(output, "state") };
const database = openOpenClawAgentDatabase({ agentId: "main", env });
const db = database.db;
const key = (i: number) => `agent:main:subagent:${String(i).padStart(5, "0")}`;
const node = db.prepare(
  "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at,entry_valid,has_optional_references,parent_session_key) VALUES (?,?,?,1,1,?,?)",
);
const window = db.prepare(
  "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES (?,?,1,1)",
);
const event = db.prepare(
  "INSERT INTO transcript_events(session_id,seq,event_json,created_at) VALUES (?,?,?,1)",
);
runSqliteImmediateTransactionSync(db, () => {
  for (let i = 0; i < 10_000; i++) {
    const id = `session-${i}`;
    const entry = JSON.stringify({
      sessionId: id,
      updatedAt: 1,
      ...(i % 10 === 0
        ? {
            previousSessionId: i === 10 ? "session-9999" : `previous-${i}`,
            usageFamilySessionIds: [`previous-${i}`],
          }
        : {}),
      label: "x".repeat(16_384),
    });
    node.run(
      key(i),
      id,
      entry,
      deriveSessionPredicateColumns(entry).has_optional_references,
      i % 100 === 0 ? null : key(i - 1),
    );
    window.run(id, key(i));
    const count = i < 20 ? 2_000 : 4;
    for (let seq = 0; seq < count; seq++) {
      event.run(
        id,
        seq,
        JSON.stringify({
          type: "message",
          id: `event-${seq}`,
          message: { role: "user", content: "synthetic".repeat(128) },
        }),
      );
    }
  }
});
const excluded = new Set([key(9_998)]);
const candidates = ["session-9998"];
for (let i = 0; i < 3; i++) {
  readSessionReferenceOwners(database, excluded, candidates);
}
global.gc?.();
const inspector = new Session();
if (values.allocation) {
  await startCollectedHeapSampling(inspector, 4096);
}
const loadBefore = os.loadavg();
const cpu = process.cpuUsage();
const started = performance.now();
for (let i = 0; i < iterations; i++) {
  assert.equal(readSessionReferenceOwners(database, excluded, candidates).size, 0);
}
const wallMs = performance.now() - started;
const used = process.cpuUsage(cpu);
const sampledBytes = values.allocation
  ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
  : null;
inspector.disconnect();
// Use the actual deletion owner, including FK cascades, after measuring its SQL reader.
runSqliteImmediateTransactionSync(db, () => {
  for (const i of [0, 5_000, 9_999]) {
    deleteSessionEntryRows(database, key(i), { deleteOwnedWindows: true });
  }
});
const digest = createHash("sha256");
const counts: Record<string, number> = {};
for (const table of ["session_nodes", "session_windows", "transcript_events"]) {
  let count = 0;
  for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).iterate()) {
    digest.update(JSON.stringify(row));
    count++;
  }
  counts[table] = count;
}
const report = {
  iterations,
  wallMs,
  cpuMs: (used.user + used.system) / 1000,
  sampledBytes,
  loadBefore,
  loadAfter: os.loadavg(),
  memory: process.memoryUsage(),
  remaining: counts,
  digest: digest.digest("hex"),
};
fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
await closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);
await closeOpenClawStateDatabaseAsync();
fs.rmSync(env.OPENCLAW_STATE_DIR, { recursive: true, force: true });
