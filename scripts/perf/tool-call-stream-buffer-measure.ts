/**
 * Buffered stream-event owner benchmark (40 tool names, 4,096 deltas per turn).
 * Run unchanged in each revision, alternating base/candidate order five times:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-call-stream-buffer-measure.ts --mode timing
 * Repeat with --mode allocation; sampler CPU is diagnostic, not timing evidence.
 * --owner accepts a source snapshot with intact relative imports.
 * --kind text|thinking|passthrough selects buffered deltas or unchanged prose.
 * Accept lower allocation/event with stable CPU and identical output. This is
 * an owner microbenchmark, not a Gateway load test; no provider/network/state IO.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { normalizePlainTextToolCallStreamEvents } from "../../packages/tool-call-repair/src/stream-normalizer.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    kind: { type: "string", default: "thinking" },
    owner: { type: "string", default: "packages/tool-call-repair/src/stream-normalizer.ts" },
    turns: { type: "string", default: "16" },
    deltas: { type: "string", default: "4096" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
assert(["text", "thinking", "passthrough"].includes(values.kind));
const count = (label: "turns" | "deltas", fallback: number) =>
  parseStrictIntegerOption({ raw: values[label], fallback, min: 1, label });
const turns = count("turns", 16);
const deltas = count("deltas", 4096);
const owner: {
  normalizePlainTextToolCallStreamEvents: typeof normalizePlainTextToolCallStreamEvents;
} = await import(pathToFileURL(resolve(values.owner)).href);
const names = Array.from({ length: 40 }, (_, index) => `read_${index}`);
const matcher = {
  hasExactName: (name: string) => names.includes(name),
  hasNamePrefix: (prefix: string) => names.some((name) => name.startsWith(prefix)),
};
const prefix = '[tool:read_0] {"path":"';
const events: Record<string, unknown>[] = Array.from({ length: deltas }, () => ({
  type: values.kind === "thinking" ? "thinking_delta" : "text_delta",
  contentIndex: values.kind === "thinking" ? 1 : 0,
  delta: "x",
}));
const options = {
  matcher,
  createPromotedToolCallEvents: () => [],
  normalizeTerminalMessage: () => undefined,
};
async function* source() {
  if (values.kind !== "passthrough") {
    yield { type: "text_delta", contentIndex: 0, delta: prefix };
  }
  yield* events;
}
async function run(turnCount: number) {
  let outputEvents = 0;
  let outputUnits = 0;
  for (let turn = 0; turn < turnCount; turn++) {
    let text = "";
    let thinking = "";
    let eventIndex = 0;
    for await (const event of owner.normalizePlainTextToolCallStreamEvents(source(), options)) {
      assert(event && typeof event === "object" && "type" in event && "delta" in event);
      assert(typeof event.delta === "string");
      if (values.kind === "passthrough") {
        assert.equal(event, events[eventIndex++]);
      }
      if (event.type === "thinking_delta") {
        thinking += event.delta;
      } else {
        text += event.delta;
      }
      outputEvents++;
    }
    assert.equal(thinking, values.kind === "thinking" ? "x".repeat(deltas) : "");
    assert.equal(text, values.kind === "passthrough" ? "x".repeat(deltas) : "");
    outputUnits += text.length + thinking.length;
  }
  assert(events.every((event) => event.delta === "x"));
  return { outputEvents, outputUnits };
}
await run(2);
globalThis.gc?.();
const inspector = values.mode === "allocation" ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const started = performance.now();
const threadStart = process.threadCpuUsage();
const output = await run(turns);
const cpu = process.threadCpuUsage(threadStart);
const elapsedMs = performance.now() - started;
let sampledBytes: number | undefined;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    mode: values.mode,
    kind: values.kind,
    owner: values.owner,
    turns,
    deltas,
    inputEvents: turns * (deltas + (values.kind === "passthrough" ? 0 : 1)),
    ...output,
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    sampledBytes,
    elapsedMs,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  }),
);
