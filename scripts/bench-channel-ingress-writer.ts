// Synthetic shared-writer benchmark. Seed on preparation cores; measure on an isolated pair.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { DecisionReceiptV1 } from "../packages/gateway-protocol/src/schema/audit-run.js";
import { createAuditEventWriter } from "../src/audit/audit-event-writer.js";
import { recordExecutionDecisionFactInDatabase } from "../src/audit/execution-decision-facts.js";
import {
  configureExecutionIdentityAdmissionSink,
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionWork,
} from "../src/audit/execution-identity-admission.js";
import { processExecutionIdentityAdmissionWorkInDatabase } from "../src/audit/execution-identity-context.js";
import { createChannelIngressQueue } from "../src/channels/message/ingress-queue.js";
import {
  hasPendingInternalDiagnosticEvent,
  onInternalDiagnosticEvent,
} from "../src/infra/diagnostic-events.js";
import { GatewayScheduler } from "../src/infra/gateway-scheduler.js";
import { writeConfigMachineStateAsync } from "../src/state/config-machine-state-async.js";
import { writeConfigMachineStateInDatabase } from "../src/state/config-machine-state-write.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../src/state/openclaw-state-db.js";
import { resolveDatabasePath } from "../src/state/openclaw-state-db.paths.js";
import { parseBenchmarkInteger } from "./lib/benchmark-harness.mts";

const FIXTURE_KEY = "benchmark.channel-ingress-writer.fixture";
const FIXTURE_VERSION = "channel-ingress-writer-v1";
const INTERACTIVE_KEY = "benchmark.channel-ingress-writer.interactive";
const ANCHOR = "seed-anchor";

function identityWork(id: string, createdAt: number): ExecutionIdentityAdmissionWork {
  let work: ExecutionIdentityAdmissionWork | undefined;
  const clearSink = configureExecutionIdentityAdmissionSink((captured) => {
    work = captured;
    return true;
  });
  try {
    const result = enqueueExecutionIdentityContextAtAdmission(
      {
        runId: `${id}:run`,
        agentId: "benchmark",
        ingress: { kind: "local-cli", boundary: "benchmark.synthetic", state: "present" },
        runtime: { kind: "embedded" },
      },
      {
        enabled: true,
        contextId: `${id}:context`,
        executionId: `${id}:execution`,
        now: createdAt,
        runtimeInstanceId: "synthetic-runtime",
      },
    );
    assert(result?.accepted && work, "Synthetic execution identity admission failed");
    return work;
  } finally {
    clearSink();
  }
}

function decision(id: string, occurredAt: number): DecisionReceiptV1 {
  return {
    schemaVersion: 1,
    receiptId: id,
    contextId: `${ANCHOR}:context`,
    executionId: `${ANCHOR}:execution`,
    runId: `${ANCHOR}:run`,
    occurredAt,
    action: { family: "tool", operation: "policy" },
    decision: { outcome: "denied", reasonCode: "synthetic_policy_denied" },
    enforcement: {
      coverageState: "enforced",
      policyRefs: ["synthetic-policy"],
      grantRefs: [],
      contextFieldsUsed: ["runId"],
    },
    source: {
      owner: "benchmark-policy",
      recordRef: id,
      decisionBoundary: "benchmark.synthetic",
    },
    missingEvidence: [],
    remediation: [],
  };
}

