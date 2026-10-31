/**
 * Audit identity persistence CPU/allocation microbenchmark; not a Gateway load test.
 * Run from each revision, alternating base/candidate, with a new isolated directory:
 * mkdir -p .local/audit-measure
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/audit-context-write-measure.ts \
 *   --state-dir .local/audit-measure/base-1 --iterations 3000
 * Repeat with --allocation for separate sampled-allocation passes. Setup and verification
 * are untimed. The real storage owner validates, HMAC-projects and independently commits
 * 3,000 contexts spanning 40 synthetic agents and 3,000 session correlations. Eight
 * grants and eight assurance entries exercise bounded metadata, never message content.
 * Accept identical canonical rows with fewer encodings and lower CPU or allocation;
 * report host load and raw paired results. Run pairs on the same UTC day for equal rows.
 * --worker-mix instead submits waves of four concurrent eight-context audit batches,
 * interleaved with synthetic machineState.write requests through the shared worker.
 * It reports transport service time, worker execution time, and queue wait by class;
 * machineState.write has the existing metric label "execute". This is an owner write
 * mix, not Team/Gateway load. --allocation applies only to the synchronous owner mode.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    iterations: { type: "string", default: "3000" },
    allocation: { type: "boolean", default: false },
    "worker-mix": { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "Pass a new isolated --state-dir");
assert(!(values.allocation && values["worker-mix"]), "--allocation cannot measure worker heaps");
const root = path.resolve(values["state-dir"]);
mkdirSync(root, { mode: 0o700 });
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = root;
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 3000,
});
const [
  { processExecutionIdentityAdmissionWorkInDatabase: persist },
  state,
  { captureExecutionIdentityAdmissionEnvelope: capture },
] = await Promise.all([
  import("../../src/audit/execution-identity-context.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/audit/execution-identity.test-support.js"),
]);
const sources = Object.fromEntries(
  ["execution-identity-context", "execution-identity-context-build"].map((name) => [
    name,
    createHash("sha256")
      .update(readFileSync(path.resolve("src/audit", `${name}.ts`)))
      .digest("hex"),
  ]),
);
const now = Math.floor(Date.now() / 86_400_000) * 86_400_000;
const envelope = (index: number) =>
  capture(
    {
      runId: `session-${index % 10000}:run-${index}`,
      agentId: `agent-${index % 40}`,
      ingress: { kind: "gateway-client", boundary: "chat.send", state: "present" },
      runtime: { kind: "embedded" },
      invoker: {
        state: "present",
        kind: "person",
        rawPrincipalRef: `synthetic-person-${index % 64}`,
      },
      applicableGrants: Array.from({ length: 8 }, (_, grant) => ({
        rawGrantRef: `grant-${grant}`,
        state: "present",
      })),
      assurance: Array.from({ length: 8 }, (_, evidence) => ({
        kind: "other",
        rawEvidenceRef: `evidence-${evidence}`,
        strength: "boundary-verified",
      })),
    },
    {
      contextId: `context-${index}`,
      executionId: `execution-${index}`,
      now,
      runtimeInstanceId: "synthetic-runtime",
    },
  );
const inputs = Array.from({ length: iterations }, (_, index) => ({
  kind: "capture" as const,
  envelope: envelope(index),
}));
const options = {
  env: { OPENCLAW_STATE_DIR: root },
  database: state.openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
  now,
};
// Public synthetic fixture key makes canonical bytes comparable across isolated installations.
state.runOpenClawStateWriteTransaction(({ db }) => {
  db.prepare(
    "INSERT INTO audit_identity_keys (id, key_id, key, created_at) VALUES (1, ?, ?, ?)",
  ).run("a".repeat(32), Buffer.alloc(32, 7), now);
}, options);
const inspector = new Session();
const workerMetrics = new Map<
  string,
  { durations: number[]; execution: number[]; queueWait: number[] }
>();
let stopMetrics: (() => void) | undefined;
try {
  let runWorkerMix: (() => Promise<void>) | undefined;
  if (values["worker-mix"]) {
    const [
      { executeOpenClawStateWorker: execute },
      { captureOpenClawStateWorkerContext },
      diagnostics,
      metrics,
      { writeConfigMachineStateAsync },
    ] = await Promise.all([
      import("../../src/state/openclaw-state-worker-store.js"),
      import("../../src/state/openclaw-state-worker-context.js"),
      import("../../src/infra/diagnostic-events.js"),
      import("../../src/infra/worker-request-diagnostics.js"),
      import("../../src/state/config-machine-state-async.js"),
    ]);
    diagnostics.setDiagnosticsEnabledForProcess(true);
    const context = captureOpenClawStateWorkerContext({ env: options.env });
    const audit = (work: typeof inputs) =>
      execute(context, {
        type: "audit.writer.process",
        input: work.map((item) => ({ type: "record-execution-identity" as const, work: item })),
      }).then((results) => {
        assert.deepEqual(
          results,
          work.map(() => ({ status: "settled" })),
        );
      });
    const otherWrite = (index: number) =>
      writeConfigMachineStateAsync("perf.audit-context-write", { index }, { env: options.env });
    for (let index = 0; index < 64; index += 8) {
      await audit(
        Array.from({ length: 8 }, (_, offset) => ({
          kind: "capture" as const,
          envelope: envelope(-index - offset - 1),
        })),
      );
    }
    await otherWrite(-1);
    runWorkerMix = async () => {
      for (let start = 0; start < inputs.length; start += 32) {
        const pending: Promise<unknown>[] = [];
        for (let index = start; index < Math.min(start + 32, inputs.length); index += 8) {
          pending.push(audit(inputs.slice(index, index + 8)), otherWrite(index));
        }
        const settled = await Promise.allSettled(pending);
        for (const result of settled) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
      }
    };
    stopMetrics = metrics.onWorkerRequestMetrics(
      (kind, requestClass, phase, _depth, queueWaitMs, durationMs, timing) => {
        if (kind !== "sqlite_writer") {
          return;
        }
        let samples = workerMetrics.get(requestClass);
        if (!samples) {
          samples = { durations: [], execution: [], queueWait: [] };
          workerMetrics.set(requestClass, samples);
        }
        if (phase === "started" && queueWaitMs !== undefined) {
          samples.queueWait.push(queueWaitMs);
        }
        if (phase === "completed" && durationMs !== undefined) {
          samples.durations.push(durationMs);
          if (timing?.executeStarted !== undefined && timing.executeFinished !== undefined) {
            samples.execution.push(timing.executeFinished - timing.executeStarted);
          }
        }
      },
    );
  } else {
    for (let index = 1; index <= 64; index++) {
      persist({ kind: "capture", envelope: envelope(-index) }, options);
    }
  }
  globalThis.gc?.();
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const cpu = process.threadCpuUsage();
  const processCpu = process.cpuUsage();
  const started = performance.now();
  if (runWorkerMix) {
    await runWorkerMix();
  } else {
    for (const input of inputs) {
      persist(input, options);
    }
  }
  const elapsedMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const processUsed = process.cpuUsage(processCpu);
  stopMetrics?.();
  const sampledBytes = values.allocation
    ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
        (sum, sample) => sum + sample.size,
        0,
      )
    : undefined;
  const summarize = (samples: number[]) => {
    const ordered = samples.toSorted((a, b) => a - b);
    const sumMs = samples.reduce((sum, sample) => sum + sample, 0);
    return {
      count: samples.length,
      sumMs,
      meanMs: samples.length ? sumMs / samples.length : null,
      p99Ms: ordered[Math.ceil(ordered.length * 0.99) - 1] ?? null,
    };
  };
  if (runWorkerMix) {
    assert.equal(
      workerMetrics.get("audit.writer.process")?.durations.length,
      Math.ceil(iterations / 8),
    );
    assert.equal(workerMetrics.get("execute")?.durations.length, Math.ceil(iterations / 8));
  }
  const workerRequests = runWorkerMix
    ? Object.fromEntries(
        [...workerMetrics].map(([requestClass, samples]) => {
          const service = summarize(samples.durations);
          const execution = summarize(samples.execution);
          return [
            requestClass,
            {
              requestsPerMinute: (service.count * 60_000) / elapsedMs,
              serviceSecondsPerMinute: (service.sumMs * 60) / elapsedMs,
              executionSecondsPerMinute: (execution.sumMs * 60) / elapsedMs,
              service,
              execution,
              queueWait: summarize(samples.queueWait),
            },
          ];
        }),
      )
    : undefined;
  await state.closeOpenClawStateDatabaseAsync();
  const rows = state
    .openOpenClawStateDatabase({ env: options.env })
    .db.prepare(
      "SELECT context_json, context_bytes FROM execution_identity_contexts ORDER BY execution_id",
    )
    .all();
  assert.equal(rows.length, iterations + 64);
  const digest = createHash("sha256");
  for (const row of rows) {
    assert.equal(typeof row.context_json, "string");
    const encoded = String(row.context_json);
    assert.equal(row.context_bytes, Buffer.byteLength(encoded, "utf8"));
    digest.update(encoded);
  }
  console.log(
    JSON.stringify({
      node: process.version,
      sources,
      iterations,
      mode: values["worker-mix"] ? "worker-mix" : values.allocation ? "allocation" : "timing",
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      cpuScope: "main-thread",
      processCpuMs: (processUsed.user + processUsed.system) / 1000,
      sampledBytes,
      hostLoad,
      workerRequests,
      memory: process.memoryUsage(),
      rowCount: rows.length,
      rowDigest: digest.digest("hex"),
    }),
  );
} finally {
  stopMetrics?.();
  inspector.disconnect();
  await state.closeOpenClawStateDatabaseAsync();
}
