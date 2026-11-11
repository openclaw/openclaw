/**
 * Host dispatch cost, excluding SQL and worker result decoding.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sqlite-worker-dispatch-measure.ts
 * Run unchanged on base/candidate in alternating order. Prepared jobs carry the
 * eight-family SQLite selection. A real worker drains transport;
 * this isolates dispatch and does not claim Gateway throughput or job frequency.
 * Five untraced CPU passes and a separate allocation pass, 10,000 jobs each.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { serialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { installDatabaseEngineSelection } from "../../src/infra/database-engine/context.js";
import { createSqliteFamilyEngines } from "../../src/infra/database-engine/selection-fixture.test-support.js";
import { createSqliteDatabaseAdmissionCursor } from "../../src/infra/sqlite-database-admission.js";
import { dispatchSqliteWorkerJob } from "../../src/infra/sqlite-worker-broker-reply.js";
import type { Job, Slot } from "../../src/infra/sqlite-worker-broker.types.js";
import { SqliteWorkerSlotCustody } from "../../src/infra/sqlite-worker-request-custody.js";

const iterations = 10_000;
const gc = global.gc;
assert(gc, "Run with --expose-gc");
const selection = { effectiveEngines: createSqliteFamilyEngines() };
installDatabaseEngineSelection(selection);
const stateContext = {
  databaseEngineSelection: selection,
  environment: { OPENCLAW_STATE_DIR: "/synthetic/dispatch-only" },
};
const worker = new Worker(
  `const {parentPort} = require('node:worker_threads');
   parentPort.on('message', value => { if (value === 'drain') parentPort.postMessage('drained'); });`,
  { eval: true, execArgv: [] },
);
const slot: Slot = {
  worker,
  custody: new SqliteWorkerSlotCustody(),
  databaseAdmissionCursor: createSqliteDatabaseAdmissionCursor(),
  actors: new Set(),
  queue: [],
  receiveReply() {},
  exit: Promise.resolve(),
  exited: false,
  pendingOpens: 0,
};
const result = Promise.resolve();
const observation = { started() {}, completed() {} };
function unexpected(error: unknown): never {
  throw new Error("Unexpected dispatch failure", { cause: error });
}
function prepare(count: number): Job[] {
  return Array.from({ length: count }, (_, id) => {
    const custody = slot.custody.createRequest();
    custody.activate();
    return {
      custody,
      observation,
      request: {
        type: "execute",
        id,
        actor: 1,
        stateContext,
        input: serialize({ type: "synthetic.read", input: undefined }),
      },
      bytes: 0,
      result,
      resolve: unexpected,
      reject: unexpected,
      detach() {},
    };
  });
}
async function run(jobs: Job[]) {
  for (const job of jobs) {
    await dispatchSqliteWorkerJob(slot, job, unexpected);
  }
}
async function drain() {
  const received = once(worker, "message");
  worker.postMessage("drain", []);
  assert.deepEqual(await received, ["drained"]);
}
const inspector = new Session();
const initialLoad = loadavg();
try {
  await once(worker, "online");
  await run(prepare(1000));
  await drain();
  const timing = [];
  for (let pass = 0; pass < 5; pass++) {
    const jobs = prepare(iterations);
    gc();
    const cpu = process.threadCpuUsage();
    const at = performance.now();
    await run(jobs);
    const elapsedMs = performance.now() - at;
    const used = process.threadCpuUsage(cpu);
    timing.push({ cpuUsPerJob: (used.user + used.system) / iterations, elapsedMs });
    await drain();
  }
  const jobs = prepare(iterations);
  gc();
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await run(jobs);
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  await drain();
  console.log(
    JSON.stringify(
      {
        node: process.version,
        iterationsPerPass: iterations,
        timing,
        sampledBytesPerJob:
          profile.samples.reduce((total, sample) => total + sample.size, 0) / iterations,
        initialLoad,
        finalLoad: loadavg(),
        memory: process.memoryUsage(),
      },
      null,
      2,
    ),
  );
} finally {
  inspector.disconnect();
  await worker.terminate();
}
