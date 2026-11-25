/**
 * node --expose-gc scripts/perf/worker-task-transfer-list-measure.mjs BASE_HOST CANDIDATE_HOST
 * Five alternating AB/BA passes, 1M calls per CPU arm and 10k per allocation arm.
 * Extracts the actual host method and PostgreSQL list owner to avoid starting the
 * unrelated Gateway services. Covers warm tasks and first-task admission/PG ports;
 * input payloads are unchanged. This measures preparation, not native IPC or a Gateway.
 * Accept lower allocation/work with equivalent ordered ports and no consistent CPU loss.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { compileFunction } from "node:vm";
import { MessageChannel } from "node:worker_threads";
import { workerMessagePayloadBytes } from "../../src/infra/worker-message-metrics.ts";

const files = process.argv.slice(2);
assert.equal(files.length, 2, "BASE_HOST CANDIDATE_HOST required");
assert(globalThis.gc, "--expose-gc required");
function extract(source, start, end) {
  assert.equal(source.split(start).length, 2, `ambiguous start: ${start}`);
  assert.equal(source.split(end).length, 2, `ambiguous end: ${end}`);
  assert(source.indexOf(end) > source.indexOf(start));
  return source.slice(source.indexOf(start), source.indexOf(end));
}
const pgSource = stripTypeScriptTypes(readFileSync("src/infra/postgres-sync/pool.ts", "utf8"));
const pgOwner = extract(
  pgSource,
  "export function postgresPoolTransferList(",
  "export function selectPostgresPoolService(",
).replace("export ", "");
const owners = files.map((file) => {
  const source = readFileSync(file, "utf8");
  const method = extract(
    stripTypeScriptTypes(source),
    "    taskContextTransferList(context)",
    "    createTaskObserver(url)",
  );
  return {
    sha256: createHash("sha256").update(source).digest("hex"),
    run: compileFunction(`${pgOwner}; return ({${method}}).taskContextTransferList;`)(),
  };
});
const channels = Array.from({ length: 5 }, () => new MessageChannel());
const contexts = {
  warm: { deletedAgentDatabaseFences: [] },
  admission: { databaseAdmissionPort: channels[0].port1, deletedAgentDatabaseFences: [] },
  postgres: {
    databaseAdmissionPort: channels[0].port1,
    deletedAgentDatabaseFences: [],
    postgresPool: {
      allocation: new SharedArrayBuffer(4),
      services: channels
        .slice(1)
        .map(({ port1 }) => ({ port: port1, signal: new SharedArrayBuffer(8) })),
    },
  },
};
function sampledBytes(node) {
  return node.selfSize + node.children.reduce((total, child) => total + sampledBytes(child), 0);
}
let last;
function run(owner, context, count) {
  for (let i = 0; i < count; i++) {
    last = owner.run(context);
  }
}
const rows = [];
const inspector = new Session();
inspector.connect();
try {
  for (const [shape, context] of Object.entries(contexts)) {
    const expected =
      shape === "warm"
        ? []
        : channels.slice(0, shape === "admission" ? 1 : 5).map(({ port1 }) => port1);
    for (const owner of owners) {
      run(owner, context, 100_000);
      assert.deepEqual(last, expected);
    }
    for (const mode of ["cpu", "allocation"]) {
      const iterations = mode === "cpu" ? 1_000_000 : 10_000;
      for (let pass = 0; pass < 5; pass++) {
        for (const arm of pass % 2 ? [1, 0] : [0, 1]) {
          globalThis.gc();
          if (mode === "allocation") {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 128,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          const cpu = process.threadCpuUsage();
          run(owners[arm], context, iterations);
          const used = process.threadCpuUsage(cpu);
          const allocated =
            mode === "allocation"
              ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
              : undefined;
          assert.deepEqual(last, expected);
          rows.push({
            shape,
            mode,
            pass,
            arm,
            iterations,
            cpuMs: (used.user + used.system) / 1000,
            sampledBytes: allocated,
            hostLoad: loadavg(),
          });
        }
      }
    }
  }
} finally {
  inspector.disconnect();
  channels.forEach(({ port1, port2 }) => {
    port1.close();
    port2.close();
  });
}
const payloadMetricRows = [];
for (const [shape, input] of [
  ["object-1-row", { rows: [{ sessionKey: "synthetic" }] }],
  [
    "object-10000-rows",
    { rows: Array.from({ length: 10_000 }, (_, i) => ({ sessionKey: `synthetic-${i}` })) },
  ],
  ["bytes-64KiB", new Uint8Array(65_536)],
  ["string-64KiB", "x".repeat(65_536)],
]) {
  const message = { taskId: 1, input };
  for (let i = 0; i < 100_000; i++) {
    workerMessagePayloadBytes(message);
  }
  const iterations = 1_000_000;
  const cpu = process.threadCpuUsage();
  for (let i = 0; i < iterations; i++) {
    workerMessagePayloadBytes(message);
  }
  const used = process.threadCpuUsage(cpu);
  payloadMetricRows.push({
    shape,
    iterations,
    payloadBytes: workerMessagePayloadBytes(message) ?? null,
    cpuMs: (used.user + used.system) / 1000,
  });
}
console.log(
  JSON.stringify(
    { node: process.version, hashes: owners.map(({ sha256 }) => sha256), rows, payloadMetricRows },
    null,
    2,
  ),
);
