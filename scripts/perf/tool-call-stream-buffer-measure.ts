/**
 * Buffered stream-event owner benchmark (40 tool names, 4,096 deltas per turn).
 * Run unchanged in each revision, alternating base/candidate order five times:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-call-stream-buffer-measure.ts --mode timing
 * Repeat with --mode allocation; sampler CPU is diagnostic, not timing evidence.
 * --owner accepts a source snapshot with intact relative imports.
 * --kind text|thinking|passthrough|prose|call selects buffered or visible deltas.
 * --compare-owner <base-source> records/replays the same input through both owners.
 * For ordinary/complete-call turns: --turns 2000 --deltas 256 --kind prose (then call).
 * This deletion lane accepts lower CPU/allocation with byte-identical replay.
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
    "compare-owner": { type: "string" },
    turns: { type: "string", default: "16" },
    deltas: { type: "string", default: "4096" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
assert(["text", "thinking", "passthrough", "prose", "call"].includes(values.kind));
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
const passthrough = values.kind === "passthrough" || values.kind === "prose";
const delta = values.kind === "prose" ? "The streamed reply continues with ordinary prose.\n" : "x";
const prefix = '[tool:read_0] {"path":"';
const events: Record<string, unknown>[] = Array.from({ length: deltas }, () => ({
  type: values.kind === "thinking" ? "thinking_delta" : "text_delta",
  contentIndex: values.kind === "thinking" ? 1 : 0,
  delta,
}));
const options = {
  matcher,
  createPromotedToolCallEvents: () => [],
  normalizeTerminalMessage: () => undefined,
};
async function* source() {
  if (!passthrough) {
    yield { type: "text_delta", contentIndex: 0, delta: prefix };
  }
  yield* events;
  if (values.kind === "call") {
    yield {
      type: "text_end",
      contentIndex: 0,
      content: prefix + "x".repeat(deltas) + '"}\nVisible reply',
    };
  }
}
if (values["compare-owner"]) {
  const comparison: typeof owner = await import(
    pathToFileURL(resolve(values["compare-owner"])).href
  );
  const record = async (implementation: typeof owner) => {
    const recording: unknown[] = [];
    for await (const event of implementation.normalizePlainTextToolCallStreamEvents(
      source(),
      options,
    )) {
      recording.push(structuredClone(event));
    }
    return recording;
  };
  assert.deepEqual(await record(owner), await record(comparison));
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
      if (passthrough) {
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
    assert.equal(
      text,
      passthrough ? delta.repeat(deltas) : values.kind === "call" ? "Visible reply" : "",
    );
    outputUnits += text.length + thinking.length;
  }
  assert(events.every((event) => event.delta === delta));
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
    inputEvents: turns * (deltas + (passthrough ? 0 : values.kind === "call" ? 2 : 1)),
    ...output,
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    sampledBytes,
    elapsedMs,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  }),
);
