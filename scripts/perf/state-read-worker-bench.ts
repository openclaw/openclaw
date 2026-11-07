/**
 * Real state-read worker reads over synthetic Team-shaped state.
 * --kind acp (default), shared-facts, lifecycle, plugins, machine-state, or session-list
 * selects the operation. ACP/shared facts select 500 of 10,000 rows per task;
 * session-list reads 10,000 finished runs; plugin/config payloads contain 40 plugins.
 * Run each kind separately: no production-frequency mix is implied by these probes.
 * Run five interleaved baseline/candidate pairs, each with a fresh output directory:
 *   node --import ./scripts/tsx.mjs scripts/perf/state-read-worker-bench.ts \
 *     --output "$PWD/.local/state-read-candidate-1" --iterations 2000
 * --owner-dir substitutes files at matching repository-relative paths before imports.
 * --allocations enables collected-object sampling in a separate pass; its timings
 * are not timing evidence. Both arms use the same worker instrumentation preload.
 * The default 200 warmups precede measurement. By default no forced GC occurs. Native GC
 * census boundaries include 1.1 seconds of idle draining outside request timing.
 * Reply digests preserve JSON field and result ordering. Source-mode workers include
 * the TypeScript loader; this is owner/transport proof, not a full Gateway load test.
 * --rows 20000 doubles the default session population; use a multiple of 500.
 * --retained-heap collects before/after the measured window in a separate retention
 * diagnostic pass. Its forced pre-window GC makes its timings unsuitable as gates.
 * Native total-allocated-byte deltas, when available, also measure untraced churn.
 * --readonly selects executeExistingOpenClawStateRead with owner-created schema.
 * --kind cron reads 500 job names from 10,000 synthetic jobs; mixed alternates
 * shared session facts and cron names (an explicit probe mix, not a traffic claim).
 * --interval-ms 150 paces reads near 400/minute; zero measures throughput.
 * Both keep the same rows.
 * --verify-charges separately records actual pool admission byte charges, including
 * warmup; compare equal-length output paths so path-byte charges match across arms.
 * --accounting-only isolates requestBytes on these selectors, excluding transport.
 * Main allocation includes collected objects; untraced native allocation counters
 * are included when the runtime provides them. Profiles stay in the output folder.
 * --snapshot adds post-GC worker snapshots at both retention boundaries; use with
 * --retained-heap and keep this diagnostic pass separate from latency gates.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { availableParallelism, hostname, loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { WorkerTaskPoolCore } from "@openclaw/worker-runtime";
import type { AcpSessionReadCommand } from "../../src/acp/runtime/session-meta-read.types.js";
import type { OpenClawStateReadCommand } from "../../src/state/openclaw-state-read.types.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    kind: { type: "string", default: "acp" },
    iterations: { type: "string", default: "2000" },
    warmup: { type: "string", default: "200" },
    rows: { type: "string", default: "10000" },
    "retained-heap": { type: "boolean", default: false },
    snapshot: { type: "boolean", default: false },
    "owner-dir": { type: "string" },
    allocations: { type: "boolean", default: false },
    readonly: { type: "boolean", default: false },
    "accounting-only": { type: "boolean", default: false },
    "verify-charges": { type: "boolean", default: false },
    "interval-ms": { type: "string", default: "0" },
  },
});
const kinds = [
  "acp",
  "shared-facts",
  "lifecycle",
  "plugins",
  "machine-state",
  "session-list",
  "cron",
  "mixed",
];
assert(!values.snapshot || values["retained-heap"], "--snapshot requires --retained-heap");
assert(kinds.includes(values.kind), `--kind must be one of ${kinds.join(", ")}`);
assert(values.output, "--output must name a new synthetic fixture directory");
const root = path.resolve(values.output);
assert(!fs.existsSync(root), "Refusing to reuse an existing fixture directory");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 2000,
});
const warmup = parseStrictIntegerOption({
  raw: values.warmup,
  label: "--warmup",
  min: 200,
  fallback: 200,
});
const intervalMs = parseStrictIntegerOption({
  raw: values["interval-ms"],
  label: "--interval-ms",
  min: 0,
  fallback: 0,
});
const output = path.join(root, "workers");
const environment = {
  OPENCLAW_STATE_DIR: path.join(root, "state"),
};
for (const directory of [output, environment.OPENCLAW_STATE_DIR, path.join(root, "tmp")]) {
  fs.mkdirSync(directory, { recursive: true });
}
Object.assign(process.env, environment, {
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
  TMPDIR: path.join(root, "tmp"),
  OPENCLAW_BENCH_RETAINED_WORKER_DIR: output,
  OPENCLAW_BENCH_SAMPLE_ALLOCATION: values.allocations ? "1" : "0",
  OPENCLAW_BENCH_SAMPLE_CPU: "0",
  OPENCLAW_BENCH_TRACE_GC: "0",
});
if (values["owner-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["owner-dir"]);
} else {
  delete process.env.OPENCLAW_BENCH_BASELINE_DIR;
}
// Install source substitution before importing owners or creating their native workers.
await import("./worker-retained-heap-preload.js");
const { buildAcpDatabaseSessionKey } = await import("../../src/acp/runtime/session-meta-keys.js");
const { openNodeSqliteDatabase } = await import("../../src/infra/node-sqlite.js");
const { disposeSqliteStatement } = await import("../../src/infra/kysely-sync-cache-state.js");
const { updateConfigMachineStateInDatabase } =
  await import("../../src/state/config-machine-state-write.js");
const { extractSqliteTableSchema } = await import("../../src/infra/sqlite-schema-sql.js");
const { captureOpenClawStateReadSource } =
  await import("../../src/state/openclaw-state-read-worker.js");
const { executeExistingOpenClawStateRead } =
  await import("../../src/state/openclaw-state-db-readonly.js");
const { withExistingOpenClawStateSchema } =
  await import("../../src/state/openclaw-state-db-schema-policy.js");
const { installDatabaseProcessRole } =
  await import("../../src/infra/database-engine/admission-scope.js");
if (values.readonly) {
  installDatabaseProcessRole("gateway");
}
const stateCache = await import("../../src/state/openclaw-state-db-cache.js");
const metrics = await import("../../src/infra/worker-cpu.js");
const { requestBytes } = await import("../../src/state/openclaw-state-read-request.js");
const requestOwnerPath = "src/state/openclaw-state-read-request.ts";
const replacementRequest =
  values["owner-dir"] && path.resolve(values["owner-dir"], requestOwnerPath);
const requestOwnerSourceSha256 = createHash("sha256")
  .update(
    fs.readFileSync(
      replacementRequest && fs.existsSync(replacementRequest)
        ? replacementRequest
        : new URL(`../../${requestOwnerPath}`, import.meta.url),
    ),
  )
  .digest("hex");
const chargeDigest = createHash("sha256");
let chargeCount = 0;
if (values["verify-charges"]) {
  // The interceptor forwards the original receiver via apply below.
  // oxlint-disable-next-line typescript/unbound-method
  const runTask = WorkerTaskPoolCore.prototype.runTask;
  WorkerTaskPoolCore.prototype.runTask = function (...args: Parameters<typeof runTask>) {
    chargeCount++;
    chargeDigest.update(`${args[1].inputBytes}\n`);
    return runTask.apply(this, args);
  };
}
const ownerPath =
  values.kind === "lifecycle"
    ? "src/state/agent-lifecycle-read.worker.ts"
    : values.kind === "plugins"
      ? "src/plugins/plugin-metadata-state.kernel.ts"
      : values.kind === "machine-state"
        ? "src/state/config-machine-state-row.ts"
        : values.kind === "session-list"
          ? "src/agents/subagents/registry/subagent-registry.store.sqlite.ts"
          : "src/acp/runtime/session-meta-keys.ts";
const replacementOwner = values["owner-dir"] && path.resolve(values["owner-dir"], ownerPath);
const ownerSource =
  replacementOwner && fs.existsSync(replacementOwner)
    ? replacementOwner
    : new URL(`../../${ownerPath}`, import.meta.url);
const ownerSourceSha256 = createHash("sha256").update(fs.readFileSync(ownerSource)).digest("hex");
const readConnectionPath = "src/state/openclaw-state-db-read-connection.ts";
const replacementConnection =
  values["owner-dir"] && path.resolve(values["owner-dir"], readConnectionPath);
const readConnectionSourceSha256 = createHash("sha256")
  .update(
    fs.readFileSync(
      replacementConnection && fs.existsSync(replacementConnection)
        ? replacementConnection
        : new URL(`../../${readConnectionPath}`, import.meta.url),
    ),
  )
  .digest("hex");
const rows = parseStrictIntegerOption({
  raw: values.rows,
  label: "--rows",
  min: 500,
  fallback: 10_000,
});
const batchSize = 500;
assert.equal(rows % batchSize, 0, "--rows must be a multiple of 500");
const keys = Array.from({ length: rows }, (_, index) =>
  buildAcpDatabaseSessionKey(`agent:main:synthetic-${index}`, "main"),
);
const acpCommands: Extract<AcpSessionReadCommand, { type: "acpSessions.metadata" }>[] = Array.from(
  { length: rows / batchSize },
  (_, batch) => ({
    type: "acpSessions.metadata",
    entries: keys.slice(batch * batchSize, (batch + 1) * batchSize).map((key) => ({
      keys: [key],
      entry: { sessionId: "synthetic-session", lifecycleRevision: "synthetic-generation" },
    })),
  }),
);
const commands: OpenClawStateReadCommand[] =
  values.kind === "mixed"
    ? acpCommands.flatMap((command): OpenClawStateReadCommand[] => [
        { type: "sessionRows.sharedFacts", entries: command.entries.map((acp) => ({ acp })) },
        {
          type: "cron.jobNames",
          storePath: "/synthetic/cron",
          jobIds: command.entries.map((entry) => entry.keys[0]!),
        },
      ])
    : values.kind === "shared-facts"
      ? acpCommands.map((command) => ({
          type: "sessionRows.sharedFacts",
          entries: command.entries.map((acp) => ({ acp })),
        }))
      : values.kind === "lifecycle"
        ? [{ type: "agentLifecycle.read", input: "main" }]
        : values.kind === "plugins"
          ? [{ type: "plugins.metadata.read", input: { selector: "installed-index" } }]
          : values.kind === "machine-state"
            ? [{ type: "machineState.read", input: { key: "synthetic.config" } }]
            : values.kind === "session-list"
              ? [{ type: "subagents.sessionList" }]
              : values.kind === "cron"
                ? acpCommands.map((command) => ({
                    type: "cron.jobNames",
                    storePath: "/synthetic/cron",
                    jobIds: command.entries.map((entry) => entry.keys[0]!),
                  }))
                : acpCommands;
const pluginPayload = JSON.stringify({
  plugins: Array.from({ length: 40 }, (_, index) => ({
    id: `synthetic-plugin-${index}`,
    path: `/synthetic/plugins/plugin-${index}`,
    version: "1.0.0",
    config: { enabled: true, description: "Synthetic plugin metadata. ".repeat(80) },
  })),
});
const filename = path.join(environment.OPENCLAW_STATE_DIR, "state.sqlite");
if (values.readonly) {
  const { openOpenClawStateDatabase } = await import("../../src/state/openclaw-state-db.js");
  openOpenClawStateDatabase({ path: filename, env: environment });
}
{
  using db = openNodeSqliteDatabase(filename);
  const schema = fs.readFileSync(
    new URL("../../src/state/openclaw-state-schema.sql", import.meta.url),
    "utf8",
  );
  const tables = [
    "acp_sessions",
    "agent_provenance",
    "agent_deletion_journal",
    "subagent_runs",
    "cron_jobs",
  ];
  for (const table of tables) {
    db.exec(extractSqliteTableSchema(schema, table));
  }
  db.exec(`CREATE TABLE IF NOT EXISTS config_machine_state
    (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER); BEGIN`);
  const insert = db.prepare(`INSERT INTO acp_sessions
    (session_key, session_id, backend, agent, runtime_session_name, mode, state,
     last_activity_at, updated_at, runtime_options_json)
    VALUES (?, 'synthetic-generation', 'fixture', 'main', ?, 'persistent', 'idle', 100, 100, ?)`);
  const insertRun = db.prepare(`INSERT INTO subagent_runs
    (run_id, child_session_key, requester_session_key, created_at, payload_json)
    VALUES (?, ?, 'agent:main:parent', ?, ?)`);
  const insertJob = db.prepare(`INSERT INTO cron_jobs
    (store_key, job_id, name, enabled, payload_kind, job_json, updated_at)
    VALUES ('/synthetic/cron', ?, ?, 1, 'agentTurn', '{}', 100)`);
  try {
    for (const [index, key] of keys.entries()) {
      if (values.kind === "cron" || values.kind === "mixed") {
        insertJob.run(key, `Synthetic job ${index}`);
      }
      insert.run(key, `synthetic-runtime-${index}`, '{"model":"fixture-model"}');
      if (values.kind === "session-list") {
        insertRun.run(
          `run-${index}`,
          `agent:main:synthetic-${index}`,
          index + 1,
          JSON.stringify({
            createdAt: index + 1,
            execution: {
              status: "terminal",
              startedAt: index + 1,
              endedAt: index + 2,
              outcome: { status: "ok" },
            },
            completion: { required: false, resultText: "Synthetic retained result. ".repeat(80) },
            delivery: { status: "not_required" },
          }),
        );
      }
    }
    updateConfigMachineStateInDatabase(
      db,
      "plugins.installedIndex",
      () => JSON.parse(pluginPayload),
      100,
    );
    updateConfigMachineStateInDatabase(
      db,
      "synthetic.config",
      () => JSON.parse(pluginPayload),
      100,
    );
    db.exec(`INSERT INTO agent_provenance VALUES ('main', 'operator', NULL, 100); COMMIT`);
  } finally {
    disposeSqliteStatement(insert);
    disposeSqliteStatement(insertRun);
    disposeSqliteStatement(insertJob);
  }
}

type Measurement = {
  ok: boolean;
  complete?: boolean;
  cpu: NodeJS.CpuUsage;
  elapsedMs: number;
  allocation?: { sampledBytes: number; samples: number };
  initialMemory?: { allocatedBytes?: number };
  finalMemory?: { allocatedBytes?: number };
};
async function sample(name: string, operation: "start" | "stop" | "collect" | "snapshot") {
  const ready = fs.readdirSync(output).flatMap((file) => {
    if (!file.endsWith(".ready.json")) {
      return [];
    }
    const identity = JSON.parse(fs.readFileSync(path.join(output, file), "utf8")) as {
      script: string;
      commandPath: string;
    };
    return identity.script === "openclaw-state-read.worker.ts" ? [identity] : [];
  });
  assert.equal(ready.length, 1, "Serial workload must retain exactly one measured state reader");
  const commandPath = ready[0]!.commandPath;
  const reply = commandPath.replace(".command.json", `.${name}.json`);
  fs.writeFileSync(`${commandPath}.tmp`, JSON.stringify({ id: name, operation }));
  fs.renameSync(`${commandPath}.tmp`, commandPath);
  const deadline = Date.now() + 120_000;
  while (!fs.existsSync(reply)) {
    assert(Date.now() < deadline, "State-reader instrumentation timed out");
    await delay(25);
  }
  // The benchmark preload owns this private result file and its complete metric payload.
  const result = JSON.parse(fs.readFileSync(reply, "utf8")) as Measurement;
  assert(result.ok, JSON.stringify(result));
  return result;
}
function census() {
  const snapshot = metrics.getTrackedWorkerLifecycleSnapshot();
  const worker = snapshot.workerTaskMetrics.filter(
    (entry) => entry.script === "openclaw-state-read.worker.js",
  );
  return {
    snapshot,
    tasks: worker.reduce((total, entry) => total + entry.tasksCompleted, 0),
    reclaimedBytes: worker.reduce(
      (total, entry) => total + entry.gc.reduce((sum, gc) => sum + gc.reclaimedBytes, 0),
      0,
    ),
    gcMs: worker.reduce(
      (total, entry) => total + entry.gc.reduce((sum, gc) => sum + gc.durationMs, 0),
      0,
    ),
  };
}
if (values["accounting-only"]) {
  const requests = commands.map((command) => ({
    context: { environment },
    databasePath: filename,
    location: filename,
    checkFreshAdmission: false,
    command,
  }));
  for (let index = 0; index < warmup; index++) {
    requestBytes(requests[index % requests.length]!);
  }
  const inspector = values.allocations ? new Session() : undefined;
  if (inspector) {
    await startCollectedHeapSampling(inspector, 4096);
  }
  const allocatedBefore: unknown = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
  const cpuBefore = process.threadCpuUsage();
  const loadBefore = loadavg();
  const start = performance.now();
  let bytes = 0;
  for (let index = 0; index < iterations; index++) {
    bytes += requestBytes(requests[index % requests.length]!);
  }
  const elapsedMs = performance.now() - start;
  const cpu = process.threadCpuUsage(cpuBefore);
  const allocatedAfter: unknown = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
  const allocation = inspector ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  inspector?.disconnect();
  const result = {
    workload: "requestBytes only",
    requestOwnerSourceSha256,
    kind: values.kind,
    rows,
    batchSize,
    iterations,
    bytes,
    allocationSampling: values.allocations,
    elapsedMs,
    loadBefore,
    loadAfter: loadavg(),
    mainCpuUsPerTask: (cpu.user + cpu.system) / iterations,
    mainNativeAllocationBytesPerTask:
      typeof allocatedBefore === "number" && typeof allocatedAfter === "number"
        ? (allocatedAfter - allocatedBefore) / iterations
        : undefined,
    mainSampledAllocationBytesPerTask: allocation
      ? sumSampledHeapBytes(allocation.profile.head) / iterations
      : undefined,
  };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await stateCache.closeOpenClawStateDatabaseAsync();
  process.exit(0);
}
metrics.setTrackedWorkerGcObserver(() => {});
const source = captureOpenClawStateReadSource();
const signal = new AbortController().signal;
async function read(command: (typeof commands)[number]) {
  const admission = values.readonly
    ? undefined
    : stateCache.captureOpenClawStateDatabaseReadAdmission(filename);
  const transport = values.readonly ? undefined : source.createTransport(command);
  try {
    const outcome =
      transport && admission
        ? await transport.startRead(
            { context: { environment, admission }, location: filename, checkFreshAdmission: false },
            { signal, assertCurrent: admission.assertCurrent },
          )
        : {
            value: await withExistingOpenClawStateSchema({ path: filename }, () =>
              executeExistingOpenClawStateRead({ path: filename, env: environment }, command, {
                current: true,
                live: true,
              }),
            ),
          };
    if ("error" in outcome) {
      throw outcome.error;
    }
    const result = outcome.value;
    assert(result && result.ok && result.type === command.type);
    if (result.type === "acpSessions.metadata" && command.type === result.type) {
      assert.equal(result.rows.length, batchSize);
      for (const [index, row] of result.rows.entries()) {
        assert.equal(row?.session_key, command.entries[index]!.keys[0]);
      }
    } else if (result.type === "sessionRows.sharedFacts" && command.type === result.type) {
      assert.equal(result.rows.length, batchSize);
      for (const [index, row] of result.rows.entries()) {
        assert.equal(row.acp?.session_key, command.entries[index]!.acp!.keys[0]);
      }
    } else if (result.type === "cron.jobNames" && command.type === result.type) {
      assert.equal(result.names.size, batchSize);
      for (const key of command.jobIds) {
        assert(result.names.get(key)?.startsWith("Synthetic job "));
      }
    } else if (result.type === "agentLifecycle.read") {
      assert.deepEqual(result.facts, {
        deletionBlocked: false,
        provenance: {
          agentId: "main",
          createdVia: "operator",
          creatorAgentId: null,
          createdAtMs: 100,
        },
      });
    } else if (result.type === "plugins.metadata.read") {
      assert.deepEqual(result.rows, [
        { state_key: "plugins.installedIndex", value_json: pluginPayload },
      ]);
    } else if (result.type === "machineState.read") {
      assert.deepEqual(result.row, { value_json: pluginPayload, updated_at_ms: 100 });
    } else if (result.type === "subagents.sessionList") {
      assert("runs" in result, "Session-list read must return runs");
      assert.equal(result.runs.size, rows);
      let index = 0;
      for (const [key, run] of result.runs) {
        assert.equal(key, `run-${index}`);
        assert.equal(run.childSessionKey, `agent:main:synthetic-${index++}`);
        assert.equal(run.execution.status, "terminal");
      }
    }
    return outcome.value;
  } finally {
    await transport?.startClose();
  }
}
try {
  for (let index = 0; index < warmup; index++) {
    await read(commands[index % commands.length]!);
  }
  const retainedBefore = values["retained-heap"]
    ? await sample("retained-before", values.snapshot ? "snapshot" : "collect")
    : undefined;
  await delay(1_100);
  const before = census();
  const loadBefore = loadavg();
  await sample("start", "start");
  const inspector = values.allocations ? new Session() : undefined;
  if (inspector) {
    await startCollectedHeapSampling(inspector, 4096);
  }
  const allocatedBefore: unknown = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  const digest = createHash("sha256");
  const latencies: number[] = [];
  for (let index = 0; index < iterations; index++) {
    if (intervalMs) {
      await delay(Math.max(0, started + index * intervalMs - performance.now()));
    }
    const start = performance.now();
    const result = await read(commands[index % commands.length]!);
    latencies.push(performance.now() - start);
    digest.update(
      JSON.stringify(result, (_key, value: unknown) => (value instanceof Map ? [...value] : value)),
    );
  }
  const elapsedMs = performance.now() - started;
  const mainCpu = process.threadCpuUsage(cpuBefore);
  const allocatedAfter: unknown = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
  const mainAllocation = inspector ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  inspector?.disconnect();
  if (mainAllocation) {
    fs.writeFileSync(
      path.join(root, "main-allocation.json"),
      JSON.stringify(mainAllocation.profile),
    );
  }
  const measurement = await sample("stop", "stop");
  assert(measurement.complete, "Worker GC measurement exceeded its sample budget");
  await delay(1_100);
  const after = census();
  assert.equal(after.tasks - before.tasks, iterations, "Worker task census must cover every reply");
  const retainedAfter = values["retained-heap"]
    ? await sample("retained-after", values.snapshot ? "snapshot" : "collect")
    : undefined;
  latencies.sort((left, right) => left - right);
  const result = {
    workload: `${commands[0]!.type} real worker`,
    kind: values.kind,
    requestOwnerSourceSha256,
    readonly: values.readonly,
    chargeCount: values["verify-charges"] ? chargeCount : undefined,
    chargeSha256: values["verify-charges"] ? chargeDigest.digest("hex") : undefined,
    intervalMs,
    mainNativeAllocationBytesPerTask:
      typeof allocatedBefore === "number" && typeof allocatedAfter === "number"
        ? (allocatedAfter - allocatedBefore) / iterations
        : undefined,
    mainSampledAllocationBytesPerTask: mainAllocation
      ? sumSampledHeapBytes(mainAllocation.profile.head) / iterations
      : undefined,
    host: hostname(),
    node: process.version,
    availableParallelism: availableParallelism(),
    loadBefore,
    loadAfter: loadavg(),
    ownerDir: values["owner-dir"] ? path.resolve(values["owner-dir"]) : null,
    ownerSourceSha256,
    readConnectionSourceSha256,
    rows,
    batchSize: values.kind === "acp" || values.kind === "shared-facts" ? batchSize : undefined,
    keysPerEntry: values.kind === "acp" || values.kind === "shared-facts" ? 1 : undefined,
    iterations,
    warmup,
    allocationSampling: values.allocations,
    retainedBefore,
    retainedAfter,
    replySha256: digest.digest("hex"),
    elapsedMs,
    workerCpuUsPerTask: (measurement.cpu.user + measurement.cpu.system) / iterations,
    nativeAllocationBytesPerTask:
      measurement.initialMemory?.allocatedBytes !== undefined &&
      measurement.finalMemory?.allocatedBytes !== undefined
        ? (measurement.finalMemory.allocatedBytes - measurement.initialMemory.allocatedBytes) /
          iterations
        : undefined,
    mainCpuUsPerTask: (mainCpu.user + mainCpu.system) / iterations,
    sampledAllocationBytesPerTask:
      measurement.allocation === undefined
        ? undefined
        : measurement.allocation.sampledBytes / iterations,
    gcReclaimedBytesPerTask: (after.reclaimedBytes - before.reclaimedBytes) / iterations,
    nativeGcMsPerTask: (after.gcMs - before.gcMs) / iterations,
    latency: {
      samples: latencies.length,
      p50Ms: latencies[Math.ceil(latencies.length * 0.5) - 1],
      p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
      p99Ms: latencies[Math.ceil(latencies.length * 0.99) - 1],
      maxMs: latencies.at(-1),
    },
    measurement,
    nativeBefore: before.snapshot,
    nativeAfter: after.snapshot,
  };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  try {
    await stateCache.closeOpenClawStateDatabaseAsync();
  } finally {
    metrics.setTrackedWorkerGcObserver(undefined);
  }
}
