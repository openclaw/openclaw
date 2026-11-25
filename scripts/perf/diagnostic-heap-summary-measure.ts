/**
 * Heap-summary owner cost and caller retention on synthetic sampled profile trees.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/diagnostic-heap-summary-measure.ts
 * Save the baseline owner with git show <sha>:src/logging/diagnostic-heap-profile.ts,
 * then pass --owner /absolute/saved-owner.ts. Run A1/B/A2 at least five times.
 * --shape broad supplies a shallow-stack control; --allocations is a separate pass.
 * Acceptance: preserve allocating leaves and their application caller within eight
 * frames / 1 MiB; report timing, CPU and sampled-allocation overhead against A/A.
 * This measures the summary boundary, not Gateway throughput, btrfs or database IO.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { SamplingProfile } from "../../src/logging/diagnostic-heap-profile.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    label: { type: "string", default: "candidate" },
    shape: { type: "string", default: "recursive" },
    contexts: { type: "string" },
    iterations: { type: "string", default: "3" },
    warmups: { type: "string", default: "2" },
    allocations: { type: "boolean", default: false },
  },
});
const contexts = parseStrictIntegerOption({
  raw: values.contexts,
  fallback: values.shape === "broad" ? 9000 : 2048,
  min: 1,
  label: "contexts",
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 3,
  min: 1,
  label: "iterations",
});
const warmups = parseStrictIntegerOption({
  raw: values.warmups,
  fallback: 2,
  min: 0,
  label: "warmups",
});
assert(values.shape === "recursive" || values.shape === "broad", "Unknown fixture shape");
const ownerUrl = new URL("../../src/logging/diagnostic-heap-profile.ts", import.meta.url).href;
const wasReplaced = registerPerfOwnerReplacement(ownerUrl, values.owner);
const { sanitizeDiagnosticHeapProfile } =
  await import("../../src/logging/diagnostic-heap-profile.js");
assert(!values.owner || wasReplaced(), "Requested baseline owner was not loaded");

type Node = SamplingProfile["head"];
let nodeCount = 0;
function node(functionName: string, url = "/synthetic/openclaw/dist/schema.js"): Node {
  return {
    id: ++nodeCount,
    callFrame: { functionName, url, scriptId: "2", lineNumber: 1, columnNumber: 0 },
    selfSize: 0,
    children: [],
  };
}
const profile: SamplingProfile = { head: node("(root)", ""), samples: [] };
// Repeated contexts model a large native tree, while only sixteen code owners
// distinguish the work. No session text, identifiers, paths or real data are used.
for (let context = 0; context < contexts; context++) {
  let parent = profile.head;
  const frames =
    values.shape === "recursive"
      ? [
          `recreateSchemas${context % 16}`,
          ...Array.from({ length: 64 }, (_, index) =>
            index % 2 ? "findChildError" : "findJsonSchemaNodeError",
          ),
          "validateSchemaKeywordShapes",
        ]
      : [`recreateSchemas${context % 16}`, `allocateRows${context}`];
  for (const name of frames) {
    const child = node(name);
    parent.children.push(child);
    parent = child;
  }
  const leaf = node("", "");
  leaf.callFrame.scriptId = "0";
  leaf.callFrame.lineNumber = -1;
  leaf.selfSize = 4096;
  parent.children.push(leaf);
  profile.samples.push({ size: leaf.selfSize, nodeId: leaf.id, ordinal: context + 1 });
}
const metadata = {
  durationMs: 30_000,
  requestedDurationMs: 30_000,
  effectiveDurationMs: 30_000,
  actualDurationMs: 30_000,
  durationLimitReason: null,
  samplingIntervalBytes: 4096,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
  heapUsedBefore: 0,
  heapUsedAfter: 0,
  heapSpacesBefore: [],
  heapSpacesAfter: [],
  rssBefore: 0,
  rssAfter: 0,
};
const inputBytes = Buffer.byteLength(JSON.stringify(profile));
assert(inputBytes > 1024 * 1024, "Fixture must exercise the capped summary");
const run = () => sanitizeDiagnosticHeapProfile(profile, "/synthetic/openclaw", metadata);
for (let warmup = 0; warmup < warmups; warmup++) {
  await run();
}
globalThis.gc?.();
const inspector = new Session();
try {
  if (values.allocations) {
    await startCollectedHeapSampling(inspector, 32_768);
  }
  const hostLoadBefore = loadavg();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  let result = await run();
  for (let iteration = 1; iteration < iterations; iteration++) {
    result = await run();
  }
  const elapsedMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const allocatedBytes = values.allocations
    ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  assert("summary" in result, "Expected capped summary");
  const outputBytes = Buffer.byteLength(JSON.stringify(result));
  assert(outputBytes <= 1024 * 1024);
  assert(result.summary.every((entry) => entry.stack.length <= 8));
  const leaves = result.summary.filter((entry) => entry.stack[0].functionName === "[native]");
  const attributed = leaves.filter((entry) =>
    entry.stack.some((frame) => frame.functionName.startsWith("recreateSchemas")),
  );
  console.log(
    JSON.stringify({
      label: values.label,
      mode: values.allocations ? "allocation" : "timing",
      shape: values.shape,
      node: process.version,
      contexts,
      nodeCount,
      inputBytes,
      outputBytes,
      summaryRows: result.summary.length,
      nativeLeafRows: leaves.length,
      attributedNativeLeafRows: attributed.length,
      nativeLeafBytes: leaves.reduce((sum, entry) => sum + entry.selfBytes, 0),
      attributedNativeLeafBytes: attributed.reduce((sum, entry) => sum + entry.selfBytes, 0),
      iterations,
      elapsedMsPerCapture: elapsedMs / iterations,
      cpuUsPerCapture: (used.user + used.system) / iterations,
      allocatedBytesPerCapture:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
    }),
  );
} finally {
  inspector.disconnect();
}
