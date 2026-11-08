/**
 * Owner benchmark for redundant ranking copies; no Gateway or live state.
 * node --import ./scripts/tsx.mjs scripts/perf/memory-ranking-copies.ts \
 *   --owner hybrid --mode cpu --iterations 2000
 * Use --owner knowledge for a 1,000-record vault, and --module <absolute .ts path>
 * for a frozen baseline owner with its relative imports intact. Run baseline and
 * candidate alternately in fresh processes. Repeat with --mode allocation; its
 * collected-object sampling distorts timing, so only cpu-mode timings are evidence.
 * Hybrid has 256 distinct candidates, overlapping vector/keyword hits, all exact
 * tiers, and disabled MMR/decay. Knowledge has pages, aliases, tied hubs, filed and
 * unfiled claims, and relationships. Fixtures are prepared before warmup.
 * Accept identical checksums and input bytes with lower CPU or allocation per op.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { LoadedRecord } from "../../extensions/knowledge/src/model.js";
import type { mergeHybridResults } from "../../extensions/memory-core/src/memory/hybrid.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "hybrid" },
    mode: { type: "string", default: "cpu" },
    module: { type: "string" },
    iterations: { type: "string", default: "2000" },
    warmup: { type: "string", default: "100" },
  },
});
assert(["hybrid", "knowledge"].includes(values.owner), "--owner must be hybrid or knowledge");
assert(["cpu", "allocation"].includes(values.mode), "--mode must be cpu or allocation");
const integer = (name: "iterations" | "warmup") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = integer("iterations");
const warmup = integer("warmup");
const checksum = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function hybridFixture(): Parameters<typeof mergeHybridResults>[0] {
  const rows = Array.from({ length: 256 }, (_, index) => ({
    id: `candidate-${index}`,
    path: `memory/project-${index % 20}/note-${index}.md`,
    startLine: index + 1,
    endLine: index + 4,
    source: "memory",
    snippet: `Synthetic project ${index % 20} decision ${index}: retain the original ordering.`,
    projectKey: `project-${index % 20}`,
    importance: 1 + (index % 10),
    exactPathSpecificity: ([0, 1, 2, 3] as const)[index % 4],
  }));
  return {
    // oxlint-disable-next-line oxc/no-map-spread -- Preserve fixture shapes; setup is outside measurement.
    vector: rows.slice(0, 192).map((row, index) => ({ ...row, vectorScore: (index % 23) / 23 })),
    // oxlint-disable-next-line oxc/no-map-spread -- Preserve fixture shapes; setup is outside measurement.
    keyword: rows.slice(128).map((row, index) => ({
      ...row,
      textScore: index % 5 === 0 ? 0 : (index % 19) / 19,
      pathScore: (index % 7) / 7,
      hasBodyMatch: index % 5 !== 0,
    })),
    vectorWeight: 0.7,
    textWeight: 0.3,
    activeProjectKeys: ["project-1", "project-4", "project-7"],
    mmr: { enabled: false, lambda: 0.7 },
    temporalDecay: { enabled: false, halfLifeDays: 30 },
  };
}

const asOf = Date.parse("2026-10-25T12:00:00Z");
function knowledgeFixture(): LoadedRecord[] {
  const recordId = (index: number) => `record-${String(index).padStart(6, "0")}`;
  return Array.from({ length: 1000 }, (_, index): LoadedRecord => {
    const kind = index < 200 ? "page" : index < 900 ? "claim" : "relationship";
    const type = kind === "page" ? ["project", "person", "company", "note"][index % 4]! : kind;
    const id = recordId(index);
    const title = `Synthetic ${type} ${index}: project delivery notes`;
    const recordedAt = new Date(asOf - (index % 10) * 86_400_000).toISOString();
    return {
      id,
      kind,
      type,
      title,
      path: `${kind}s/${id}.md`,
      lifecycle: "active",
      revision: 1,
      valid: true,
      hash: "0".repeat(64),
      body: "",
      raw: "",
      metadata: {
        format: "knowledge-record-v1",
        id,
        kind,
        type,
        title,
        revision: 1,
        lifecycle: "active",
        scope: { visibility: "private" },
        recorded_at: recordedAt,
        updated_at: recordedAt,
        ...(kind === "page"
          ? { aliases: [`Project ${index}`, `Alias ${index}`, `Synthetic longer alias ${index}`] }
          : kind === "claim"
            ? {
                claim_kind: (["decision", "commitment", "fact"] as const)[index % 3],
                entities: index % 5 === 0 ? [] : [recordId(index % 20), recordId((index + 1) % 20)],
              }
            : { from: recordId(index % 200), to: recordId((index + 1) % 200) }),
      },
    };
  });
}

let fixture: unknown;
let run: () => unknown;
if (values.owner === "hybrid") {
  const subject = values.module
    ? pathToFileURL(path.resolve(values.module)).href
    : "../../extensions/memory-core/src/memory/hybrid.ts";
  const owner: typeof import("../../extensions/memory-core/src/memory/hybrid.js") = await import(
    subject
  );
  const input = hybridFixture();
  fixture = input;
  run = () => owner.mergeHybridResults(input);
} else {
  const subject = values.module
    ? pathToFileURL(path.resolve(values.module)).href
    : "../../extensions/knowledge/src/memory-index.ts";
  const owner: typeof import("../../extensions/knowledge/src/memory-index.js") = await import(
    subject
  );
  const records = knowledgeFixture();
  fixture = records;
  run = () => owner.buildMemoryIndex(records, asOf);
}
const inputChecksum = checksum(fixture);
const outputChecksum = checksum(await run());
for (let index = 0; index < warmup; index++) {
  await run();
}
await nextTurn();

const profiler = values.mode === "allocation" ? new Session() : undefined;
if (profiler) {
  await startCollectedHeapSampling(profiler, 4096);
}
const gcEntries: PerformanceEntry[] = [];
const observer = new PerformanceObserver((list) => gcEntries.push(...list.getEntries()));
observer.observe({ entryTypes: ["gc"] });
const hostLoadBefore = loadavg();
const memoryBefore = process.memoryUsage();
const cpuStart = process.threadCpuUsage();
const started = performance.now();
let result: unknown;
for (let index = 0; index < iterations; index++) {
  result = await run();
  if (index % 100 === 99) {
    await nextTurn();
  }
}
const stopped = performance.now();
const cpu = process.threadCpuUsage(cpuStart);
const memoryAfter = process.memoryUsage();
const hostLoadAfter = loadavg();
await nextTurn();
await nextTurn();
gcEntries.push(...observer.takeRecords());
observer.disconnect();
let allocatedBytesPerOp: number | undefined;
let allocationSamples: number | undefined;
if (profiler) {
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  allocatedBytesPerOp = profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations;
  allocationSamples = profile.samples.length;
  profiler.disconnect();
}
assert.equal(checksum(fixture), inputChecksum, "owner mutated its input");
assert.equal(checksum(result), outputChecksum, "owner output changed across iterations");
const pauses = gcEntries
  .filter((entry) => entry.startTime >= started && entry.startTime < stopped)
  .map((entry) => entry.duration);
console.log(
  JSON.stringify({
    owner: values.owner,
    mode: values.mode,
    module: values.module ?? "current",
    node: process.version,
    iterations,
    warmup,
    inputChecksum,
    outputChecksum,
    elapsedMs: stopped - started,
    cpuUsPerOp: values.mode === "cpu" ? (cpu.user + cpu.system) / iterations : undefined,
    allocatedBytesPerOp,
    allocationSamples,
    gc: {
      count: pauses.length,
      msPerOp: pauses.reduce((sum, duration) => sum + duration, 0) / iterations,
      maxPauseMs: Math.max(0, ...pauses),
    },
    hostLoadBefore,
    hostLoadAfter,
    memoryBefore,
    memoryAfter,
  }),
);
