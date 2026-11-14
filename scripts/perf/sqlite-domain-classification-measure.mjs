/**
 * Diagnostic-owner cost only; no SQL, worker scheduling, or Gateway latency claim.
 * node --expose-gc scripts/perf/sqlite-domain-classification-measure.mjs [classifier.ts]
 * Run two A/A controls then five alternating A/B pairs with the same Node binary.
 * A baseline snapshot needs only its relative import URL adjusted to the original owner.
 * Acceptance: known commands stop collapsing; unknown inputs remain bounded;
 * no additional payload traversal and no material CPU/allocation regression.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { classifyWorkerRequest } = await import(
  process.argv[2]
    ? pathToFileURL(resolve(process.argv[2])).href
    : new URL("../../src/infra/sqlite-worker-request-class.ts", import.meta.url).href
);
assert(globalThis.gc, "Run with --expose-gc");
const types = [
  "source.replace",
  "cache.prune",
  "schema.admit",
  "forget.purge",
  "prepareRun",
  "batch",
  "session.actor.appendTranscriptEvent",
  "session.metadata.append",
  "session.transcript.manualCompact",
  "synthetic-private-command",
];
let payloadReads = 0;
const commands = Array.from({ length: 5_000 }, (_, index) => ({
  id: `synthetic-session-${index}`,
  command: {
    type: types[index % types.length],
    get input() {
      payloadReads++;
      throw new Error("Diagnostic classification must not read owner payloads");
    },
  },
}));
const calls = commands.length * 40;
function run() {
  let fallback = 0;
  for (let repeat = 0; repeat < 40; repeat++) {
    for (const command of commands) {
      fallback += classifyWorkerRequest("database.domain.execute", command) === "domain_execute";
    }
  }
  return fallback;
}
run();
globalThis.gc();
const hostLoad = loadavg();
const started = performance.now();
const cpu = process.threadCpuUsage();
const fallbacks = run();
const elapsedMs = performance.now() - started;
const used = process.threadCpuUsage(cpu);
globalThis.gc();
const inspector = new Session();
inspector.connect();
try {
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  assert.equal(run(), fallbacks);
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  assert.equal(payloadReads, 0);
  console.log(
    JSON.stringify({
      node: process.version,
      sessions: commands.length,
      calls,
      fallbacks,
      payloadReads,
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      sampledBytes: profile.samples.reduce((total, sample) => total + sample.size, 0),
      hostLoad,
    }),
  );
} finally {
  inspector.disconnect();
}
