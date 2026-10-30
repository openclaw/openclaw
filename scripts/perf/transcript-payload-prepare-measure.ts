/**
 * Synthetic transcript writer payload preparation, including native navigation SQL and zstd.
 * Run alternating baseline/candidate processes, with timing and allocation in separate passes:
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-payload-prepare-measure.ts \
 *     --iterations 1000 --mode timing [--baseline-dir <absolute-source-overlay>]
 * Repeat with --mode allocation. Save the baseline transcript-payload.ts beneath the overlay's
 * src/config/sessions/ path; the existing benchmark preload substitutes that source only.
 * Fixtures cover assistant text, tool calls and tool results. No Gateway or real state is used.
 * Compare payloadDigest for byte equivalence, CPU/op from untraced timing, and sampled bytes/op
 * from allocation (including collected objects). Report host load and GC rather than gating
 * on allocation-pass timings. Acceptance: less allocation, unchanged bytes, no material CPU rise.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler, serialize } from "node:v8";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "1000" },
    mode: { type: "string", default: "timing" },
    "baseline-dir": { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.mode === "timing" || values.mode === "allocation");
assert(globalThis.gc, "Run with --expose-gc");
const ownerPath = "src/config/sessions/transcript-payload.ts";
const source = values["baseline-dir"]
  ? path.resolve(values["baseline-dir"], ownerPath)
  : fileURLToPath(new URL(`../../${ownerPath}`, import.meta.url));
const sourceDigest = createHash("sha256").update(readFileSync(source)).digest("hex");
if (values["baseline-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["baseline-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const { openNodeSqliteDatabase } = await import("../../src/infra/node-sqlite.js");
const { admitSqliteSchema } = await import("../../src/infra/sqlite-schema-facts.js");
const { prepareTranscriptPayload, readTranscriptPayload } =
  await import("../../src/config/sessions/transcript-payload.js");
using database = openNodeSqliteDatabase(":memory:");
admitSqliteSchema(database);
const fixtures = [
  { role: "assistant", content: "Synthetic answer café 雪 🦞. ".repeat(256) },
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call",
        name: "read",
        arguments: { path: "synthetic.txt", context: "fixture ".repeat(512) },
      },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "call",
    toolName: "read",
    isError: false,
    content: [{ type: "text", text: "Synthetic tool output line. ".repeat(2048) }],
  },
].map((message, index) => {
  const event = { type: "message", id: `event-${index}`, parentId: null, message };
  return { event, json: JSON.stringify(event) };
});
const prepare = (index: number) => {
  const fixture = fixtures[index % fixtures.length]!;
  return prepareTranscriptPayload(database, fixture.json, fixture.event);
};
const digest = createHash("sha256");
for (let index = 0; index < fixtures.length; index++) {
  const payload = prepare(index);
  assert(payload.event_zstd, "Fixture must exercise compression");
  assert.equal(readTranscriptPayload(payload), fixtures[index]!.json);
  digest.update(serialize(payload));
}
for (let index = 0; index < 100; index++) {
  prepare(index);
}
globalThis.gc();
const inspector = values.mode === "allocation" ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const gc = new GCProfiler();
gc.start();
const hostLoadBefore = loadavg();
const cpu = process.threadCpuUsage();
const start = performance.now();
let compressedBytes = 0;
for (let index = 0; index < iterations; index++) {
  compressedBytes += prepare(index).event_zstd!.byteLength;
}
const elapsedMs = performance.now() - start;
const cpuUsage = process.threadCpuUsage(cpu);
const gcProfile = gc.stop();
let allocatedBytes: number | undefined;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  const sum = (node: typeof profile.head): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
}
console.log(
  JSON.stringify({
    sourceDigest,
    payloadDigest: digest.digest("hex"),
    mode: values.mode,
    iterations,
    fixtureBytes: fixtures.map(({ json }) => Buffer.byteLength(json)),
    cpuUsPerOp: (cpuUsage.user + cpuUsage.system) / iterations,
    allocatedBytesPerOp: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    elapsedMs,
    compressedBytes,
    gcProfile,
    memory: process.memoryUsage(),
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    node: process.version,
  }),
);
