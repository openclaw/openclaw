/**
 * Residual tool-schema filter probe. From an installed checkout:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-schema-inspection-measure.ts
 * Options: --tools 100 --iterations 5000 --samples 5 --mode runtime|provider-normalizable
 * --mutable measures uncached input; default uses immutable owner publications.
 * --module <absolute file URL> selects a baseline owner with the same dependencies.
 * CPU is measured without tracing; allocation uses separate inspector sampling passes.
 * Compare counterbalanced base/candidate processes with identical options on the benchmark host.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import * as current from "../../src/agents/tool-schema-projection.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    tools: { type: "string", default: "100" },
    iterations: { type: "string", default: "5000" },
    samples: { type: "string", default: "5" },
    mode: { type: "string", default: "runtime" },
    mutable: { type: "boolean", default: false },
    module: { type: "string" },
  },
});
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const toolCount = integer(values.tools, "tools");
const iterations = integer(values.iterations, "iterations");
const samples = integer(values.samples, "samples");
assert.ok(values.mode === "runtime" || values.mode === "provider-normalizable");
assert.ok(globalThis.gc, "Run with --expose-gc");
const owner: typeof current = values.module ? await import(values.module) : current;
const filter =
  values.mode === "runtime"
    ? owner.filterRuntimeCompatibleTools
    : owner.filterProviderNormalizableTools;
const tools = Array.from({ length: toolCount }, (_, index) => {
  const parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "Synthetic search query" },
      options: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
        additionalProperties: false,
      },
    },
    required: ["query"],
    additionalProperties: false,
  };
  const schema = values.mutable ? parameters : publishRuntimeToolInputSchema(parameters).schema;
  assert.ok(schema !== null && typeof schema === "object");
  return { name: `synthetic_tool_${index}`, parameters: schema };
});
function run() {
  let accepted = 0;
  for (let attempt = 0; attempt < iterations; attempt++) {
    const result = filter(tools);
    accepted += result.tools.length;
    assert.equal(result.diagnostics.length, 0);
  }
  assert.equal(accepted, toolCount * iterations);
}
function bytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
}
run();
const rows = [];
const inspector = new Session();
inspector.connect();
try {
  for (let sample = 0; sample < samples; sample++) {
    globalThis.gc();
    const hostLoad = loadavg();
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    run();
    const wallMs = performance.now() - wallStart;
    const cpu = process.cpuUsage(cpuStart);
    globalThis.gc();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    run();
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    rows.push({
      sample,
      cpuUsPerAttempt: (cpu.user + cpu.system) / iterations,
      wallUsPerAttempt: (wallMs * 1000) / iterations,
      sampledBytesPerAttempt: bytes(profile.head) / iterations,
      hostLoad,
    });
  }
} finally {
  inspector.disconnect();
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      toolCount,
      iterations,
      samples,
      mode: values.mode,
      mutable: values.mutable,
      rows,
    },
    null,
    2,
  ),
);
