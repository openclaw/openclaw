// Measure the private ingress adapter, with already-admitted synthetic upstream facts.
// node --expose-gc scripts/perf/channel-run-admission-measure.mjs OWNER.ts timing|allocation
// Save each revision's owner; run five alternating pairs per mode (5,000 admissions/arm).
// Acceptance: identical facts/callback behavior, fewer freezes, lower CPU or allocation.
// Upstream authentication, audit persistence, and complete Gateway turns are excluded.
// The adapter has constant-size inputs; session/plugin/client counts do not enter it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";

const [file, mode] = process.argv.slice(2);
assert(file && ["timing", "allocation"].includes(mode));
assert(global.gc, "Use --expose-gc");
const source = fs.readFileSync(file, "utf8");
const start = source.indexOf("function consumeChannelRunAdmission(");
const end = source.indexOf("/** Defer evidence consumption", start);
assert(start >= 0 && end > start, "Locate the actual private adapter");
const adapter = stripTypeScriptTypes(source.slice(start, end));
const invoker = Object.freeze({ state: "present", kind: "person" });
const gatewayFacts = Object.freeze({ ingress: { state: "present" }, invoker });
const channelFacts = Object.freeze({
  ingressState: "present",
  invoker,
  assuranceRef: "channel-admission",
  decisionCoverage: "evaluated",
  identifierAuthentication: "affected",
});
let decisions = 0;
const dependencies = {
  readGatewayLocalUserIngressFacts: (ingress) => (ingress ? gatewayFacts : undefined),
  consumeChannelAdmissionEvidence: () => channelFacts,
  recordChannelAdmissionDecision: () => decisions++,
};
const consume = vm.runInNewContext(`(${adapter})`, dependencies);
let freezes = 0;
const counted = vm.runInNewContext(`(${adapter})`, {
  ...dependencies,
  Object: {
    freeze: (value) => {
      freezes++;
      return Object.freeze(value);
    },
  },
});
for (const gateway of [false, true]) {
  const result = counted(undefined, gateway);
  assert.equal(result.ingressState, "present");
  assert.equal(result.facts.invoker, invoker);
  result.onAdmitted({
    executionIdentityToken: { contextId: "test", executionId: "test", runId: "test", createdAt: 1 },
  });
}
assert.equal(decisions, 1);
let checksum = 0;
function work() {
  for (let i = 0; i < 5000; i++) {
    const result = consume(undefined, i % 2);
    checksum += result.ingressState.length + result.facts.invoker.kind.length;
  }
}
for (let i = 0; i < 10; i++) {
  work();
}
global.gc();
await setImmediate();
let gcMs = 0;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcMs += entry.duration;
  }
});
observer.observe({ entryTypes: ["gc"] });
const session = new Session();
if (mode === "allocation") {
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const cpuStart = process.threadCpuUsage();
const wallStart = performance.now();
work();
const wallMs = performance.now() - wallStart;
const cpu = process.threadCpuUsage(cpuStart);
let allocatedBytes;
if (mode === "allocation") {
  const { profile } = await session.post("HeapProfiler.stopSampling");
  const sum = (node) =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  session.disconnect();
}
await setImmediate();
observer.disconnect();
assert.equal(checksum, 5000 * 11 * 13);
console.log(
  JSON.stringify({
    sourceHash: createHash("sha256").update(source).digest("hex"),
    mode,
    operations: 5000,
    freezesPerTwoAdmissions: freezes,
    wallMs,
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    allocatedBytes,
    gcMs,
    hostLoad: os.loadavg(),
    ...process.memoryUsage(),
  }),
);
