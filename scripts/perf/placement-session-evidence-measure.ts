/**
 * Placement retirement preparation: 10k sessions, then 3k passes of 100 changed sessions.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/placement-session-evidence-measure.ts
 *   [--evidence-source saved-evidence.ts --key-source saved-key.ts] [--mode timing|allocation]
 * Run base/candidate in alternating order, five samples each. The real retirement
 * and identity preparation owners run against an in-memory placement store and a
 * fixed current-evidence I/O boundary. This isolates preparation; it does not measure
 * SQL, worker transport, or whole-Gateway latency. Timing is untraced; allocation
 * includes collected objects in a separate process. No Gateway or live state is used.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { WorkerSessionPlacementRecord } from "../../src/gateway/worker-environments/placement-record.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    "evidence-source": { type: "string" },
    "key-source": { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.mode === "timing" || values.mode === "allocation");
const replacements = new Map<string, string>();
for (const [name, filename] of [
  ["server-worker-placement-session-evidence", values["evidence-source"]],
  ["session-store-key", values["key-source"]],
] as const) {
  if (filename) {
    replacements.set(
      new URL(`../../src/gateway/${name}.ts`, import.meta.url).href,
      stripTypeScriptTypes(readFileSync(filename, "utf8")),
    );
  }
}
replacements.set(
  new URL("../../src/config/sessions/session-placement-evidence.ts", import.meta.url).href,
  `export async function readPlacementSessionIdentityEvidence(_cfg, probes) {
    return probes.map(() => ({ status: "current" }));
  }`,
);
const loaded = new Set<string>();
registerHooks({
  load(url, context, nextLoad) {
    const source = replacements.get(url);
    if (source !== undefined) {
      loaded.add(url);
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { setRuntimeConfigSnapshot } = await import("../../src/config/config.js");
const { createWorkerPlacementSessionEvidenceResolver } =
  await import("../../src/gateway/server-worker-placement-session-evidence.js");
const { createPlacementSessionRetirement } =
  await import("../../src/gateway/worker-environments/placement-session-retirement.js");
const { localPlacement } =
  await import("../../src/gateway/worker-environments/placement-suite.test-support.js");
assert.equal(loaded.size, replacements.size, "All selected source replacements must load");
setRuntimeConfigSnapshot({
  agents: { entries: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`agent-${i}`, {}])) },
});
const records = Array.from({ length: 10_000 }, (_, i) => ({
  ...localPlacement(`session-${i}`),
  agentId: `agent-${i % 40}`,
  sessionKey: `agent:agent-${i % 40}:${i % 5 ? "subagent" : "dashboard"}:session-${i}`,
}));
const byId = new Map(records.map((record) => [record.sessionId, record]));
const identities = records.map(({ sessionId, agentId, sessionKey }) => ({
  sessionId,
  agentId,
  sessionKey,
}));
let passes = 0;
let subjects = 0;
let fullReads = 0;
const createRetirement = () =>
  createPlacementSessionRetirement({
    placements: {
      listSessionIdentitiesAsync: async () => {
        fullReads++;
        return identities;
      },
      getAsync: async (id) => byId.get(id),
      getManyAsync: async (ids) => {
        const found = new Map<string, WorkerSessionPlacementRecord>();
        for (const id of ids) {
          const record = byId.get(id);
          assert(record);
          found.set(id, record);
        }
        return found;
      },
      retireSessionPlacementAsync: async () => assert.fail("Current sessions must not retire"),
    },
    environments: { get: () => undefined },
    forceDestroyEnvironment: async () => assert.fail("Current sessions must not destroy owners"),
    createSessionEvidenceResolver: async (placements, signal) => {
      passes++;
      subjects += placements.length;
      return createWorkerPlacementSessionEvidenceResolver(placements, signal);
    },
    reportChanges: (operation) => operation(),
    warn: (message) => assert.fail(message),
  });
async function run(count: number) {
  const retirement = createRetirement();
  await retirement.reconcile();
  for (let pass = 0; pass < count; pass++) {
    for (let offset = 0; offset < 100; offset++) {
      retirement.markPending(`session-${(pass * 100 + offset) % records.length}`);
    }
    await retirement.reconcile();
    await retirement.reconcile(); // No new receipt: no evidence work.
  }
}
await run(100);
passes = subjects = fullReads = 0;
globalThis.gc?.();
const inspector = values.mode === "allocation" ? new Session() : undefined;
inspector?.connect();
await inspector?.post("HeapProfiler.startSampling", {
  samplingInterval: 32768,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
const hostLoad = loadavg();
const cpuStart = process.threadCpuUsage();
const started = performance.now();
await run(iterations);
const elapsedMs = performance.now() - started;
const cpu = process.threadCpuUsage(cpuStart);
const allocation = await inspector?.post("HeapProfiler.stopSampling");
inspector?.disconnect();
assert.equal(fullReads, 1);
assert.equal(passes, iterations + 1);
assert.equal(subjects, 10000 + iterations * 100);
console.log(
  JSON.stringify({
    mode: values.mode,
    iterations,
    passes,
    subjects,
    fullReads,
    hostLoad,
    ...(allocation
      ? { sampledBytes: sumSampledHeapBytes(allocation.profile.head) }
      : {
          cpuMs: (cpu.user + cpu.system) / 1000,
          elapsedMs,
        }),
  }),
);
