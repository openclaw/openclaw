// Run on a benchmark host with --expose-gc and --import ./scripts/tsx.mjs.
// Compare separate processes, alternating --owner base/head, for each mode/content pair.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import { normalizeTranscriptJsonValue } from "../../src/config/sessions/transcript-json.js";
import type { Message } from "../../src/llm/types.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    mode: { type: "string", default: "sealed" },
    content: { type: "string", default: "blocks" },
    measure: { type: "string", default: "retained" },
    count: { type: "string", default: "1000" },
    passes: { type: "string", default: "100" },
    output: { type: "string" },
    "start-at": { type: "string", default: "0" },
  },
});
assert.ok(["sealed", "append", "mutable"].includes(values.mode));
assert.ok(["string", "blocks"].includes(values.content));
assert.ok(["retained", "cpu", "counts", "allocation", "snapshot"].includes(values.measure));
const count = Number(values.count);
const passes = Number(values.passes);
assert.ok(Number.isSafeInteger(count) && count > 0);
assert.ok(Number.isSafeInteger(passes) && passes > 0);
assert.ok(global.gc, "Pass --expose-gc");

// Keep counting instrumentation out of CPU, GC, and retained-memory measurements.
const originalHash = crypto.hash;
let hashes = 0;
let bytes = 0;
if (values.measure === "counts") {
  crypto.hash = new Proxy(originalHash, {
    apply(target, receiver, args: Parameters<typeof crypto.hash>) {
      const data = args[1];
      hashes++;
      bytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
      return Reflect.apply(target, receiver, args);
    },
  });
  syncBuiltinESMExports();
}
const {
  fingerprintMessage,
}: typeof import("../../src/agents/embedded-agent-runner/prompt-cache-history.js") = await import(
  values.owner
    ? pathToFileURL(values.owner).href
    : "../../src/agents/embedded-agent-runner/prompt-cache-history.js"
);

function fixture(index: number): Message {
  const text = `Synthetic reasoning ${index}: ${"text ".repeat(800)}`;
  const message: Message =
    values.content === "string"
      ? { role: "user", content: text, timestamp: index }
      : {
          role: "assistant",
          api: "openai-responses",
          provider: "openai",
          model: "fixture-model",
          content: [
            { type: "text", text },
            { type: "thinking", thinking: `Synthetic thought ${index}: ${"think ".repeat(400)}` },
            {
              type: "toolCall",
              id: `call-${index}`,
              name: "exec",
              arguments: {
                command: `printf fixture-${index}`,
                options: {
                  items: Array.from({ length: 32 }, (_, item) => ({ item, text: "x".repeat(256) })),
                },
              },
            },
          ],
          usage: {
            input: 10_000,
            output: 100,
            cacheRead: 9_000,
            cacheWrite: 0,
            totalTokens: 10_100,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: index,
        };
  if (values.mode === "append") {
    normalizeTranscriptJsonValue(message, "");
  } else if (values.mode === "sealed") {
    normalizeTranscriptJsonValue({ message }, "");
  }
  return message;
}

type Fingerprint = ReturnType<typeof fingerprintMessage>;
function observe(messages: Message[], previous: Fingerprint[] = []): Fingerprint[] {
  return messages.map((message, index) => fingerprintMessage(message, previous[index]));
}
async function collect() {
  // WeakRef targets stay alive until the end of the current job.
  await setImmediate();
  global.gc!();
  await setImmediate();
  global.gc!();
}
function warm() {
  const messages = Array.from({ length: 100 }, (_, index) => fixture(index));
  let history = observe(messages);
  for (let pass = 0; pass < 20; pass++) {
    history = observe(messages, history);
  }
}
warm();
await collect();
const messages = Array.from({ length: count }, (_, index) => fixture(index));
const appended = Array.from({ length: passes }, (_, index) => fixture(count + index));
await collect();
const wait = Number(values["start-at"]) - Date.now();
if (wait > 0) {
  await new Promise((resolve) => {
    setTimeout(resolve, wait);
  });
}
const inspector = values.measure === "allocation" ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
if (values.measure === "snapshot") {
  assert.ok(values.output, "Pass --output path-prefix for snapshots");
  writeHeapSnapshot(`${values.output}.before.heapsnapshot`);
}
const heapBefore = process.memoryUsage().heapUsed;
hashes = 0;
bytes = 0;
const coldCpu = process.cpuUsage();
const coldStarted = performance.now();
let history = observe(messages);
const coldElapsed = performance.now() - coldStarted;
const coldUsed = process.cpuUsage(coldCpu);
const rows = [
  {
    phase: "cold",
    calls: 1,
    fingerprintsPerCall: messages.length,
    hashesPerCall: values.measure === "counts" ? hashes : undefined,
    hashedBytesPerCall: values.measure === "counts" ? bytes : undefined,
    msPerCall: coldElapsed,
    cpuMsPerCall: (coldUsed.user + coldUsed.system) / 1000,
    gc: [] as Array<{ kind: number; ms: number }>,
  },
];
await collect();
const retainedBytes = process.memoryUsage().heapUsed - heapBefore;
if (values.measure === "snapshot") {
  writeHeapSnapshot(`${values.output}.after.heapsnapshot`);
}
if (["cpu", "counts", "allocation"].includes(values.measure)) {
  for (const phase of ["warm", "append"] as const) {
    const workloads =
      phase === "append" ? appended.map((message) => messages.concat(message)) : undefined;
    hashes = 0;
    bytes = 0;
    const gc: Array<{ kind: number; ms: number }> = [];
    let started = 0;
    let finished = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // Forced collections before this loop may be delivered after registration.
        if (entry.startTime < started || entry.startTime >= finished) {
          continue;
        }
        const detail = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
        gc.push({ kind: detail.kind, ms: entry.duration });
      }
    });
    observer.observe({ entryTypes: ["gc"] });
    const cpu = process.cpuUsage();
    started = performance.now();
    for (let pass = 0; pass < passes; pass++) {
      const next = observe(workloads?.[pass] ?? messages, history);
      assert.ok(history.every((fingerprint, index) => fingerprint === next[index]));
      // Each appended pass includes one previously unobserved message.
      if (phase === "warm") {
        history = next;
      }
    }
    finished = performance.now();
    const elapsedMs = finished - started;
    const used = process.cpuUsage(cpu);
    await setImmediate();
    await setImmediate();
    observer.disconnect();
    rows.push({
      phase,
      calls: passes,
      fingerprintsPerCall: messages.length + (phase === "append" ? 1 : 0),
      hashesPerCall: values.measure === "counts" ? hashes / passes : undefined,
      hashedBytesPerCall: values.measure === "counts" ? bytes / passes : undefined,
      msPerCall: elapsedMs / passes,
      cpuMsPerCall: (used.user + used.system) / 1000 / passes,
      gc,
    });
  }
}
if (inspector) {
  assert.ok(values.output, "Pass --output file for allocation profiles");
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  await writeFile(values.output, JSON.stringify(profile));
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    node: process.version,
    mode: values.mode,
    content: values.content,
    measure: values.measure,
    count,
    retainedBytes,
    retainedBytesPerMessage: retainedBytes / count,
    fingerprintDigest: originalHash("sha256", JSON.stringify(history), "hex"),
    rows,
  }),
);
