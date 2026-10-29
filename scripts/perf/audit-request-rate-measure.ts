/**
 * Real audit queue + SQLite worker request-rate measurement; not a Gateway load test.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/audit-request-rate-measure.ts \
 *   --output .local/audit-rate/base-1 --iterations 1000 [--allocation] \
 *   [--source-dir .local/audit-rate/base-source] [--stage-gap-ms 1] [--turn-gap-ms 10]
 * --source-dir substitutes ONLY audit-event-writer.ts, retaining its relative imports.
 * Both arms load the captured owner through the same native TypeScript hook.
 * Compare fixed work in alternating base/candidate runs; sample main-thread allocation
 * separately. Each turn enqueues eight items across six async lifecycle stages, producing
 * five activity rows, two progress rows, one identity and one decision. Forty agents and
 * a 10,000-session correlation range are synthetic; no message content is collected.
 * Accept identical row counts/order, fewer worker requests and lower CPU/allocation.
 * Report absolute wall time, host load and sparse-stage controls; rates describe this
 * workload, not observed production traffic. Warmup and verification are untimed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    iterations: { type: "string", default: "1000" },
    allocation: { type: "boolean" },
    "source-dir": { type: "string" },
    "stage-gap-ms": { type: "string", default: "1" },
    "turn-gap-ms": { type: "string", default: "10" },
  },
});
assert(values.output, "--output must be a new isolated directory");
const iterations = Number(values.iterations);
const stageGapMs = Number(values["stage-gap-ms"]);
const turnGapMs = Number(values["turn-gap-ms"]);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(stageGapMs) && stageGapMs >= 0);
assert(Number.isSafeInteger(turnGapMs) && turnGapMs >= 0);
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(output, { mode: 0o700 });
Object.assign(process.env, { OPENCLAW_STATE_DIR: output, OPENCLAW_HOME: output });
const ownerUrl = new URL("../../src/audit/audit-event-writer.ts", import.meta.url);
const ownerSource = readFileSync(
  values["source-dir"]
    ? path.join(path.resolve(values["source-dir"]), "audit-event-writer.ts")
    : fileURLToPath(ownerUrl),
  "utf8",
);
let loadedOwner = false;
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && fileURLToPath(url) === fileURLToPath(ownerUrl)) {
      loadedOwner = true;
      return { format: "module-typescript", source: ownerSource, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const [
  { createAuditEventWriter },
  { GatewayScheduler },
  fixture,
  identity,
  metrics,
  state,
  diagnostics,
] = await Promise.all([
  import("../../src/audit/audit-event-writer.js"),
  import("../../src/infra/gateway-scheduler.js"),
  import("../../src/audit/audit-event-writer.test-support.js"),
  import("../../src/audit/execution-identity.test-support.js"),
  import("../../src/infra/worker-request-diagnostics.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/infra/diagnostic-events.js"),
]);
assert(loadedOwner, "captured audit owner was not loaded");
diagnostics.setDiagnosticsEnabledForProcess(true);
const now = Math.floor(Date.now() / 86_400_000) * 86_400_000;
const scheduler = new GatewayScheduler();
const errors: string[] = [];
const startWriter = () =>
  createAuditEventWriter({ scheduler, stateDir: output, onError: (error) => errors.push(error) });
let writer = startWriter();
const pause = (ms: number) => (ms === 0 ? setImmediate() : setTimeout(ms));
function prepareTurn(index: number) {
  const runId = `session-${Math.abs(index * 97) % 10000}:run-${index}`;
  const agentId = `agent-${Math.abs(index) % 40}`;
  const envelope = identity.captureExecutionIdentityAdmissionEnvelope(
    {
      runId,
      agentId,
      ingress: { kind: "gateway-client", boundary: "chat.send", state: "present" },
      runtime: { kind: "embedded" },
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
  const start = {
    ...fixture.input(),
    sourceId: `run-start-${index}`,
    occurredAt: now,
    runId,
    agentId,
    actorId: agentId,
  };
  const tool = {
    ...start,
    sourceId: `tool-start-${index}`,
    kind: "tool_action" as const,
    action: "tool.action.started" as const,
    toolName: "read",
    toolCallId: `call-${index}`,
  };
  const message = (action: Parameters<typeof fixture.messageEvent>[0]) => ({
    ...fixture.messageEvent(action),
    sourceId: `${action}-${index}`,
    sourceSequence: 1,
    occurredAt: now,
    runId,
    agentId,
    actorId: agentId,
    executionIdentityToken: token,
  });
  return [
    () => assert(writer.recordExecutionIdentity({ kind: "capture", envelope })),
    () => {
      assert(
        writer.recordExecutionDecision({
          ...fixture.decisionReceipt(),
          contextId: token.contextId,
          executionId: token.executionId,
          runId,
          receiptId: `decision-${index}`,
          occurredAt: now,
        }),
      );
      assert(writer.record(tool));
    },
    () => {
      assert(
        writer.record({
          ...tool,
          sourceId: `tool-finish-${index}`,
          action: "tool.action.finished",
          status: "succeeded",
        }),
      );
      assert(
        writer.recordRun(start, {
          ...start,
          sourceId: `run-finish-${index}`,
          sourceSequence: 2,
          action: "agent.run.finished",
          status: "succeeded",
        }),
      );
    },
    ...(
      [
        "message.outbound.queued",
        "message.outbound.platform-started",
        "message.outbound.finished",
      ] as const
    ).map((action) => {
      const input = message(action);
      return () => assert(writer.record(input));
    }),
  ];
}
async function runTurn(stages: ReturnType<typeof prepareTurn>) {
  for (const [index, stage] of stages.entries()) {
    stage();
    if (index < stages.length - 1) {
      await pause(stageGapMs);
    }
  }
  await pause(turnGapMs);
}
const inspector = new Session();
let stopMetrics: (() => void) | undefined;
// Audit drains are deliberately unref'ed; this isolated harness must stay alive to join them.
const keepAlive = globalThis.setInterval(() => {}, 60_000);
try {
  await writer.ready;
  for (let index = -4; index < 0; index++) {
    await runTurn(prepareTurn(index));
  }
  await writer.stop();
  assert.deepEqual(errors, []);
  writer = startWriter();
  await writer.ready;
  const turns = Array.from({ length: iterations }, (_, index) => prepareTurn(index));
  let requests = 0;
  const handlerMs: number[] = [];
  stopMetrics = metrics.onWorkerRequestMetrics(
    (kind, requestClass, phase, _depth, _wait, _duration, timing) => {
      if (
        kind !== "sqlite_writer" ||
        requestClass !== "audit.writer.process" ||
        phase !== "completed"
      ) {
        return;
      }
      requests++;
      if (timing?.executeStarted !== undefined && timing.executeFinished !== undefined) {
        handlerMs.push(timing.executeFinished - timing.executeStarted);
      }
    },
  );
  globalThis.gc?.();
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = { before: loadavg(), after: [] as number[] };
  const threadCpu = process.threadCpuUsage();
  const processCpu = process.cpuUsage();
  const started = performance.now();
  for (const turn of turns) {
    await runTurn(turn);
  }
  await writer.stop();
  const elapsedMs = performance.now() - started;
  const mainCpu = process.threadCpuUsage(threadCpu);
  const allCpu = process.cpuUsage(processCpu);
  const memory = process.memoryUsage();
  hostLoad.after = loadavg();
  const sampledBytes = values.allocation
    ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
        (sum, sample) => sum + sample.size,
        0,
      )
    : undefined;
  stopMetrics();
  assert.deepEqual(errors, []);
  const { db } = state.openOpenClawStateDatabase({ env: process.env });
  const activity = db
    .prepare("SELECT source_id FROM audit_events ORDER BY sequence")
    .all()
    .map((row) => row.source_id);
  const expected = Array.from({ length: iterations + 4 }, (_, offset) => offset - 4).flatMap(
    (index) => [
      `tool-start-${index}`,
      `tool-finish-${index}`,
      `run-start-${index}`,
      `run-finish-${index}`,
      `message.outbound.finished-${index}`,
    ],
  );
  assert.deepEqual(activity, expected);
  const rowCounts: Record<string, number> = { audit_events: activity.length };
  for (const [table, perTurn] of [
    ["outbound_message_progress", 2],
    ["execution_identity_contexts", 1],
    ["execution_decision_facts", 1],
  ] as const) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    assert(row);
    assert.equal(row.count, (iterations + 4) * perTurn);
    rowCounts[table] = row.count;
  }
  handlerMs.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      ownerSha256: createHash("sha256").update(ownerSource).digest("hex"),
      iterations,
      stageGapMs,
      turnGapMs,
      queuedItems: iterations * 8,
      rows: iterations * 9,
      requests,
      elapsedMs,
      mainCpuMs: (mainCpu.user + mainCpu.system) / 1000,
      processCpuMs: (allCpu.user + allCpu.system) / 1000,
      sampledMainBytes: sampledBytes,
      requestsPerMinute: (requests * 60000) / elapsedMs,
      rowsPerMinute: (iterations * 9 * 60000) / elapsedMs,
      auditRowsPerMinute: (iterations * 5 * 60000) / elapsedMs,
      progressRowsPerMinute: (iterations * 2 * 60000) / elapsedMs,
      handlerSamples: handlerMs.length,
      handlerP99Ms:
        handlerMs[Math.min(handlerMs.length - 1, Math.ceil(handlerMs.length * 0.99) - 1)],
      hostLoad,
      rowCountsIncludingWarmup: rowCounts,
      rowOrderSha256: createHash("sha256").update(JSON.stringify(activity)).digest("hex"),
      memory,
    }),
  );
} finally {
  stopMetrics?.();
  inspector.disconnect();
  await writer.stop();
  await scheduler.stop();
  await state.closeOpenClawStateDatabaseAsync();
  globalThis.clearInterval(keepAlive);
}
