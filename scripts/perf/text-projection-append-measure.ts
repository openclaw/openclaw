/**
 * Stream long answers through the production visible-text filters in 98-character chunks.
 * A JSON fence activates the tool-call checkpoint before ordinary newline-delimited prose.
 * Run the same command on base and candidate; allocation sampling includes collected objects.
 *
 * node --import ./scripts/tsx.mjs scripts/perf/text-projection-append-measure.ts \
 *   --mode timing --output .local/text-projection-timing.json
 * Repeat with --mode allocation --check-scaling (separate from timing); optional --turns 10 --chunk 98.
 * Use --workload reasoning to measure four successive 50-delta windows of a 22k-character
 * answer with repeated code fences and reasoning tags. Allocation per delta should remain
 * flat across windows. Compare the same script on base and candidate; use --turns 3 for
 * this workload. Correctness and delta replay run separately, outside measured windows.
 * This owner measurement supplements, not replaces, a matched Gateway load test.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../../src/agents/embedded-agent-utils.js";
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
    workload: { type: "string", default: "append" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation", "invalid --mode");
assert(
  !values["check-scaling"] || values.mode === "allocation",
  "scaling requires allocation mode",
);
assert(values.output, "--output is required");
assert(values.workload === "append" || values.workload === "reasoning", "invalid --workload");
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
if (values.workload === "reasoning") {
  const workloads = [];
  for (const [name, block] of [
    ["literal", "```text\n<think>literal code</think>\n```\nOrdinary prose follows.\n\n"],
    ["hidden", '<think>hidden</think>\n```json\n{"ok":true}\n```\nOrdinary prose follows.\n\n'],
  ] as const) {
    const source = `<final>${block.repeat(Math.ceil(22_000 / block.length))}</final>`;
    const chunks = Array.from({ length: Math.ceil(source.length / chunkSize) }, (_, index) =>
      source.slice(index * chunkSize, (index + 1) * chunkSize),
    );
    assert(chunks.length >= 200, "reasoning workload requires at least 200 deltas");
    const chunkWindows = Array.from({ length: 4 }, (_, window) =>
      chunks.slice(window * 50, (window + 1) * 50),
    );
    const oracle = chunks.map((_, index) =>
      sanitizeAssistantVisibleStreamText(source.slice(0, (index + 1) * chunkSize), "final_answer"),
    );
    for (let warmup = 0; warmup < 3; warmup++) {
      const projection = createAssistantVisibleStreamText("final_answer");
      let delivered = "";
      for (const [index, chunk] of chunks.entries()) {
        const result = projection.append(chunk);
        delivered = result.delta === null ? result.text : delivered + result.delta;
        assert.equal(result.text, oracle[index]);
        assert.equal(delivered, oracle[index]);
      }
    }
    const windows = [];
    const inspector = new Session();
    if (values.mode === "allocation") {
      inspector.connect();
    }
    for (let turn = 0; turn < turns; turn++) {
      const projection = createAssistantVisibleStreamText("final_answer");
      for (const [window, windowChunks] of chunkWindows.entries()) {
        if (values.mode === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const cpu = process.cpuUsage();
        const started = performance.now();
        for (const chunk of windowChunks) {
          projection.append(chunk);
        }
        const elapsedMs = performance.now() - started;
        const used = process.cpuUsage(cpu);
        let sampledBytes: number | undefined;
        if (values.mode === "allocation") {
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
            node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
          sampledBytes = sum(profile.head);
        }
        assert.equal(projection.text, oracle[(window + 1) * 50 - 1]);
        windows.push({
          turn,
          window,
          deltas: 50,
          throughCharacters: (window + 1) * 50 * chunkSize,
          elapsedMs,
          cpuMsPerDelta: (used.user + used.system) / 1000 / 50,
          ...(sampledBytes === undefined ? {} : { sampledBytesPerDelta: sampledBytes / 50 }),
        });
      }
    }
    if (values.mode === "allocation") {
      inspector.disconnect();
    }
    workloads.push({ name, sourceCharacters: source.length, windows });
  }
  const report = { mode: values.mode, workload: values.workload, chunkSize, turns, workloads };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  if (values["check-scaling"]) {
    for (const workload of workloads) {
      const bytes = (window: number) =>
        workload.windows
          .filter((sample) => sample.window === window)
          .reduce((sum, sample) => sum + (sample.sampledBytesPerDelta ?? 0), 0) / turns;
      assert(
        bytes(0) > 0 && bytes(3) <= bytes(0) * 2,
        `${workload.name}: growing allocation/delta`,
      );
    }
  }
  process.exit(0);
}
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
