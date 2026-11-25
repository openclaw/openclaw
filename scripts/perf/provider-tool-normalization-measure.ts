/**
 * Frozen, unpublished tool-schema reuse at the native OpenAI provider hook.
 * Run each revision with node --expose-gc --import ./scripts/tsx.mjs
 * scripts/perf/provider-tool-normalization-measure.ts --mode cpu (or allocation).
 * Defaults: 100 tools, 2,000 requests/sample, five samples. --mutable is a control.
 * Counterbalance base/candidate launch order; compare CPU and allocation separately.
 * This measures the schema owner, not Gateway or provider latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { AnyAgentTool } from "../../src/agents/agent-tools.types.js";
import { normalizeOpenAIToolSchemas } from "../../src/plugin-sdk/provider-tools.js";
import { freezeJsonSnapshot } from "../../src/shared/immutable-data.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    tools: { type: "string", default: "100" },
    iterations: { type: "string", default: "2000" },
    samples: { type: "string", default: "5" },
    mode: { type: "string", default: "cpu" },
    mutable: { type: "boolean", default: false },
  },
});
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const toolCount = integer(values.tools, "tools");
const iterations = integer(values.iterations, "iterations");
const samples = integer(values.samples, "samples");
assert.ok(values.mode === "cpu" || values.mode === "allocation");
const collect = globalThis.gc;
assert.ok(collect, "Run with --expose-gc");
const tools: AnyAgentTool[] = Array.from({ length: toolCount }, (_, index) => {
  const parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "Search synthetic records" },
      options: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100 },
          filter: { type: "object" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
    required: ["query"],
  };
  return {
    name: `search_${index}`,
    label: "Search",
    description: `Search collection ${index}`,
    parameters: values.mutable ? parameters : freezeJsonSnapshot(parameters),
    execute: async () => ({ content: [], details: {} }),
  };
});
const context = { provider: "openai", modelApi: "openai-responses", tools };
const run = () => normalizeOpenAIToolSchemas(context);
const golden = JSON.stringify(run());
for (let warm = 0; warm < 100; warm++) {
  run();
}
let sourceEnumerations = 0;
const sources = new Set(tools.map((tool) => tool.parameters));
const originalEntries = Object.entries;
Object.entries = new Proxy(originalEntries, {
  apply(target, receiver: unknown, args: Parameters<typeof Object.entries>) {
    if (sources.has(args[0])) {
      sourceEnumerations++;
    }
    return Reflect.apply(target, receiver, args);
  },
});
try {
  run();
} finally {
  Object.entries = originalEntries;
}
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + sampledBytes(child), 0);
}
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
}
const measurements = [];
try {
  for (let sample = 0; sample < samples; sample++) {
    collect();
    const hostLoad = loadavg();
    if (values.mode === "allocation") {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpu = process.cpuUsage();
    const start = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) {
      run();
    }
    const wallMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const profile =
      values.mode === "allocation"
        ? (await inspector.post("HeapProfiler.stopSampling")).profile
        : undefined;
    measurements.push({
      sample,
      hostLoad,
      ...(profile
        ? { sampledBytesPerRequest: sampledBytes(profile.head) / iterations }
        : { cpuMsPerRequest: (used.user + used.system) / 1000 / iterations }),
      wallMsPerRequest: wallMs / iterations,
    });
  }
} finally {
  if (values.mode === "allocation") {
    inspector.disconnect();
  }
}
assert.equal(JSON.stringify(run()), golden);
console.log(
  JSON.stringify({
    node: process.version,
    mode: values.mode,
    mutable: values.mutable,
    toolCount,
    iterations,
    samples,
    sourceEnumerationsPerRequest: sourceEnumerations,
    providerJsonSha256: createHash("sha256").update(golden).digest("hex"),
    measurements,
  }),
);
