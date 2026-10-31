/**
 * Session-store owner allocation/CPU and retained-shape benchmark, without I/O.
 * node --expose-gc scripts/perf/gateway-session-store-shapes.mjs \
 *   <session-utils-store-read.ts> <cpu|allocation|retention> [iterations=2500]
 * Run separate processes in AB/BA order against saved baseline/candidate sources.
 * Fixtures precede measurement: 10k sessions, 100 disjoint 100-row lookup windows.
 * The production reader is evaluated intact with only its storage imports replaced
 * by fixture readers. Each call creates a fresh request-local lookup store.
 * Accept identical keys, JSON and entry identities with fewer shapes/allocated
 * bytes and no material CPU increase. This is not whole-Gateway latency proof.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { getHeapSnapshot } from "node:v8";
import { runInThisContext } from "node:vm";

const [file, mode, count = "2500"] = process.argv.slice(2);
const iterations = Number(count);
assert(file && ["cpu", "allocation", "retention"].includes(mode));
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(globalThis.gc, "--expose-gc is required");
const source = readFileSync(file, "utf8");
const body = stripTypeScriptTypes(source.replace(/^import[\s\S]*?;\n/gm, "")).replace(
  /^export /gm,
  "",
);
let selected;
const fixtureReader = () => selected;
const read = runInThisContext(
  `(function (
  listAccessorSessionEntries, listAccessorSessionEntriesReadOnly, loadExactSessionEntryCandidates
) { ${body}; return readGatewaySessionStore; })`,
  { filename: file },
)(fixtureReader, fixtureReader, fixtureReader);
const windows = Array.from({ length: 100 }, (_, window) =>
  Array.from({ length: 100 }, (_row, index) => ({
    sessionKey: `agent:synthetic:subagent:${window * 100 + index}`,
    entry: { sessionId: `session-${window * 100 + index}`, updatedAt: index },
  })),
);
function lookup(index) {
  selected = windows[index % windows.length];
  return read({ storePath: "/synthetic", options: { readOnly: true } });
}
for (const [index, entries] of windows.entries()) {
  const store = lookup(index);
  assert.deepEqual(
    Object.keys(store),
    entries.map(({ sessionKey }) => sessionKey),
  );
  for (const { sessionKey, entry } of entries) {
    assert.equal(store[sessionKey], entry);
  }
  assert.equal(
    JSON.stringify(store),
    JSON.stringify(Object.fromEntries(entries.map(({ sessionKey, entry }) => [sessionKey, entry]))),
  );
}

async function census() {
  globalThis.gc();
  const heapUsed = process.memoryUsage().heapUsed;
  const chunks = [];
  for await (const chunk of getHeapSnapshot()) {
    chunks.push(chunk);
  }
  const heap = JSON.parse(Buffer.concat(chunks).toString());
  const fields = heap.snapshot.meta.node_fields;
  const stride = fields.length;
  const type = fields.indexOf("type"),
    name = fields.indexOf("name"),
    size = fields.indexOf("self_size");
  const totals = { heapUsed, shapes: 0, shapeBytes: 0, propertyArrayBytes: 0 };
  for (let index = 0; index < heap.nodes.length; index += stride) {
    if (heap.snapshot.meta.node_types[type][heap.nodes[index + type]] === "object shape") {
      totals.shapes++;
      totals.shapeBytes += heap.nodes[index + size];
    }
    if (heap.strings[heap.nodes[index + name]] === "system / PropertyArray") {
      totals.propertyArrayBytes += heap.nodes[index + size];
    }
  }
  return totals;
}
const result = {
  mode,
  node: process.version,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  sessions: 10000,
  rowsPerLookup: 100,
  iterations,
  hostLoad: loadavg(),
};
if (mode === "retention") {
  // Use new key sets after the baseline census so previous probes cannot retain
  // this workload's transition trees through their own inline caches.
  for (const entries of windows) {
    for (const row of entries) {
      row.sessionKey += ":retained";
    }
  }
  await census();
  const before = await census();
  const stores = windows.map((_, index) => lookup(index));
  const after = await census();
  assert.equal(stores.length, 100);
  result.retainedStores = stores.length;
  result.before = before;
  result.after = after;
  result.delta = Object.fromEntries(
    Object.keys(before).map((key) => [key, after[key] - before[key]]),
  );
} else {
  for (let index = 0; index < 1000; index++) {
    lookup(index);
  }
  globalThis.gc();
  const inspector = new Session();
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 512,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const started = performance.now(),
    cpu = process.threadCpuUsage();
  let last;
  for (let index = 0; index < iterations; index++) {
    last = lookup(index);
  }
  const elapsed = process.threadCpuUsage(cpu);
  result.wallMs = performance.now() - started;
  result.cpuUs = elapsed.user + elapsed.system;
  assert.equal(Object.keys(last).length, 100);
  if (mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node) =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    result.sampledBytes = sum(profile.head);
    inspector.disconnect();
  }
}
console.log(JSON.stringify(result));
