/**
 * Stream long answers through the production visible-text filters in 98-character chunks.
 * A JSON fence activates the tool-call checkpoint before ordinary newline-delimited prose.
 * Run the same command on base and candidate; allocation sampling includes collected objects.
 *
 * node --import ./scripts/tsx.mjs scripts/perf/text-projection-append-measure.ts \
 *   --mode timing --output .local/text-projection-timing.json
 * Repeat with --mode allocation --check-scaling (separate from timing); optional --turns 10 --chunk 98.
 * This owner measurement supplements, not replaces, a matched Gateway load test.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { assistantVisibleTextFilters } from "../../src/shared/text/assistant-visible-text.js";
import { createTextProjection } from "../../src/shared/text/text-projection.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    turns: { type: "string", default: "10" },
    chunk: { type: "string", default: "98" },
    output: { type: "string" },
    "check-scaling": { type: "boolean", default: false },
  },
});
assert(values.mode === "timing" || values.mode === "allocation", "invalid --mode");
assert(
  !values["check-scaling"] || values.mode === "allocation",
  "scaling requires allocation mode",
);
assert(values.output, "--output is required");
const turns = parseStrictIntegerOption({
  raw: values.turns,
  label: "--turns",
  fallback: 10,
  min: 1,
});
const chunkSize = parseStrictIntegerOption({
  raw: values.chunk,
  label: "--chunk",
  fallback: 98,
  min: 1,
});
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const filters = assistantVisibleTextFilters("final-answer-delivery", true);
const results = [];
for (const size of [16_384, 65_536, 262_144]) {
  const line = "A plain sentence with a few ordinary words to complete this line.\n";
  const source = '```json\n{"ok":true}\n```\n\n' + line.repeat(Math.ceil(size / line.length));
  const chunks = Array.from({ length: Math.ceil(source.length / chunkSize) }, (_, index) =>
    source.slice(index * chunkSize, (index + 1) * chunkSize),
  );
  const run = () => {
    const projection = createTextProjection(filters);
    let cumulative = "";
    for (const chunk of chunks) {
      cumulative += chunk;
      projection.append(chunk, cumulative);
    }
    assert.equal(projection.text, source.trim());
  };
  for (let warmup = 0; warmup < 3; warmup++) {
    run();
  }
  const inspector = new Session();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let turn = 0; turn < turns; turn++) {
    run();
  }
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  let sampledBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    inspector.disconnect();
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledBytes = sum(profile.head);
    await writeFile(`${output}.${size}.heapprofile`, JSON.stringify(profile));
  }
  results.push({
    sourceCharacters: source.length,
    chunksPerTurn: chunks.length,
    turns,
    elapsedMs,
    cpuMsPerTurn: (used.user + used.system) / 1000 / turns,
    ...(sampledBytes === undefined ? {} : { sampledBytesPerTurn: sampledBytes / turns }),
  });
}
const report = { mode: values.mode, chunkSize, results };
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (values["check-scaling"]) {
  const previous = results.at(-2);
  const current = results.at(-1);
  assert(previous?.sampledBytesPerTurn !== undefined && current?.sampledBytesPerTurn !== undefined);
  const inputGrowth = current.sourceCharacters / previous.sourceCharacters;
  const allocationGrowth = current.sampledBytesPerTurn / previous.sampledBytesPerTurn;
  // Allow twice the input growth for sampling/JIT variation, but reject quadratic copying.
  assert(allocationGrowth <= inputGrowth * 2, `superlinear allocation growth: ${allocationGrowth}`);
}
