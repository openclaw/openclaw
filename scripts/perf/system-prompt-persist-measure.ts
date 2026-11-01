/**
 * Prompt-checkpoint owner benchmark; run each revision and mode in a fresh process:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/system-prompt-persist-measure.ts
 *   --mode timing --case warm --iterations 3000
 * Repeat with --mode allocation and --case restored, alternating revision order.
 * Fixtures/warmup are excluded. Both cases reuse 40 tools with 20 nested fields;
 * warm retains the original mutable tool pin after its first append, while restored
 * retains a frozen, unadmitted pin, as after hydration. Each operation creates a new
 * checkpoint envelope and changes renderedPrefix. Normalization and prefix pooling
 * are measured; durable I/O, JSON encoding, and whole-Gateway performance are not.
 * Allocation sampling includes collected objects; only timing-mode CPU is untraced.
 * afterGc retains one final checkpoint; collection and byte checks are outside timing.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { shareSessionSystemPrompt } from "../../src/agents/sessions/system-prompt-pool.js";
import { normalizeTranscriptJsonValue } from "../../src/config/sessions/transcript-json.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    case: { type: "string", default: "warm" },
    iterations: { type: "string", default: "3000" },
  },
});
const mode = values.mode;
const workload = values.case;
const iterations = Number(values.iterations);
assert(mode === "timing" || mode === "allocation");
assert(workload === "warm" || workload === "restored");
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");

const prefix = "## Synthetic instructions\nKeep every byte, including 🦞 and \ud800.\n"
  .repeat(1200)
  .slice(0, 65536);
// A bounded working set keeps prefix-pool eviction out of this normalization workload.
const renderedPrefixes = Array.from(
  { length: 32 },
  (_, index) => `${prefix}\n## Temporal Context\nSynthetic revision ${index}.`,
);
const tools = Array.from({ length: 40 }, (_, toolIndex) => ({
  name: `synthetic_tool_${toolIndex}`,
  description: `Synthetic tool ${toolIndex}. ` + "Preserve the published instructions. ".repeat(8),
  parameters: {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 20 }, (_field, fieldIndex) => [
        `field_${fieldIndex}`,
        {
          type: "object",
          description: `Synthetic nested field ${fieldIndex}; preserve the declared shape.`,
          properties: {
            value: { type: "string", enum: ["first", "second", "third"] },
            enabled: { type: "boolean" },
          },
          required: ["value"],
        },
      ]),
    ),
    required: ["field_0"],
  },
}));
function freezeFixture(value: unknown): void {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeFixture);
    Object.freeze(value);
  }
}
if (workload === "restored") {
  freezeFixture(tools);
}

function checkpoint(index: number) {
  return {
    type: "custom" as const,
    customType: "openclaw.system-prompt",
    id: `checkpoint-${index}`,
    parentId: index ? `checkpoint-${index - 1}` : null,
    timestamp: "2026-10-01T00:00:00.000Z",
    data: {
      prefix,
      hash: "synthetic-digest",
      renderedPrefix: renderedPrefixes[index % renderedPrefixes.length]!,
      routeKey: "synthetic-route",
      historyId: null,
      permissionNotice: undefined,
      restart: false,
      toolPolicy: "synthetic-policy",
      tools,
    },
  };
}
function persist(index: number) {
  const entry = checkpoint(index);
  // This fixture's mutable plain envelope is preserved by normalization, as in append.
  normalizeTranscriptJsonValue(entry, "");
  return shareSessionSystemPrompt(entry);
}
let checksum = 0;
function run(count: number): void {
  for (let index = 0; index < count; index++) {
    checksum += persist(index).data.renderedPrefix.length;
  }
}
for (const index of [0, 1, 31, 32]) {
  const expected = JSON.stringify(checkpoint(index));
  assert.equal(JSON.stringify(persist(index)), expected);
}
run(200);
global.gc();

const inspector = new Session();
try {
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  const start = performance.now();
  run(iterations);
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  const hostLoadAfter = loadavg();
  const sampledBytes =
    mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
          (sum, sample) => sum + sample.size,
          0,
        )
      : undefined;
  const retained = persist(iterations);
  global.gc();
  global.gc();
  const afterGc = process.memoryUsage();
  assert.equal(JSON.stringify(retained), JSON.stringify(checkpoint(iterations)));
  console.log(
    JSON.stringify({
      mode,
      workload,
      iterations,
      tools: tools.length,
      fieldsPerTool: 20,
      prefixCharacters: prefix.length,
      node: process.version,
      hostLoadBefore,
      hostLoadAfter,
      wallMs,
      cpuMs: (used.user + used.system) / 1000,
      cpuMicrosecondsPerOperation: (used.user + used.system) / iterations,
      sampledBytes,
      sampledBytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      memory: { before, after, afterGc },
      checksum,
    }),
  );
} finally {
  inspector.disconnect();
}
