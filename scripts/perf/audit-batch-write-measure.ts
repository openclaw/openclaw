/**
 * Audit writer kernel CPU/allocation and commit-count measurement with synthetic metadata.
 * This process represents the writer isolate, not Gateway main-thread CPU or queue wait.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/audit-batch-write-measure.ts \
 *   --output .local/audit-base-1 --iterations 3000 [--allocation] [--source-dir <saved-owners>]
 * Alternate base/candidate, then repeat allocation separately. --source-dir loads saved
 * audit owner modules in place, preserving their relative imports. Use all changed owners.
 * Each turn records identity, decision, tool, paired run, progress and terminal message.
 * The default batch holds 24 items; --batch-size 1 also checks sparse queues.
 * No collection or retention settings change.
 * Accept identical persisted rows/order and fewer commits with lower CPU/allocation.
 * Setup, warmup and verification are untimed. Report host load alongside raw results.
 * --fixture copies a closed synthetic database from audit-retention-fixture.mjs.
 * --pager-extension loads transcript-active-facts-vfs.c (compiled as bufprobe).
 * Pager reads are logical file reads, not physical disk I/O; measure timing separately.
 * --max-main-page-reads enforces a workload-specific read budget for regression proof.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AuditWriterRequest } from "../../src/audit/audit-event-writer.types.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    iterations: { type: "string", default: "3000" },
    allocation: { type: "boolean" },
    "batch-size": { type: "string", default: "24" },
    "source-dir": { type: "string" },
    fixture: { type: "string" },
    "pager-extension": { type: "string" },
    "max-main-page-reads": { type: "string" },
  },
});
assert(values.output, "--output must be a new directory");
assert(
  !values["max-main-page-reads"] || values["pager-extension"],
  "read budget needs the pager probe",
);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const batchSize = Number(values["batch-size"]);
assert(Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= 32);
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(output);
if (values.fixture) {
  mkdirSync(path.join(output, "state"));
  copyFileSync(
    path.resolve(values.fixture),
    path.join(output, "state", "openclaw.sqlite"),
    constants.COPYFILE_FICLONE,
  );
}
const probe = values["pager-extension"]
  ? new DatabaseSync(":memory:", { allowExtension: true })
  : undefined;
if (probe) {
  probe.loadExtension(path.resolve(values["pager-extension"]!));
  probe.prepare("SELECT buf696_target(?, 1)").get(path.join(output, "state", "openclaw.sqlite"));
}
Object.assign(process.env, { OPENCLAW_STATE_DIR: output, OPENCLAW_HOME: output });
const auditDir = fileURLToPath(new URL("../../src/audit/", import.meta.url));
const sources: Record<string, string> = Object.fromEntries(
  [
    "audit-event-writer.worker",
    "audit-event-store",
    "execution-identity-context",
    "execution-decision-facts",
    "audit-identity",
    "message-delivery-progress-store",
    "message-execution-binding",
  ].map((name) => [
    `${name}.ts`,
    createHash("sha256")
      .update(readFileSync(path.join(auditDir, `${name}.ts`)))
      .digest("hex"),
  ]),
);
if (values["source-dir"]) {
  const sourceDir = path.resolve(values["source-dir"]);
  const files = new Set(readdirSync(sourceDir));
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith("file:")) {
        const filename = fileURLToPath(url);
        const name = path.basename(filename);
        if (path.dirname(filename) === path.resolve(auditDir) && files.has(name)) {
          const source = readFileSync(path.join(sourceDir, name), "utf8");
          sources[name] = createHash("sha256").update(source).digest("hex");
          return { format: "module-typescript", source, shortCircuit: true };
        }
      }
      return nextLoad(url, context);
    },
  });
}
const [
  { auditOperations },
  state,
  { captureExecutionIdentityAdmissionEnvelope: capture },
  fixture,
] = await Promise.all([
  import("../../src/audit/audit-event-writer.worker.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/audit/execution-identity.test-support.js"),
  import("../../src/audit/audit-event-writer.test-support.js"),
]);
const now = Math.floor(Date.now() / 86_400_000) * 86_400_000;
const database = state.openOpenClawStateDatabase({ env: process.env });
const context = {
  open: () => database,
  stateOptions: () => ({ path: database.path, env: process.env }),
};
if (!values.fixture) {
  state.runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(
        "INSERT INTO audit_identity_keys (id, key_id, key, created_at) VALUES (1, ?, ?, ?)",
      ).run("a".repeat(32), Buffer.alloc(32, 7), now);
    },
    { database },
  );
}
function turn(inputIndex: number): AuditWriterRequest[] {
  const index = inputIndex + (values.fixture ? 1_000_000 : 0);
  const runId = `session-${index % 10000}:run-${index}`;
  const agentId = `agent-${index % 40}`;
  const envelope = capture(
    {
      runId,
      agentId,
      ingress: { kind: "gateway-client", boundary: "chat.send", state: "present" },
      runtime: { kind: "embedded" },
      invoker: { state: "present", kind: "person", rawPrincipalRef: `person-${index % 65}` },
    },
    {
      contextId: `context-${index}`,
      executionId: `execution-${index}`,
      now,
      runtimeInstanceId: "synthetic",
    },
  );
  const token = {
    tokenVersion: 1 as const,
    contextId: envelope.contextId,
    executionId: envelope.executionId,
    runId,
    createdAt: now,
  };
  const start = { ...fixture.input(), sourceId: `start-${index}`, occurredAt: now, runId, agentId };
  return [
    { type: "record-execution-identity", work: { kind: "capture", envelope } },
    {
      type: "record-execution-decision",
      receipt: {
        ...fixture.decisionReceipt(),
        contextId: token.contextId,
        executionId: token.executionId,
        runId,
        receiptId: `decision-${index}`,
        occurredAt: now,
      },
    },
    {
      type: "record-event",
      eventId: `tool-${index}`,
      input: {
        ...start,
        sourceId: `tool-${index}`,
        kind: "tool_action",
        action: "tool.action.finished",
        status: "succeeded",
        toolName: "read",
        toolCallId: `call-${index}`,
      },
    },
    {
      type: "record-run",
      start,
      finish: {
        ...start,
        sourceId: `finish-${index}`,
        sourceSequence: 2,
        action: "agent.run.finished",
        status: "succeeded",
      },
      eventIds: [`start-${index}`, `finish-${index}`],
    },
    ...(["message.outbound.queued", "message.outbound.finished"] as const).map((action) => ({
      type: "record-event" as const,
      eventId: `${action}-${index}`,
      input: {
        ...fixture.messageEvent(action),
        sourceSequence: 1,
        sourceId: `${action}-${index}`,
        occurredAt: now,
        runId,
        executionIdentityToken: token,
      },
    })),
  ];
}
const allRequests = Array.from({ length: iterations }, (_, index) => turn(index)).flat();
const batches = Array.from({ length: Math.ceil(allRequests.length / batchSize) }, (_, index) =>
  allRequests.slice(index * batchSize, (index + 1) * batchSize),
);
const run = (requests: AuditWriterRequest[]) => {
  const started = performance.now();
  const results = auditOperations["audit.writer.process"](requests, context);
  batchDurations.push(performance.now() - started);
  assert.deepEqual(
    results,
    requests.map(() => ({ status: "settled" })),
  );
};
const batchDurations: number[] = [];
let commits = 0;
const exec = database.db.exec.bind(database.db);
database.db.exec = (sql) => {
  if (sql === "COMMIT") {
    commits++;
  }
  return exec(sql);
};
// This mix's tool/run autocommits are counted separately from explicit COMMITs.
const prepare = database.db.prepare.bind(database.db);
database.db.prepare = (sql: string) => {
  const statement = prepare(sql);
  if (/^insert\s/i.test(sql.trimStart())) {
    for (const key of ["get", "all", "run", "iterate"] as const) {
      const method = statement[key].bind(statement);
      Object.defineProperty(statement, key, {
        value: (...args: never[]) => {
          if (!database.db.isTransaction) {
            commits++;
          }
          return Reflect.apply(method, statement, args);
        },
      });
    }
  }
  return statement;
};
for (let index = -16; index < 0; index += 4) {
  run(Array.from({ length: 4 }, (_, offset) => turn(index + offset)).flat());
}
commits = 0;
batchDurations.length = 0;
const inspector = new Session();
try {
  globalThis.gc?.();
  if (values.allocation) {
    await startCollectedHeapSampling(inspector, 4096);
  }
  const hostLoad = loadavg();
  probe?.prepare("SELECT buf696_reset()").get();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  for (const batch of batches) {
    run(batch);
  }
  const elapsedMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const pager = probe?.prepare("SELECT buf696_io() AS io").get()?.io;
  const sampledBytes = values.allocation
    ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
        (sum, sample) => sum + sample.size,
        0,
      )
    : undefined;
  const digest = createHash("sha256");
  const rowCounts: Record<string, number> = {};
  for (const table of [
    "audit_events",
    "execution_identity_contexts",
    "execution_decision_facts",
    "outbound_message_progress",
    "outbound_message_execution_bindings",
  ]) {
    rowCounts[table] = 0;
    for (const row of database.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) {
      rowCounts[table]++;
      const stable = { ...row };
      if (table === "outbound_message_progress") {
        delete stable.progress_id;
      }
      digest.update(JSON.stringify(stable));
    }
  }
  if (!values.fixture) {
    assert.equal(rowCounts.audit_events, (iterations + 16) * 4);
  }
  console.log(
    JSON.stringify({
      sources,
      fixture: values.fixture,
      batchDurations,
      pager: typeof pager === "string" ? JSON.parse(pager) : undefined,
      iterations,
      requests: iterations * 6,
      batches: batches.length,
      commits,
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      sampledBytes,
      hostLoad,
      commitsPerMinute: (commits * 60000) / elapsedMs,
      writerSecondsPer1000Turns: elapsedMs / iterations,
      rowCounts,
      rowDigest: digest.digest("hex"),
      memory: process.memoryUsage(),
    }),
  );
  if (values["max-main-page-reads"]) {
    const limit = Number(values["max-main-page-reads"]);
    assert(Number.isSafeInteger(limit) && limit >= 0);
    assert(typeof pager === "string");
    const io: { main: { reads: number } } = JSON.parse(pager);
    assert(io.main.reads <= limit, `main page-read budget exceeded: ${io.main.reads} > ${limit}`);
  }
} finally {
  inspector.disconnect();
  await state.closeOpenClawStateDatabaseAsync();
  probe?.prepare("SELECT buf696_restore()").get();
  probe?.close();
}
