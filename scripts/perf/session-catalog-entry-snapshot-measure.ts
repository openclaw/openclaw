/**
 * Catalog snapshot owner microbenchmark: 40 agents x 270 immutable entries.
 * Synthetic selection boundary; measures flattening, not Gateway/selection latency.
 * node --import ./scripts/tsx.mjs scripts/perf/session-catalog-entry-snapshot-measure.ts \
 *   --owner-file .local/base-session-catalog-entry-snapshot.ts --iterations 3000 \
 *   --workload cold --mode timing
 * Omit --owner-file for current source. Alternate base/candidate runs; measure
 * allocation separately. Cold advances the projection revision every call; warm
 * retains it. Work-count regression: --mode counts --expect-temporary-arrays 0
 * fails on the cold base (40 per-agent mapped arrays/call), passes direct flattening.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string" },
    "expect-temporary-arrays": { type: "string" },
    iterations: { type: "string", default: "3000" },
    mode: { type: "string", default: "timing" },
    workload: { type: "string", default: "cold" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "iterations must be positive");
assert(["timing", "allocation", "counts"].includes(values.mode), "invalid mode");
assert(["cold", "warm"].includes(values.workload), "invalid workload");
const expectedArrays =
  values["expect-temporary-arrays"] === undefined
    ? undefined
    : Number(values["expect-temporary-arrays"]);
assert(
  expectedArrays === undefined ||
    (values.mode === "counts" && Number.isSafeInteger(expectedArrays) && expectedArrays >= 0),
  "invalid expected array count",
);
const ownerUrl = new URL(
  "../../src/gateway/server-methods/session-catalog-entry-snapshot.ts",
  import.meta.url,
);
const ownerSource = readFileSync(values["owner-file"] ?? ownerUrl, "utf8");
// Stub only imports at the selected owner boundary; execute the actual owner source.
const fixtureUrl = `data:text/javascript,${encodeURIComponent(`
export const agentIds = Object.freeze(Array.from({length: 40}, (_, i) => 'agent-' + i));
export let temporaryArrays = 0;
class CountedPairs extends Array {
  static get [Symbol.species]() { temporaryArrays++; return Array; }
}
export const pairs = new Map(agentIds.map(agentId => [agentId,
  ${values.mode === "counts" ? "CountedPairs" : "Array"}.from({length: 270}, (_, i) => [
    'agent:' + agentId + ':' + i,
    Object.freeze({sessionId: agentId + '-' + i, updatedAt: i + 1})
  ])
]));
export const cfg = Object.freeze({agents: Object.freeze({entries:
  Object.freeze(Object.fromEntries(agentIds.map(id => [id, Object.freeze({})])))
})});
export const projection = {state: {revision: {}}, needsSelectionPreparation: () => false};
export const listAgentIds = () => agentIds;
export const normalizeAgentId = value => value.toLowerCase();
export const prepareSessionRowSelection = (_projection, {agentId}) => ({entries: () => pairs.get(agentId)});
const unused = () => { throw new Error('unexpected boundary in flatten benchmark'); };
export {unused as normalizeSessionColorValue, unused as resolveSessionCreatorActor,
  unused as sessionCreatorProfileId, unused as parseAgentSessionKey,
  unused as resolveAgentIdFromSessionKey, unused as freezeJsonSnapshot,
  unused as projectSessionActor, unused as tryResolveSessionCompatibilityOwnerAgentId,
  unused as resolveStoredSessionKeyForAgentStore};
`)}`;
let loaded = false;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return context.parentURL === ownerUrl.href && !specifier.startsWith("node:")
      ? { url: fixtureUrl, shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    if (url !== ownerUrl.href) {
      return next(url, context);
    }
    loaded = true;
    return { format: "module", source: stripTypeScriptTypes(ownerSource), shortCircuit: true };
  },
});
type Entry = Readonly<{ sessionId: string; updatedAt: number }>;
type CatalogEntry = { sessionKey: string; entry: Entry; agentId: string };
type Fixture = {
  agentIds: readonly string[];
  temporaryArrays: number;
  pairs: Map<string, readonly (readonly [string, Entry])[]>;
  cfg: object;
  projection: { state: { revision: object }; needsSelectionPreparation: () => boolean };
};
type Snapshot = { freeze: () => void; sessionEntries: { entriesForCatalog: () => CatalogEntry[] } };
const owner: {
  createSessionCatalogRequestEntrySnapshot: (params: {
    cfg: object;
    fallbackAgentId: string;
    projection: Fixture["projection"];
  }) => Snapshot;
} = await import(ownerUrl.href);
const fixture: Fixture = await import(fixtureUrl);
hooks.deregister();
assert(loaded, "selected owner was not loaded");
const fallbackAgentId = "agent-17";
const request = { cfg: fixture.cfg, projection: fixture.projection, fallbackAgentId };
const capture = () => {
  const snapshot = owner.createSessionCatalogRequestEntrySnapshot(request);
  snapshot.freeze();
  return snapshot.sessionEntries.entriesForCatalog();
};
const initial = capture();
assert.equal(capture(), initial, "unchanged revision must reuse flattened entries");
let output = initial;
const run = (count: number) => {
  for (let i = 0; i < count; i++) {
    if (values.workload === "cold") {
      fixture.projection.state.revision = {};
    }
    output = capture();
  }
};
run(100);
// Only counting fixtures use Array species; timing/allocation retain ordinary arrays.
const arraysBefore = fixture.temporaryArrays;
const inspector = new Session();
let allocatedBytes: number | undefined;
const loadStart = loadavg();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
try {
  const cpuStart = process.threadCpuUsage();
  const started = performance.now();
  run(iterations);
  const wallMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuStart);
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  }
  assert.equal(output.length, 10800);
  assert(Object.isFrozen(output));
  let offset = 0;
  for (const agentId of [
    fallbackAgentId,
    ...fixture.agentIds.filter((id) => id !== fallbackAgentId),
  ]) {
    for (const [sessionKey, entry] of fixture.pairs.get(agentId)!) {
      const actual = output[offset++]!;
      assert.equal(actual.agentId, agentId);
      assert.equal(actual.sessionKey, sessionKey);
      assert.equal(actual.entry, entry);
      assert(Object.isFrozen(actual));
    }
  }
  assert.equal(capture(), output, "final revision must reuse flattened entries");
  const temporaryArrays = fixture.temporaryArrays - arraysBefore;
  if (expectedArrays !== undefined) {
    assert.equal(temporaryArrays / iterations, expectedArrays, "temporary arrays per call");
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      workload: values.workload,
      iterations,
      agents: 40,
      entriesPerAgent: 270,
      ownerSha256: createHash("sha256").update(ownerSource).digest("hex"),
      wallMs,
      cpuScope: "main-thread",
      cpuMs: (cpu.user + cpu.system) / 1000,
      allocatedBytes,
      allocatedBytesPerCall: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      ...(values.mode === "counts" ? { temporaryArraysPerCall: temporaryArrays / iterations } : {}),
      loadStart,
      loadEnd: loadavg(),
    }),
  );
} finally {
  inspector.disconnect();
}
