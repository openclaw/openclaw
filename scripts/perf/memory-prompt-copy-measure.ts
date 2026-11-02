/**
 * Memory prompt owner costs: 40 synthetic plugins with 25 tools each, two memory
 * supplements and two async preparations. No Gateway or external I/O is used.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/memory-prompt-copy-measure.ts \
 *   --mode timing --iterations 3000 --owner-file .local/base-memory-state.ts
 * Omit --owner-file for current source. Alternate five base/candidate timing
 * pairs, then five separate allocation pairs; traced CPU is diagnostic only.
 * Counts mode --expect-copies 1 is the regression (base copies three arrays).
 * Acceptance: identical output, two fewer copying sorts, lower allocation and
 * non-adverse untraced CPU. This measures owner cost, not whole-Gateway latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string" },
    "expect-copies": { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(["timing", "allocation", "counts"].includes(values.mode));
const expectedCopies =
  values["expect-copies"] === undefined ? undefined : Number(values["expect-copies"]);
assert(
  expectedCopies === undefined ||
    (values.mode === "counts" && Number.isSafeInteger(expectedCopies) && expectedCopies >= 0),
);
const ownerUrl = new URL("../../src/plugins/memory-state.ts", import.meta.url).href;
let loaded = false;
const hooks = registerHooks({
  load(url, context, next) {
    if (url !== ownerUrl) {
      return next(url, context);
    }
    loaded = true;
    return {
      format: "module",
      source: stripTypeScriptTypes(readFileSync(values["owner-file"] ?? new URL(url), "utf8")),
      shortCircuit: true,
    };
  },
});
const memory = await import("../../src/plugins/memory-state.js");
hooks.deregister();
assert(loaded, "selected owner must load");
memory.registerMemoryCapability("synthetic-memory", { promptBuilder: () => ["## Memory"] });
memory.registerMemoryPromptSupplement("zeta", () => ["zeta guidance"]);
memory.registerMemoryPromptSupplement("beta", () => ["beta guidance"]);
memory.registerMemoryPromptPreparation("gamma", async () => ["gamma recall"]);
memory.registerMemoryPromptPreparation("alpha", async () => ["alpha recall"]);
const toolNames = Array.from(
  { length: 1000 },
  (_, i) => `plugin_${39 - Math.floor(i / 25)}_tool_${24 - (i % 25)}`,
);
const params = {
  availableTools: new Set(toolNames),
  agentId: "synthetic-agent",
  agentSessionKey: "agent:synthetic-agent:main",
};
const expectedLines = [
  "## Memory",
  "alpha recall",
  "beta guidance",
  "gamma recall",
  "zeta guidance",
];
const expectedTools = toolNames.toSorted();
let output = await memory.prepareMemoryPromptSection(params);
async function run(count: number) {
  for (let i = 0; i < count; i++) {
    output = await memory.prepareMemoryPromptSection(params);
  }
}
await run(500);
global.gc?.();
const inspector = new Session();
let allocatedBytes: number | undefined;
let copies = 0;
let copiedElements = 0;
const originalSort = Array.prototype.toSorted;
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
try {
  if (values.mode === "counts") {
    // oxlint-disable-next-line no-extend-native -- Count copying sorts in a separate pass; restore in finally.
    Array.prototype.toSorted = function <T>(this: T[], compare?: (a: T, b: T) => number): T[] {
      copies++;
      copiedElements += this.length;
      return originalSort.call(this, compare);
    };
  }
  const hostLoad = loadavg();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  await run(iterations);
  const wallMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
  }
  assert.deepEqual(output.context.availableTools, expectedTools);
  assert.deepEqual(memory.buildMemoryPromptSection(params, output), expectedLines);
  assert.deepEqual([...params.availableTools], toolNames);
  if (expectedCopies !== undefined) {
    assert.equal(copies / iterations, expectedCopies, "copying sorts per preparation");
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      iterations,
      mainThreadCpuMs: (used.user + used.system) / 1000,
      wallMs,
      allocatedBytes,
      bytesPerOperation: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      copiesPerOperation: values.mode === "counts" ? copies / iterations : undefined,
      copiedElementsPerOperation:
        values.mode === "counts" ? copiedElements / iterations : undefined,
      outputSha256: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
      hostLoad,
      memory: process.memoryUsage(),
    }),
  );
} finally {
  // oxlint-disable-next-line no-extend-native -- Restore the original after counts instrumentation.
  Array.prototype.toSorted = originalSort;
  if (values.mode === "allocation") {
    inspector.disconnect();
  }
  memory.clearMemoryPluginState();
}
