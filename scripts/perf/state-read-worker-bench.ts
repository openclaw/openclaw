/**
 * Real state-read worker: 500 canonical ACP keys/task over 10,000 synthetic rows.
 * Run five interleaved baseline/candidate pairs, each with a fresh output directory:
 *   node --import ./scripts/tsx.mjs scripts/perf/state-read-worker-bench.ts \
 *     --output "$PWD/.local/state-read-candidate-1" --iterations 2000
 * --owner-dir substitutes files at matching repository-relative paths before imports.
 * --allocations enables collected-object sampling in a separate pass; its timings
 * are not timing evidence. Both arms use the same worker instrumentation preload.
 * The default 200 warmups precede measurement. No forced GC occurs. Native GC
 * census boundaries include 1.1 seconds of idle draining outside request timing.
 * Reply digests preserve JSON field and result ordering. Source-mode workers include
 * the TypeScript loader; this is owner/transport proof, not a full Gateway load test.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { availableParallelism, hostname, loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { AcpSessionReadCommand } from "../../src/acp/runtime/session-meta-read.types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    iterations: { type: "string", default: "2000" },
    warmup: { type: "string", default: "200" },
    "owner-dir": { type: "string" },
    allocations: { type: "boolean", default: false },
  },
});
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
const { extractSqliteTableSchema } = await import("../../src/infra/sqlite-schema-sql.js");
const { captureOpenClawStateReadSource } =
  await import("../../src/state/openclaw-state-read-worker.js");
const stateCache = await import("../../src/state/openclaw-state-db-cache.js");
const metrics = await import("../../src/infra/worker-cpu.js");
const ownerSource = values["owner-dir"]
  ? path.resolve(values["owner-dir"], "src/acp/runtime/session-meta-keys.ts")
  : new URL("../../src/acp/runtime/session-meta-keys.ts", import.meta.url);
const ownerSourceSha256 = createHash("sha256").update(fs.readFileSync(ownerSource)).digest("hex");
const rows = 10_000;
const batchSize = 500;
const keys = Array.from({ length: rows }, (_, index) =>
  buildAcpDatabaseSessionKey(`agent:main:synthetic-${index}`, "main"),
);
const commands: Extract<AcpSessionReadCommand, { type: "acpSessions.metadata" }>[] = Array.from(
  { length: rows / batchSize },
  (_, batch) => ({
    type: "acpSessions.metadata",
    entries: keys.slice(batch * batchSize, (batch + 1) * batchSize).map((key) => ({
      keys: [key],
      entry: { sessionId: "synthetic-session", lifecycleRevision: "synthetic-generation" },
    })),
  }),
);
const filename = path.join(environment.OPENCLAW_STATE_DIR, "state.sqlite");
{
  using db = openNodeSqliteDatabase(filename);
  db.exec(
    extractSqliteTableSchema(
      fs.readFileSync(
        new URL("../../src/state/openclaw-state-schema.sql", import.meta.url),
        "utf8",
      ),
      "acp_sessions",
    ),
  );
  db.exec(`CREATE TABLE config_machine_state
    (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER); BEGIN`);
  const insert = db.prepare(`INSERT INTO acp_sessions
    (session_key, session_id, backend, agent, runtime_session_name, mode, state,
     last_activity_at, updated_at, runtime_options_json)
    VALUES (?, 'synthetic-generation', 'fixture', 'main', ?, 'persistent', 'idle', 100, 100, ?)`);
  try {
    for (const [index, key] of keys.entries()) {
      insert.run(key, `synthetic-runtime-${index}`, '{"model":"fixture-model"}');
    }
    db.exec("COMMIT");
  } finally {
    disposeSqliteStatement(insert);
  }
}

type Measurement = {
  ok: boolean;
  complete?: boolean;
  cpu: NodeJS.CpuUsage;
  elapsedMs: number;
  allocation?: { sampledBytes: number; samples: number };
};
async function sample(name: string, operation: "start" | "stop") {
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
metrics.setTrackedWorkerGcObserver(() => {});
const source = captureOpenClawStateReadSource();
const signal = new AbortController().signal;
async function read(command: (typeof commands)[number]) {
  const admission = stateCache.captureOpenClawStateDatabaseReadAdmission(filename);
  const transport = source.createTransport(command);
  try {
    const outcome = await transport.startRead(
      { context: { environment, admission }, location: filename, checkFreshAdmission: false },
      { signal, assertCurrent: admission.assertCurrent },
    );
    if ("error" in outcome) {
      throw outcome.error;
    }
    assert(outcome.value.ok && outcome.value.type === "acpSessions.metadata");
    assert.equal(outcome.value.rows.length, batchSize);
    for (const [index, row] of outcome.value.rows.entries()) {
      assert.equal(row?.session_key, command.entries[index]!.keys[0]);
    }
    return outcome.value;
  } finally {
    await transport.startClose();
  }
}
try {
  for (let index = 0; index < warmup; index++) {
    await read(commands[index % commands.length]!);
  }
  await delay(1_100);
  const before = census();
  const loadBefore = loadavg();
  await sample("start", "start");
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  const digest = createHash("sha256");
  const latencies: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    const result = await read(commands[index % commands.length]!);
    latencies.push(performance.now() - start);
    digest.update(JSON.stringify(result));
  }
  const elapsedMs = performance.now() - started;
  const mainCpu = process.threadCpuUsage(cpuBefore);
  const measurement = await sample("stop", "stop");
  assert(measurement.complete, "Worker GC measurement exceeded its sample budget");
  await delay(1_100);
  const after = census();
  assert.equal(after.tasks - before.tasks, iterations, "Worker task census must cover every reply");
  latencies.sort((left, right) => left - right);
  const result = {
    workload: "acpSessions.metadata real worker",
    host: hostname(),
    node: process.version,
    availableParallelism: availableParallelism(),
    loadBefore,
    loadAfter: loadavg(),
    ownerDir: values["owner-dir"] ? path.resolve(values["owner-dir"]) : null,
    ownerSourceSha256,
    rows,
    batchSize,
    keysPerEntry: 1,
    iterations,
    warmup,
    allocationSampling: values.allocations,
    replySha256: digest.digest("hex"),
    elapsedMs,
    workerCpuUsPerTask: (measurement.cpu.user + measurement.cpu.system) / iterations,
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