async function seed(
  options: OpenClawStateDatabaseOptions,
  contexts: number,
  decisions: number,
  fixtureTime: number,
) {
  assert(!existsSync(resolveDatabasePath(options)), "Seed requires a new state database");
  const database = openOpenClawStateDatabase(options);
  const owner = { ...options, database };
  // Canonical first-use owners create the tables and installation-local HMAC key.
  const template = processExecutionIdentityAdmissionWorkInDatabase(
    identityWork(ANCHOR, fixtureTime),
    owner,
  );
  recordExecutionDecisionFactInDatabase(decision("seed-decision-0", fixtureTime), owner);
  runOpenClawStateWriteTransaction(({ db }) => {
    const insertContext = db.prepare(`
      INSERT INTO execution_identity_contexts
        (context_id, execution_id, run_id, created_at, coverage_state, context_bytes, context_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 1; index < contexts; index++) {
      const context = {
        ...template,
        contextId: `seed-${index}:context`,
        executionId: `seed-${index}:execution`,
        runId: `seed-${index}:run`,
        // Equal timestamps exercise the real composite retention ordering.
        createdAt: fixtureTime - 3_600_000 + Math.floor(index / 100),
      };
      const encoded = JSON.stringify(context);
      insertContext.run(
        context.contextId,
        context.executionId,
        context.runId,
        context.createdAt,
        context.coverageState,
        Buffer.byteLength(encoded),
        encoded,
      );
    }
    const insertDecision = db.prepare(`
      INSERT INTO execution_decision_facts
        (cursor_id, receipt_id, context_id, execution_id, run_id, action_id, action_family,
         decision_outcome, coverage_state, reason_code, owner, source_ref, occurred_at,
         receipt_bytes, receipt_json)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 1; index < decisions; index++) {
      const receipt = decision(
        `seed-decision-${index}`,
        fixtureTime - 3_600_000 + Math.floor(index / 100),
      );
      const encoded = JSON.stringify(receipt);
      insertDecision.run(
        index + 1,
        receipt.receiptId,
        receipt.contextId,
        receipt.executionId,
        receipt.runId,
        receipt.action.family,
        receipt.decision.outcome,
        receipt.enforcement.coverageState,
        receipt.decision.reasonCode,
        receipt.source.owner,
        receipt.source.recordRef,
        receipt.occurredAt,
        Buffer.byteLength(encoded),
        encoded,
      );
    }
    writeConfigMachineStateInDatabase(db, FIXTURE_KEY, FIXTURE_VERSION);
  }, owner);
  await closeOpenClawStateDatabaseAsync();
  return { mode: "seed", contexts, decisions, fixtureTime };
}

function readFixture(databasePath: string) {
  using db = new DatabaseSync(databasePath, { readOnly: true });
  const marker = db
    .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
    .get(FIXTURE_KEY);
  assert.equal(marker?.value_json, JSON.stringify(FIXTURE_VERSION), "Not a benchmark fixture");
  const counts = db
    .prepare(`SELECT
      (SELECT count(*) FROM execution_identity_contexts) AS contexts,
      (SELECT count(*) FROM execution_decision_facts) AS decisions`)
    .get();
  return { contexts: Number(counts?.contexts), decisions: Number(counts?.decisions) };
}

