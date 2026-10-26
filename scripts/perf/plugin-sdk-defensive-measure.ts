// Owner microbenchmark; run unchanged on base and candidate, alternating their order:
// node --import ./scripts/tsx.mjs scripts/perf/plugin-sdk-defensive-measure.ts --workload gemini
// Workloads: gemini, deepseek, replay. --iterations 2000 is the total over five batches.
// Append --allocations for a separate sampled allocation pass (its timing is diagnostic).
// --provider-module /absolute/path.ts and --replay-module /absolute/path.ts select saved owners.
// Accept lower allocation/CPU with identical diagnostics and replay ownership. This measures
// SDK owners with 60 tools/12 nested fields or two replay keys, not whole-Gateway performance.
// Replay storage is intentionally mocked; only claim-handle construction/release is measured.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import type { ProviderNormalizeToolSchemasContext } from "../../src/plugin-sdk/plugin-entry.js";

const { values } = parseArgs({
  options: {
    workload: { type: "string", default: "gemini" },
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean", default: false },
    "provider-module": { type: "string" },
    "replay-module": { type: "string" },
  },
});
const {
  inspectDeepSeekToolSchemas,
  inspectGeminiToolSchemas,
}: typeof import("../../src/plugin-sdk/provider-tools.js") = await import(
  values["provider-module"]
    ? pathToFileURL(values["provider-module"]).href
    : "../../src/plugin-sdk/provider-tools.js"
);
const {
  createChannelReplayGuardWithDedupe,
}: typeof import("../../src/plugin-sdk/channel-replay-guard.js") = await import(
  values["replay-module"]
    ? pathToFileURL(values["replay-module"]).href
    : "../../src/plugin-sdk/channel-replay-guard.js"
);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations >= 5 && iterations % 5 === 0);
assert(["gemini", "deepseek", "replay"].includes(values.workload));
const context: ProviderNormalizeToolSchemasContext = {
  provider: values.workload,
  tools: Array.from({ length: 60 }, (_, index) => ({
    name: `synthetic_tool_${index}`,
    label: `Synthetic tool ${index}`,
    description: "Synthetic provider tool schema",
    parameters: Type.Object(
      Object.fromEntries(
        Array.from({ length: 12 }, (_field, field) => [
          `field_${field}`,
          Type.Object({ value: Type.Union([Type.String({ pattern: "^value" }), Type.Null()]) }),
        ]),
      ),
    ),
    execute: async () => ({ content: [], details: {} }),
  })),
};
const guard = createChannelReplayGuardWithDedupe(
  { buildReplayKey: (keys: string[]) => keys },
  {
    claim: async () => ({ kind: "claimed" }),
    commit: async () => true,
    release: () => {},
    hasRecent: async () => false,
    forget: async () => true,
    warmup: async () => 0,
    clearMemory: () => {},
    memorySize: () => 0,
  },
);
const keys = ["synthetic-message", "synthetic-delivery"];
const inspect =
  values.workload === "gemini" ? inspectGeminiToolSchemas : inspectDeepSeekToolSchemas;
const expected = inspect(context);
assert.equal(expected.length, 60);
assert(expected.every((diagnostic) => diagnostic.violations.length === 12));
const diagnosticsSha256 = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
let checksum = 0;
async function run(count: number) {
  for (let iteration = 0; iteration < count; iteration++) {
    if (values.workload === "replay") {
      const result = await guard.claim(keys);
      assert(result.kind === "claimed");
      assert(Object.isFrozen(result.handle.keys));
      assert.equal(result.handle.keys[0], keys[0]);
      assert.equal(result.handle.keys[1], keys[1]);
      checksum += result.handle.keys.length;
      result.handle.release();
    } else {
      const diagnostics = inspect(context);
      for (const diagnostic of diagnostics) {
        checksum += diagnostic.violations.length;
      }
    }
  }
}
await run(100);
checksum = 0;
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const batches = [];
for (let batch = 0; batch < 5; batch++) {
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  await run(iterations / 5);
  const wallMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  batches.push({
    iterations: iterations / 5,
    wallMs,
    threadCpuMs: (used.user + used.system) / 1000,
  });
}
let allocatedBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  inspector.disconnect();
}
assert.equal(checksum, iterations * (values.workload === "replay" ? 2 : 720));
assert.equal(
  createHash("sha256")
    .update(JSON.stringify(inspect(context)))
    .digest("hex"),
  diagnosticsSha256,
);
console.log(
  JSON.stringify({
    workload: values.workload,
    iterations,
    warmup: 100,
    allocations: values.allocations,
    batches,
    allocatedBytes,
    checksum,
    diagnosticsSha256,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    memory: process.memoryUsage(),
  }),
);
