/**
 * Token-pressure owner benchmark: 360 messages, including 120 JSON tool results.
 * Mutable histories model rebuilt envelopes; frozen histories measure identity reuse. Setup and warmup are outside measurements.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/token-pressure-scan-measure.mjs
 * Modes: --mode timing|allocation|counts; --iterations 2000; --frozen.
 * --scanner /absolute/cjk-chars.ts loads a pinned baseline owner without a checkout.
 * Alternate five base/candidate processes per mode; CPU is unprofiled. Allocation
 * includes objects collected by minor/major GC (16 KiB sampling, not retained heap).
 * --max-bytes-per-turn 100000 asserts the mutable-history allocation regression.
 * Report bytes/turn; bytes/min at --turns-per-minute is a workload projection,
 * not measured Gateway traffic. No provider, Gateway or database is started.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
    scanner: { type: "string" },
    frozen: { type: "boolean", default: false },
    "turns-per-minute": { type: "string", default: "120" },
    "max-bytes-per-turn": { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(["timing", "allocation", "counts"].includes(values.mode));
assert(global.gc, "use --expose-gc");
let scans = 0;
let chars = 0;
const scanKey = Symbol.for("openclaw.perf.token-pressure-scan");
Reflect.set(globalThis, scanKey, (length) => {
  scans++;
  chars += length;
});
const ownerUrl = new URL("../../packages/normalization-core/src/cjk-chars.ts", import.meta.url)
  .href;
const hook = registerHooks({
  load(url, context, next) {
    if (url !== ownerUrl || (!values.scanner && values.mode !== "counts")) {
      return next(url, context);
    }
    let source = readFileSync(values.scanner ?? new URL(url), "utf8");
    if (values.mode === "counts") {
      source = source.replace(
        "let tokens = estimateStringChars(text) / charsPerToken;",
        'globalThis[Symbol.for("openclaw.perf.token-pressure-scan")](text.length);\n let tokens = estimateStringChars(text) / charsPerToken;',
      );
    }
    return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  },
});
const { createFreshLlmBoundaryTokenEstimator } =
  await import("../../src/agents/sessions/context-token-pressure.ts");
const { freezeJsonSnapshot } = await import("../../src/shared/immutable-data.ts");
hook.deregister();
const messages = Array.from({ length: 120 }, (_, index) => [
  { role: "user", content: `Inspect result ${index}. 保持证据。`, timestamp: index },
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: `call-${index}`,
        name: "read",
        arguments: { path: `src/file-${index}.ts`, offset: index * 123 },
      },
    ],
    timestamp: index,
  },
  {
    role: "toolResult",
    toolCallId: `call-${index}`,
    toolName: "read",
    isError: false,
    timestamp: index,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          index,
          rows: Array.from({ length: 12 }, (_value, row) => ({
            id: row * 1234567,
            path: `src/file-${index}-${row}.ts`,
            ok: true,
            text: "Evidence 中文 한국어 😀",
            digest: "abcdef0123456789abcdef0123456789",
            values: [12345, 67890, -456],
          })),
        }),
      },
    ],
  },
]).flat();
if (values.frozen) {
  freezeJsonSnapshot(messages);
}
const estimate = createFreshLlmBoundaryTokenEstimator({
  systemPrompt: "Inspect the repository. ".repeat(100),
});
const request = { messages, prompt: "Inspect the next result." };
const coldBefore = scans;
const expected = 123002;
assert.equal(estimate(request), expected);
const coldScans = scans - coldBefore;
for (let i = 0; i < 20; i++) {
  assert.equal(estimate(request), expected);
}
scans = 0;
chars = 0;
global.gc();
const inspector = values.mode === "allocation" ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const memoryBefore = process.memoryUsage();
const started = performance.now();
const cpuBefore = process.cpuUsage();
let checksum = 0;
for (let i = 0; i < iterations; i++) {
  checksum += estimate(request);
}
const cpu = process.cpuUsage(cpuBefore);
const wallMs = performance.now() - started;
const memoryAfter = process.memoryUsage();
assert.equal(checksum, expected * iterations);
let allocatedBytes;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocatedBytes = sumSampledHeapBytes(profile.head);
  inspector.disconnect();
}
const bytesPerTurn = allocatedBytes === undefined ? undefined : allocatedBytes / iterations;
console.log(
  JSON.stringify({
    mode: values.mode,
    frozen: values.frozen,
    iterations,
    messages: messages.length,
    expected,
    checksum,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    cpuMsPerTurn: (cpu.user + cpu.system) / 1000 / iterations,
    bytesPerTurn,
    projectedMiBPerMinute:
      bytesPerTurn === undefined
        ? undefined
        : (bytesPerTurn * Number(values["turns-per-minute"])) / 1048576,
    coldScans: values.mode === "counts" ? coldScans : undefined,
    warmScansPerTurn: values.mode === "counts" ? scans / iterations : undefined,
    warmCharsPerTurn: values.mode === "counts" ? chars / iterations : undefined,
    hostLoad,
    memoryBefore,
    memoryAfter,
  }),
);
if (values["max-bytes-per-turn"]) {
  assert(bytesPerTurn !== undefined, "allocation budget requires --mode allocation");
  assert(
    bytesPerTurn < Number(values["max-bytes-per-turn"]),
    `allocated ${bytesPerTurn} bytes/turn`,
  );
}