function summary(samples: number[]) {
  const sorted = samples.toSorted((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
  return {
    count: sorted.length,
    sumMs: samples.reduce((sum, value) => sum + value, 0),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: sorted.at(-1) ?? 0,
  };
}

type Workload = {
  seconds: number;
  auditRate: number;
  ingressRate: number;
  pollRate: number;
  interactiveRate: number;
  startAt?: number;
};

async function measure(
  stateDir: string,
  options: OpenClawStateDatabaseOptions,
  workload: Workload,
) {
  const databasePath = resolveDatabasePath(options);
  const before = readFixture(databasePath);
  const runId = `bench-${randomUUID()}`;
  const scheduler = new GatewayScheduler();
  const errors: string[] = [];
  const writerOptions = { scheduler, stateDir, onError: (error: string) => errors.push(error) };
  const queue = createChannelIngressQueue<{ text: string }>({
    channelId: "benchmark",
    accountId: runId,
    stateDir,
  });
  const ingress = async (id: string, duplicate: boolean) => {
    assert.equal((await queue.enqueue(id, { text: "synthetic message" })).kind, "accepted");
    if (duplicate) {
      assert.equal((await queue.enqueue(id, { text: "synthetic message" })).duplicate, true);
    }
    const claim = await queue.claim(id, { ownerId: "benchmark" });
    assert(claim, "Fresh ingress event was not claimable");
    assert.equal(await queue.complete(claim), true);
    if (duplicate) {
      assert.equal((await queue.enqueue(id, { text: "synthetic message" })).kind, "completed");
    }
  };
  const warmup = createAuditEventWriter(writerOptions);
  await warmup.ready;
  assert(warmup.recordExecutionIdentity(identityWork(`${runId}:warmup`, Date.now())));
  assert(warmup.recordExecutionDecision(decision(`${runId}:warmup-decision`, Date.now())));
  await warmup.stop();
  await ingress("warmup", true);
  await writeConfigMachineStateAsync(INTERACTIVE_KEY, "warmup", options);
  assert.equal(errors.length, 0, errors.join("\n"));
  const writer = createAuditEventWriter(writerOptions);
  await writer.ready;

  const workers = new Map<string, { queued: number; waits: number[]; durations: number[] }>();
  let diagnosticDrops = 0;
  const unsubscribe = onInternalDiagnosticEvent(
    (event) => {
      if (event.type === "diagnostic.async_queue.dropped") {
        diagnosticDrops += event.droppedEvents;
        return;
      }
      if (event.type !== "worker.request" || event.kind !== "sqlite_writer") {
        return;
      }
      let row = workers.get(event.requestClass);
      if (!row) {
        row = { queued: 0, waits: [], durations: [] };
        workers.set(event.requestClass, row);
      }
      if (event.phase === "queued") {
        row.queued++;
      }
      if (event.queueWaitMs !== undefined) {
        row.waits.push(event.queueWaitMs);
      }
      if (event.durationMs !== undefined) {
        row.durations.push(event.durationMs);
      }
    },
    { include: ["worker.request", "diagnostic.async_queue.dropped"] },
  );
  const latencies = { ingress: [] as number[], interactive: [] as number[] };
  const submitted = {
    audit: 0,
    identities: 0,
    decisions: 0,
    ingress: 0,
    duplicates: 0,
    polls: 0,
    interactive: 0,
  };
  const offeredAt = workload.startAt ?? Date.now();
  assert(offeredAt >= Date.now() - 1_000, "--start-at-ms elapsed before warmup finished");
  await delay(Math.max(0, offeredAt - Date.now()));
  const started = performance.now();
  const paced = async (rate: number, action: (index: number) => Promise<void> | void) => {
    const pending: Promise<void>[] = [];
    for (let index = 0; index < Math.floor(rate * workload.seconds); index++) {
      await delay(Math.max(0, started + (index * 1_000) / rate - performance.now()));
      pending.push(
        Promise.resolve()
          .then(() => action(index))
          .catch((error: unknown) => {
            errors.push(error instanceof Error ? error.message : String(error));
          }),
      );
    }
    await Promise.all(pending);
  };
  let elapsedMs = 0;
  let drainedMs = 0;
  try {
    await Promise.all([
      paced(workload.auditRate, (index) => {
        const identity = index % 2 === 0;
        const accepted = identity
          ? writer.recordExecutionIdentity(identityWork(`${runId}:identity:${index}`, Date.now()))
          : writer.recordExecutionDecision(decision(`${runId}:decision:${index}`, Date.now()));
        assert(accepted, "Audit FIFO rejected metadata");
        submitted.audit++;
        if (identity) {
          submitted.identities++;
        } else {
          submitted.decisions++;
        }
      }),
      paced(workload.ingressRate, async (index) => {
        const start = performance.now();
        const duplicate = index % 10 === 0;
        await ingress(`event-${index}`, duplicate);
        latencies.ingress.push(performance.now() - start);
        submitted.ingress++;
        if (duplicate) {
          submitted.duplicates += 2;
        }
      }),
      paced(workload.pollRate, async () => {
        await queue.recoverStaleClaims({ staleMs: 60_000 });
        await queue.listUnsettled!();
        submitted.polls++;
      }),
      paced(workload.interactiveRate, async (index) => {
        const start = performance.now();
        await writeConfigMachineStateAsync(INTERACTIVE_KEY, { runId, index }, options);
        latencies.interactive.push(performance.now() - start);
        submitted.interactive++;
      }),
      delay(workload.seconds * 1_000),
    ]);
    elapsedMs = performance.now() - started;
    const drainStarted = performance.now();
    await writer.stop();
    drainedMs = performance.now() - drainStarted;
    while (hasPendingInternalDiagnosticEvent((event) => event.type === "worker.request")) {
      await immediate();
    }
  } finally {
    await writer.stop();
    unsubscribe();
    await scheduler.stop();
    await closeOpenClawStateDatabaseAsync();
  }
  assert.equal(errors.length, 0, `Workload did not settle successfully: ${errors.join("\n")}`);
  assert.equal(diagnosticDrops, 0, "Worker diagnostic samples were dropped");
  using db = new DatabaseSync(databasePath, { readOnly: true });
  const persisted = db
    .prepare(`SELECT
    (SELECT count(*) FROM execution_identity_contexts WHERE context_id LIKE ?) AS identities,
    (SELECT count(*) FROM execution_decision_facts WHERE receipt_id LIKE ?) AS decisions,
    (SELECT count(*) FROM channel_ingress_events WHERE queue_name = ? AND status = 'completed') AS completed,
    (SELECT count(*) FROM channel_ingress_events WHERE queue_name = ? AND status != 'completed') AS unsettled`)
    .get(
      `${runId}:identity:%`,
      `${runId}:decision:%`,
      JSON.stringify(["benchmark", runId]),
      JSON.stringify(["benchmark", runId]),
    );
  assert.equal(Number(persisted?.identities), submitted.identities);
  assert.equal(Number(persisted?.decisions), submitted.decisions);
  assert.equal(Number(persisted?.completed), submitted.ingress + 1);
  assert.equal(Number(persisted?.unsettled), 0);
  const interactive = db
    .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
    .get(INTERACTIVE_KEY);
  assert.equal(
    interactive?.value_json,
    JSON.stringify({ runId, index: submitted.interactive - 1 }),
  );
  for (const [requestClass, row] of workers) {
    assert.equal(
      row.queued,
      row.waits.length,
      `${requestClass} did not start every queued request`,
    );
    assert.equal(row.queued, row.durations.length, `${requestClass} did not settle every request`);
  }
  return {
    mode: "run",
    workload,
    before,
    after: readFixture(databasePath),
    scope:
      "Warm shared SQLite owner APIs; opt-in audit identity/decision pressure; no Gateway transport, external channels or model",
    auditMix: "Alternating new execution identities and generic decision facts (50/50)",
    startedAt: offeredAt,
    elapsedMs,
    drainedMs,
    submitted,
    diagnosticDrops,
    latency: { ingress: summary(latencies.ingress), interactive: summary(latencies.interactive) },
    workers: Object.fromEntries(
      [...workers].map(([requestClass, row]) => [
        requestClass,
        {
          queued: row.queued,
          queueWait: summary(row.waits),
          service: summary(row.durations),
        },
      ]),
    ),
    verification:
      "All accepted audit items persisted; ingress duplicates retained one tombstone; no unsettled ingress or writer requests",
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "state-dir": { type: "string" },
      "seed-only": { type: "boolean" },
      contexts: { type: "string", default: "100000" },
      decisions: { type: "string", default: "250000" },
      seconds: { type: "string", default: "60" },
      "audit-rate": { type: "string", default: "3" },
      "ingress-rate": { type: "string", default: "1" },
      "poll-rate": { type: "string", default: "1" },
      "interactive-rate": { type: "string", default: "1" },
      "fixture-time-ms": { type: "string" },
      "start-at-ms": { type: "string" },
      output: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(`Usage: node --import ./scripts/tsx.mjs scripts/bench-channel-ingress-writer.ts --state-dir <synthetic-dir> [options]
  --seed-only              Prepare a new fixture; run separately on preparation cores.
  --contexts 100000       Retained execution contexts (1..100000).
  --decisions 250000      Retained decision facts (1..250000).
  --seconds 60            Measured open-loop offering window (1..600).
  --audit-rate 3          Metadata events/second, alternating identities and decisions.
  --ingress-rate 1        Messages/second; each enqueues, claims and completes.
  --poll-rate 1           Idle-drain polls/second (stale claims + unsettled rows).
  --interactive-rate 1    Independent machine-state writes/second.
  --fixture-time-ms <ms>  Use the same recent epoch for paired fixture generation.
  --start-at-ms <ms>      Begin after warmup at a shared future epoch for paired runs.
  --output <path>         Also write the JSON report to a file.
Seed each side sequentially, then run A/B concurrently on disjoint 16-core halves.
Swap halves for the next pair. Use fresh fixtures, identical options, and record outside load.
This is an owner-boundary workload, not a Gateway/channel/model end-to-end benchmark.`);
    return;
  }
  assert(values["state-dir"], "--state-dir is required");
  const stateDir = path.resolve(values["state-dir"]);
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  const integer = (value: string, flag: string, min: number, max: number) =>
    parseBenchmarkInteger(value, flag, min, max);
  const epoch = (value: string, flag: string) => integer(value, flag, 1, Number.MAX_SAFE_INTEGER);
  // Audit owners intentionally unref their scheduling; the harness must keep shutdown alive.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const result = values["seed-only"]
      ? await seed(
          options,
          integer(values.contexts, "--contexts", 1, 100_000),
          integer(values.decisions, "--decisions", 1, 250_000),
          values["fixture-time-ms"]
            ? epoch(values["fixture-time-ms"], "--fixture-time-ms")
            : Date.now(),
        )
      : await measure(stateDir, options, {
          seconds: integer(values.seconds, "--seconds", 1, 600),
          auditRate: integer(values["audit-rate"], "--audit-rate", 1, 20),
          ingressRate: integer(values["ingress-rate"], "--ingress-rate", 1, 20),
          pollRate: integer(values["poll-rate"], "--poll-rate", 1, 20),
          interactiveRate: integer(values["interactive-rate"], "--interactive-rate", 1, 20),
          ...(values["start-at-ms"]
            ? { startAt: epoch(values["start-at-ms"], "--start-at-ms") }
            : {}),
        });
    const report = JSON.stringify(result, null, 2);
    if (values.output) {
      writeFileSync(path.resolve(values.output), `${report}\n`);
    }
    console.log(report);
  } finally {
    clearInterval(keepAlive);
    await closeOpenClawStateDatabaseAsync();
  }
}

await main();
