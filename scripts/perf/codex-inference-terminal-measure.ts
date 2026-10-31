/**
 * Owner comparison: frozen full-parse baseline versus the production terminal detector.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/codex-inference-terminal-measure.ts
 * Add --sample for a separate collected-object allocation pass; timing is untraced.
 * Five counterbalanced samples per arm, 100,000 events each; --iterations overrides this.
 * Synthetic traffic: 94% text deltas, 4% tool argument deltas, 1% full item.done,
 * 0.9% full completed events, and 0.1% Unicode-escaped terminal events.
 * Controls: 256 KiB completed frames (500 events/arm) and Unicode-escaped traffic.
 * Acceptance: identical decisions, zero JSON parses for ordinary deltas, reduced
 * allocation and CPU per event. This measures the owner, not whole-Gateway latency.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { isTerminalResponse } from "../../extensions/codex/src/app-server/inference-dispatch.js";
import { isJsonObject } from "../../extensions/codex/src/app-server/protocol.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "100000" },
    sample: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);

// Frozen pre-optimization detector, including malformed-input behavior.
function baseline(bytes: Buffer): boolean {
  try {
    const event: unknown = JSON.parse(bytes.toString("utf8"));
    return (
      isJsonObject(event) &&
      (event.type === "response.failed" ||
        event.type === "response.incomplete" ||
        (event.type === "response.completed" &&
          isJsonObject(event.response) &&
          typeof event.response.id === "string"))
    );
  } catch {
    return false;
  }
}

const text = "Synthetic assistant output. ".repeat(300);
const frames = [
  JSON.stringify({
    type: "response.output_text.delta",
    item_id: "synthetic-message",
    output_index: 0,
    content_index: 0,
    delta: " ordinary text fragment",
  }),
  JSON.stringify({
    type: "response.function_call_arguments.delta",
    item_id: "synthetic-tool",
    output_index: 0,
    delta: '{"command":"echo \\"synthetic\\""}',
  }),
  JSON.stringify({
    type: "response.output_item.done",
    item: { id: "synthetic", type: "message", content: [{ type: "output_text", text }] },
  }),
  JSON.stringify({
    type: "response.completed",
    response: { id: "synthetic", output: [{ type: "message", content: [{ text }] }] },
  }),
  '{"type":"response.\\u0063ompleted","response":{"id":"synthetic-escaped"}}',
].map((value) => Buffer.from(value));
const corpus = Array.from({ length: 1000 }, (_, index) => {
  const frame = index < 940 ? 0 : index < 980 ? 1 : index < 990 ? 2 : index < 999 ? 3 : 4;
  return frames[frame]!;
});
const edgeCases = [
  '{"type":"response.failed"}',
  '{"type":"response.incomplete"}',
  '{"type":"response.completed"}',
  '{"\\u0074ype":"response.completed","response":{"id":"synthetic"}}',
  '{"type":"response.completed","type":"other","response":{"id":"synthetic"}}',
  '{"type":"other","response":{"type":"response.failed"}}',
  '{"type":"response.failed"} malformed',
  "null",
  "[]",
  '"response.failed"',
].map((value) => Buffer.from(value));
for (const bytes of [...frames, ...edgeCases]) {
  assert.equal(isTerminalResponse(bytes), baseline(bytes));
}

function run(
  detector: (bytes: Buffer) => boolean,
  traffic: readonly Buffer[],
  count: number,
): number {
  let terminalCount = 0;
  for (let index = 0; index < count; index++) {
    terminalCount += Number(detector(traffic[index % traffic.length]!));
  }
  return terminalCount;
}

function countParses(detector: (bytes: Buffer) => boolean, traffic: readonly Buffer[]): number {
  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = (value: string) => {
    parses++;
    return parse(value);
  };
  try {
    run(detector, traffic, traffic.length);
  } finally {
    JSON.parse = parse;
  }
  return parses;
}

function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}

const arms = [
  { name: "base", detect: baseline },
  { name: "candidate", detect: isTerminalResponse },
];
const workloads = [
  { name: "mixed-stream", traffic: corpus, events: iterations },
  {
    name: "large-completed-control",
    traffic: [
      Buffer.from(
        JSON.stringify({
          type: "response.completed",
          response: { id: "synthetic-large", output: [{ text: "x".repeat(256 * 1024) }] },
        }),
      ),
    ],
    events: Math.min(iterations, 500),
  },
  {
    name: "unicode-escaped-control",
    traffic: [
      frames[4]!,
      Buffer.from('{"type":"response.output_text.delta","delta":"\\u0061\\u0062\\u0063"}'),
    ],
    events: iterations,
  },
];
const workCounts = workloads.flatMap(({ name: workload, traffic }) =>
  arms.map(({ name, detect }) => ({
    workload,
    name,
    events: traffic.length,
    jsonParses: countParses(detect, traffic),
  })),
);
const inspector = values.sample ? new Session() : undefined;
inspector?.connect();
const results = [];
try {
  for (const { name: workload, traffic, events } of workloads) {
    for (const bytes of traffic) {
      assert.equal(isTerminalResponse(bytes), baseline(bytes));
    }
    const expectedTerminals = run(baseline, traffic, events);
    for (const { detect } of arms) {
      run(detect, traffic, Math.min(events, 2000));
    }
    for (let sample = 0; sample < 5; sample++) {
      for (const { name, detect } of sample % 2 ? arms.toReversed() : arms) {
        globalThis.gc?.();
        const hostLoadBefore = loadavg();
        if (inspector) {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const cpuBefore = process.cpuUsage();
        const start = performance.now();
        const terminals = run(detect, traffic, events);
        const wallMs = performance.now() - start;
        const cpu = process.cpuUsage(cpuBefore);
        const allocationBytes = inspector
          ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
          : undefined;
        assert.equal(terminals, expectedTerminals);
        results.push({
          sample,
          workload,
          name,
          events,
          terminals,
          wallMs,
          cpuMs: (cpu.user + cpu.system) / 1000,
          cpuUsPerEvent: (cpu.user + cpu.system) / events,
          allocationBytes,
          allocatedBytesPerEvent:
            allocationBytes === undefined ? undefined : allocationBytes / events,
          hostLoadBefore,
          hostLoadAfter: loadavg(),
        });
      }
    }
  }
} finally {
  inspector?.disconnect();
}
console.log(
  JSON.stringify({ mode: values.sample ? "allocation" : "timing", workCounts, results }, null, 2),
);
