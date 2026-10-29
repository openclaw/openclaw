/**
 * Real SQLite deletion/reclamation retention probe; all data is synthetic.
 * Run: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sqlite-reclamation-retention.ts
 *   --output .local/lane1747/base-retention [--expect-released] [--snapshot]
 * Compare independent launches on base and candidate. The first deletion checks
 * cached-worker request retention; the second checks idle-timer async context.
 * Forced GC and snapshots stay outside CPU timing. Source-loader heap is context,
 * not packaged Gateway RSS. Acceptance: deletion succeeds, its worker stays warm,
 * and completed plans, decoded rows, and caller contexts have zero survivors.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import type { SqliteSessionReclamationDiagnostics } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import type { SqliteSessionReclamationPlan } from "../../src/config/sessions/session-accessor.sqlite-lifecycle-types.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "payload-bytes": { type: "string", default: "1048576" },
    "expect-released": { type: "boolean", default: false },
    snapshot: { type: "boolean", default: false },
  },
});
assert(global.gc, "Run with --expose-gc");
assert(values.output, "--output must name a new synthetic fixture directory");
const output = path.resolve(values.output);
assert(!fs.existsSync(output), "Refusing to reuse an existing fixture directory");
const payloadBytes = Number(values["payload-bytes"]);
assert(Number.isSafeInteger(payloadBytes) && payloadBytes > 0);
const env = {
  OPENCLAW_STATE_DIR: path.join(output, "state"),
  OPENCLAW_CONFIG_PATH: path.join(output, "config.json"),
  TMPDIR: path.join(output, "tmp"),
};
for (const directory of [env.OPENCLAW_STATE_DIR, env.TMPDIR]) {
  fs.mkdirSync(directory, { recursive: true });
}
Object.assign(process.env, env);

const { ensureSessionEntrySync } =
  await import("../../src/config/sessions/session-accessor.sqlite-initial-entry.js");
const { loadSessionEntryReadOnly } =
  await import("../../src/config/sessions/session-accessor.sqlite-exact-read.js");
const { resolveSqliteStoreScope } =
  await import("../../src/config/sessions/session-accessor.sqlite-scope.js");
const { runSessionDeletionPlanning, runSqliteSessionReclamation } =
  await import("../../src/config/sessions/session-accessor.sqlite-reclamation-run.js");
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");

const options = { agentId: "main", env };
const scopes = ["first", "second"].map((id) => ({
  agentId: options.agentId,
  env,
  sessionId: `retention-${id}`,
  sessionKey: `agent:main:retention-${id}`,
}));
const text = () =>
  randomBytes(Math.ceil((payloadBytes * 3) / 4))
    .toString("base64")
    .slice(0, payloadBytes);
for (const scope of scopes) {
  ensureSessionEntrySync(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    skillsSnapshot: { prompt: text(), skills: [] },
  });
}
const databasePath = openOpenClawAgentDatabase(options).path;
await closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);

const context = new AsyncLocalStorage<{ payload: string }>();
const references: Array<{ name: string; value: WeakRef<object>; payloadBytes: number }> = [];
const measurements: Array<{
  elapsedMs: number;
  processCpuMs: number;
  workerThreadId: number | undefined;
}> = [];

async function remove(index: number) {
  const scope = scopes[index]!;
  const deleteParams = {
    archiveTranscript: false,
    storePath: databasePath,
    target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
  };
  const preparation = await runSessionDeletionPlanning(
    resolveSqliteStoreScope(databasePath, { agentId: "main" }),
    { ...deleteParams, env },
    {
      operation: "entry",
      input: {
        deleteParams,
        archiveDirectory: path.join(output, "archives"),
        admissionIdentities: [],
        allowLockedEntryRemoval: false,
      },
    },
    () => {},
  );
  assert.equal(preparation.value.kind, "ready");
  if (preparation.value.kind !== "ready") {
    throw new Error("Synthetic deletion planning did not find its entry");
  }
  const entry = preparation.value.value.current.entry;
  assert.equal(entry.skillsSnapshot?.prompt.length, payloadBytes);
  const plan: SqliteSessionReclamationPlan = {
    kind: "entry",
    databaseOptions: { ...options, path: databasePath },
    deleteParams,
    preparedTargetSnapshot: preparation.value.value.targetSnapshot,
    materializedPlans: [],
  };
  references.push(
    { name: `plan-${index}`, value: new WeakRef(plan), payloadBytes: 0 },
    { name: `decoded-entry-${index}`, value: new WeakRef(entry), payloadBytes },
  );
  // The first request exercises worker creation with no pre-existing host reader.
  if (index === 0) {
    await closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);
  }
  const diagnostics: SqliteSessionReclamationDiagnostics = {};
  const cpu = process.cpuUsage();
  const started = performance.now();
  const result = await reclaimInCallerContext(index, { plan, diagnostics });
  measurements.push({
    elapsedMs: performance.now() - started,
    processCpuMs:
      Object.values(process.cpuUsage(cpu)).reduce((sum, value) => sum + value, 0) / 1000,
    workerThreadId: diagnostics.workerThreadId,
  });
  assert(result.kind === "entry");
  assert.equal(result.value.deleted, true);
  assert.equal(
    loadSessionEntryReadOnly(scope),
    undefined,
    "Deletion must remove the durable entry",
  );
}

function reclaimInCallerContext(
  index: number,
  params: Parameters<typeof runSqliteSessionReclamation>[0],
) {
  const caller = { payload: text() };
  references.push({ name: `caller-context-${index}`, value: new WeakRef(caller), payloadBytes });
  return context.run(caller, runSqliteSessionReclamation, params);
}

async function collect() {
  for (let index = 0; index < 5; index++) {
    await yieldToEventLoop();
    global.gc!();
  }
}

try {
  await remove(0);
  await remove(1);
  assert(measurements[0]?.workerThreadId !== undefined, "The real reclamation worker must run");
  assert.equal(
    measurements[1]?.workerThreadId,
    measurements[0]?.workerThreadId,
    "Worker must be reused",
  );
  await collect();
  if (values.snapshot) {
    writeHeapSnapshot(path.join(output, "retained.heapsnapshot"));
  }
  const survivors = references.filter(({ value }) => value.deref() !== undefined);
  const report = {
    operations: measurements.length,
    payloadBytes,
    measurements,
    survivors: survivors.map(({ name }) => name),
    retainedPayloadBytes: survivors.reduce((sum, item) => sum + item.payloadBytes, 0),
    memory: process.memoryUsage(),
  };
  fs.writeFileSync(path.join(output, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  if (values["expect-released"]) {
    assert.equal(survivors.length, 0, "Idle reclamation worker retained completed request data");
  }
} finally {
  await closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);
  await closeOpenClawStateDatabaseAsync();
  context.disable();
}
