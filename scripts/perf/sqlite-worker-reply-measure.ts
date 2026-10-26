/**
 * Measure the actual SQLite broker reply owner on one checked-out revision.
 * Usage: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sqlite-worker-reply-measure.ts
 * Run unchanged on base and candidate; compare the JSON CPU/op and sampled bytes/op.
 * Synthetic replies and jobs are prepared outside every measured loop. Five untraced
 * timing passes are separate from allocation sampling, which includes collected objects.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { serialize } from "node:v8";
import { receiveSqliteWorkerReply } from "../../src/infra/sqlite-worker-broker-reply.js";
import type { Job } from "../../src/infra/sqlite-worker-broker.types.js";
import type { SqliteWorkerReply } from "../../src/infra/sqlite-worker-contract.js";
import { SqliteWorkerSlotCustody } from "../../src/infra/sqlite-worker-request-custody.js";

const iterations = 5_000;
const samplingInterval = 512;
const gc = global.gc;
assert(gc, "Run with --expose-gc");
const initialLoad = loadavg();
const result = Promise.resolve(undefined);
const observation = { started() {}, completed() {} };
const custody = new SqliteWorkerSlotCustody();
const request: Job["request"] = { type: "execute", id: 1, actor: 1, input: new Uint8Array() };
const unexpected = () => {
  throw new Error("Unexpected broker operation");
};
const slot: Parameters<typeof receiveSqliteWorkerReply>[0] = {
  actors: new Set(),
  worker: { postMessage: unexpected },
};
let completed = 0;
let lastValue: unknown;
const owner = {
  fail: unexpected,
  finish(_job: Job, error?: unknown, value?: unknown) {
    if (error !== undefined) {
      throw new Error("Unexpected SQLite reply failure", { cause: error });
    }
    completed++;
    lastValue = value;
  },
  dispatch() {},
};
function prepare(count: number): Job[] {
  return Array.from({ length: count }, () => {
    const requestCustody = custody.createRequest();
    requestCustody.activate();
    requestCustody.accept();
    requestCustody.post();
    return {
      custody: requestCustody,
      observation,
      request,
      bytes: 0,
      result,
      resolve: unexpected,
      reject: unexpected,
      detach: unexpected,
    };
  });
}
function run(jobs: Job[], reply: SqliteWorkerReply) {
  for (const job of jobs) {
    slot.current = job;
    receiveSqliteWorkerReply(slot, reply, owner);
  }
}
function entry(index: number) {
  return {
    sessionId: `synthetic-session-${index}`,
    sessionKey: `agent:main:subagent:synthetic-${index}`,
    title: `Synthetic completed worker ${index}`,
    updatedAt: 1_780_000_000_000 + index,
    model: "mock",
    inputTokens: 2400,
    outputTokens: 700,
    deliveryContext: { channel: "webchat", accountId: "synthetic" },
  };
}
const fixtures = [
  { name: "scalar", value: true },
  { name: "session-entry", value: entry(1) },
  { name: "session-page-64", value: Array.from({ length: 64 }, (_, index) => entry(index)) },
];
const inspector = new Session();
inspector.connect();
const reports = [];
try {
  for (const fixture of fixtures) {
    const reply: SqliteWorkerReply = { id: 1, ok: true, value: serialize(fixture.value) };
    run(prepare(500), reply);
    const timing = [];
    const loadBefore = loadavg();
    for (let sample = 0; sample < 5; sample++) {
      const jobs = prepare(iterations);
      gc();
      const cpu = process.threadCpuUsage();
      const started = performance.now();
      run(jobs, reply);
      const elapsedMs = performance.now() - started;
      const used = process.threadCpuUsage(cpu);
      timing.push({
        nsPerReply: (elapsedMs * 1e6) / iterations,
        cpuUsPerReply: (used.user + used.system) / iterations,
      });
    }
    const jobs = prepare(iterations);
    gc();
    const memoryBefore = process.memoryUsage();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    run(jobs, reply);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const memoryAfter = process.memoryUsage();
    assert.deepEqual(lastValue, fixture.value);
    reports.push({
      name: fixture.name,
      iterationsPerPass: iterations,
      timing,
      sampledBytesPerReply:
        profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations,
      samplingInterval,
      loadBefore,
      loadAfter: loadavg(),
      memoryBefore,
      memoryAfter,
    });
  }
} finally {
  inspector.disconnect();
}
assert.equal(completed, fixtures.length * (500 + iterations * 6));
console.log(
  JSON.stringify({ node: process.version, initialLoad, finalLoad: loadavg(), reports }, null, 2),
);
