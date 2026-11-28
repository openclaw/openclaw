// node --expose-gc scripts/perf/provider-prompt-worker-bytes-measure.mjs OWNER.ts timing|allocation
// Save both revisions' owners and run five alternating AB/BA pairs per mode.
// Each arm warms 300 calls, then measures 3,000 on 512 messages + 40 tool schemas.
// Accept identical byte estimates/eligibility and lower CPU or allocation without
// a controlled regression. This isolates admission scanning, not whole Gateway turns.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { isProxy } from "node:util/types";
import { compileFunction } from "node:vm";

const [file, mode] = process.argv.slice(2);
assert(file && ["timing", "allocation"].includes(mode));
assert(global.gc, "Use --expose-gc");
const source = readFileSync(file, "utf8");
const start = source.indexOf("function providerPromptWorkerBytes(");
const end = source.indexOf("/** Captures the final provider request identity", start);
assert(start >= 0 && end > start, "Locate the private admission scanner");
// Compile the exact private owner in this realm, preserving prototype checks.
const scan = compileFunction(
  `${stripTypeScriptTypes(source.slice(start, end))}\nreturn providerPromptWorkerBytes;`,
  ["isProxy"],
)(isProxy);
const payload = {
  model: "synthetic-model",
  messages: Array.from({ length: 512 }, (_, index) => ({
    role: index % 2 ? "tool" : "user",
    content: [{ type: "text", text: "Synthetic prompt 🦞 ".repeat(100) }],
  })),
  tools: Array.from({ length: 40 }, (_, index) => ({
    name: `tool_${index}`,
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "Synthetic tool input" } },
      required: ["command"],
    },
  })),
};
const inputBytes = scan(payload);
assert.equal(typeof inputBytes, "number");
for (let i = 0; i < 300; i++) {
  assert.equal(scan(payload), inputBytes);
}
global.gc();
await setImmediate();
await setImmediate();
const gc = [];
let started = Infinity;
let finished = Infinity;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.startTime >= started && entry.startTime < finished) {
      gc.push({ kind: entry.detail.kind, ms: entry.duration });
    }
  }
});
observer.observe({ entryTypes: ["gc"] });
const session = mode === "allocation" ? new Session() : undefined;
if (session) {
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const cpuStart = process.threadCpuUsage();
started = performance.now();
let checksum = 0;
for (let i = 0; i < 3000; i++) {
  checksum += scan(payload);
}
finished = performance.now();
const cpu = process.threadCpuUsage(cpuStart);
let allocatedBytes;
if (session) {
  const { profile } = await session.post("HeapProfiler.stopSampling");
  const sum = (node) => node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
  allocatedBytes = sum(profile.head);
  session.disconnect();
}
await setImmediate();
await setImmediate();
observer.disconnect();
assert.equal(checksum, inputBytes * 3000);
console.log(
  JSON.stringify({
    sourceHash: createHash("sha256").update(source).digest("hex"),
    node: process.version,
    mode,
    iterations: 3000,
    inputBytes,
    wallMs: finished - started,
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    allocatedBytes,
    gc,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    ...process.memoryUsage(),
  }),
);
