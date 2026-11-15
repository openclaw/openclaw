/**
 * Synthetic native lifecycle owner, including receipt production; no transport/production claim.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-lifecycle-rehome-measure.ts
 *   --output <fresh-directory> --baseline <commit> [--payload-bytes 524288]
 * Pins only the baseline deletion worker; unchanged dependencies are shared. Reversible samples
 * use the real outer transaction and roll back after receipt construction. A/A controls precede
 * five counterbalanced pairs; allocation is sampled separately, excluding native SQLite memory.
 * Acceptance: identical survivors and retained windows, no survivor CTE inside the candidate
 * writer, lower median/p95 hold, and no >20% CPU/allocation regression beyond A/A spread.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { prepareSessionDeletionInDatabase } from "../../src/config/sessions/session-accessor.sqlite-deletion-plan.js";
import { readLifecycleTargetSnapshot } from "../../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { resolveSessionReclamationDatabaseOptions } from "../../src/config/sessions/session-accessor.sqlite-reclamation.js";
import { startSqliteStatementTiming } from "../../src/infra/database-engine/observation.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../../src/infra/sqlite-worker-operation-admission.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  closeOpenClawAgentDatabasesAsync,
} from "../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../src/state/openclaw-state-db.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    baseline: { type: "string" },
    "payload-bytes": { type: "string", default: "524288" },
    iterations: { type: "string", default: "5" },
  },
});
assert(values.output && values.baseline && global.gc);
const output = path.resolve(values.output);
assert(!existsSync(output), "Use a fresh synthetic fixture directory");
mkdirSync(output, { recursive: true });
const payloadBytes = parseStrictIntegerOption({
  raw: values["payload-bytes"],
  label: "payload-bytes",
  min: 1,
  fallback: 524288,
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 5,
});
const filename = "src/config/sessions/session-entry-deletion.worker.ts";
const baselineSource = execFileSync("git", ["show", `${values.baseline}:${filename}`], {
  encoding: "utf8",
});
const baselineUrl = new URL(`../../${filename}?baseline`, import.meta.url).href;
registerHooks({
  load(url, context, next) {
    return url === baselineUrl
      ? { format: "module-typescript", source: baselineSource, shortCircuit: true }
      : next(url, context);
  },
});
const baseline: typeof import("../../src/config/sessions/session-entry-deletion.worker.js") =
  await import(baselineUrl);
const candidate = await import("../../src/config/sessions/session-entry-deletion.worker.js");
process.env.OPENCLAW_STATE_DIR = output;
const options = {
  agentId: "main",
  path: path.join(output, "agent.sqlite"),
  env: { ...process.env, OPENCLAW_STATE_DIR: output },
};
const database = openOpenClawAgentDatabase(options);
const { db } = database;
const key = (i: number) => `agent:main:survivor-${String(i).padStart(5, "0")}`;
const targetKey = "agent:main:delete-target";
const entry = { sessionId: "delete-target", updatedAt: 1 };
const target = { canonicalKey: targetKey, storeKeys: [targetKey] };
const insert = db.prepare(
  "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at,entry_valid,has_optional_references,parent_session_key) VALUES(?,?,?,1,1,?,?)",
);
runOpenClawAgentWriteTransaction(() => {
  for (let i = 0; i < 10_000; i++) {
    const sessionId = i === 1416 ? entry.sessionId : `survivor-${i}`;
    insert.run(
      key(i),
      sessionId,
      JSON.stringify({
        sessionId,
        updatedAt: 1,
        ...(i < 1417 ? { previousSessionId: null, label: "x".repeat(payloadBytes) } : {}),
      }),
      i < 1417 ? 1 : 0,
      i % 256 ? key(i - 1) : null,
    );
  }
  insert.run(targetKey, entry.sessionId, JSON.stringify(entry), 0, null);
  db.prepare(
    "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES(?,?,1,1)",
  ).run(entry.sessionId, targetKey);
}, options);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const plan = {
  kind: "entry" as const,
  databaseOptions: resolveSessionReclamationDatabaseOptions(options),
  deleteParams: {
    agentId: "main",
    storePath: database.path,
    target,
    archiveTranscript: false,
    expectedEntry: entry,
  },
  preparedTargetSnapshot: readLifecycleTargetSnapshot(database, target),
  materializedPlans: [],
};
const digest = () => {
  const hash = createHash("sha256");
  for (const row of db
    .prepare(
      "SELECT session_key,current_session_id,entry_json FROM session_nodes WHERE session_key != ? ORDER BY session_key",
    )
    .iterate(targetKey)) {
    hash.update(JSON.stringify(row));
  }
  return hash.digest("hex");
};
const initialDigest = digest();
const results: unknown[] = [];
const record = (value: unknown) => {
  results.push(value);
  console.log(JSON.stringify(value));
  writeFileSync(path.join(output, "measurements.json"), JSON.stringify(results, null, 2));
};
record({
  phase: "fixture",
  baseline: values.baseline,
  sessions: 10_001,
  optionalRows: 1417,
  maxDepth: 256,
  payloadBytes,
  bytes: statSync(database.path).size,
  node: process.version,
  sqlite: db.prepare("SELECT sqlite_version() AS version").get(),
  load: loadavg(),
});
const rollback = new Error("restore synthetic sample");
let hold = 0;
let heldCtes = 0;
let beganAt: number | undefined;
const nativeExec = db.exec.bind(db);
db.exec = (sql) => {
  if (sql === "BEGIN IMMEDIATE") {
    const result = nativeExec(sql);
    beganAt = performance.now();
    return result;
  }
  try {
    return nativeExec(sql);
  } finally {
    if ((sql === "COMMIT" || sql === "ROLLBACK") && beganAt !== undefined) {
      hold += performance.now() - beganAt;
      beganAt = undefined;
    }
  }
};
const nativePrepare = db.prepare.bind(db);
let cteSql = "";
db.prepare = (sql: string) => {
  if (sql.startsWith('with "projected_nodes"') && sql.includes('order by "session_key"')) {
    cteSql = sql;
  }
  return nativePrepare(sql);
};
async function run(arm: "base" | "candidate", restore = true) {
  hold = 0;
  heldCtes = 0;
  const stop = startSqliteStatementTiming();
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
  try {
    withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
      (arm === "base" ? baseline : candidate).deleteSessionEntryInAgentWorker(
        { plan },
        {
          options,
          open: () => database,
          admit() {},
          writeTransaction(label, _owner, write) {
            return runOpenClawAgentWriteTransaction(
              (current) => {
                const stopHeld = startSqliteStatementTiming();
                try {
                  const result = write(current);
                  assert.equal(
                    db
                      .prepare("SELECT count(*) AS n FROM session_nodes WHERE session_key = ?")
                      .get(targetKey)?.n,
                    0,
                  );
                  assert.equal(
                    db
                      .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
                      .get(entry.sessionId)?.session_key,
                    key(1416),
                  );
                  if (restore) {
                    throw rollback;
                  }
                  return result;
                } finally {
                  const timings = stopHeld();
                  heldCtes = timings
                    .summarize()
                    .statements.filter((statement) => statement.id === "697775172d959c1a")
                    .reduce((n, row) => n + row.count, 0);
                }
              },
              options,
              { operationLabel: label },
            );
          },
        },
      ),
    );
  } catch (error) {
    if (error !== rollback) {
      throw error;
    }
  } finally {
    await admission.finish();
  }
  return stop().summarize();
}
const inspector = new Session();
inspector.connect();
async function measure(arm: "base" | "candidate", label: string, allocations = false) {
  global.gc!();
  if (allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  const holds: number[] = [];
  const ctes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    await run(arm);
    holds.push(hold);
    ctes.push(heldCtes);
  }
  const usage = process.threadCpuUsage(cpu);
  const wallMs = performance.now() - start;
  const allocation = allocations ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  record({
    phase: allocations ? "allocation" : "timing",
    arm,
    label,
    iterations,
    wallMs,
    cpuMs: (usage.user + usage.system) / 1000,
    holds,
    ctes,
    allocatedBytes: allocation ? sumSampledHeapBytes(allocation.profile.head) : undefined,
    load: loadavg(),
  });
}
try {
  for (const arm of ["base", "candidate"] as const) {
    await run(arm);
    assert(cteSql, "Capture the actual owner query");
    record({
      phase: "explain",
      arm,
      sql: cteSql,
      bindings: [JSON.stringify([targetKey]), entry.sessionId, 1],
      plan: nativePrepare("EXPLAIN QUERY PLAN " + cteSql).all(
        JSON.stringify([targetKey]),
        entry.sessionId,
        1,
      ),
    });
  }
  await measure("base", "AA-1");
  await measure("base", "AA-2");
  for (let pair = 0; pair < 5; pair++) {
    for (const arm of pair % 2
      ? (["candidate", "base"] as const)
      : (["base", "candidate"] as const)) {
      await measure(arm, `pair-${pair}`);
    }
  }
  await measure("base", "AA-1", true);
  await measure("base", "AA-2", true);
  for (let pair = 0; pair < 5; pair++) {
    for (const arm of pair % 2
      ? (["candidate", "base"] as const)
      : (["base", "candidate"] as const)) {
      await measure(arm, `pair-${pair}`, true);
    }
  }
  assert.equal(digest(), initialDigest);
  record({ phase: "committed", statementTiming: await run("candidate", false), hold, heldCtes });
  const stopSecond = startSqliteStatementTiming();
  const secondPlan = prepareSessionDeletionInDatabase(database, {
    operation: "entry",
    input: {
      deleteParams: plan.deleteParams,
      archiveDirectory: output,
      allowLockedEntryRemoval: false,
      admissionIdentities: [],
    },
  });
  const secondStatements = stopSecond().summarize();
  assert(!secondStatements.statements.some((statement) => statement.operation === "WITH"));
  assert.deepEqual(secondPlan, { operation: "entry", value: { kind: "missing" } });
  assert.equal(digest(), initialDigest);
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM session_windows WHERE session_id = ?")
      .get(entry.sessionId)?.n,
    1,
  );
  record({
    phase: "verified",
    secondPlan,
    secondStatements,
    survivorsDigest: initialDigest,
    retainedWindows: 1,
  });
} finally {
  inspector.disconnect();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
