import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { recordGatewayWsEvent } from "../../src/gateway/server/ws-connection-diagnostics.js";
import {
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../../src/infra/diagnostic-events.js";

// Run with --expose-gc; sampling includes garbage, not just the retained heap.
const batches = 250;
const frames = 1_000;
const subscribed = { reason: "assistant", delivery: "subscribed" } as const;
const roster = { reason: "assistant", delivery: "roster" } as const;
let delivered = 0;
let histogram = 0;
const unsubscribe = onInternalDiagnosticEvent(
  (event) => {
    if (event.type === "gateway.ws.event") {
      delivered += event.count;
      histogram += event.frameBytes?.["+Inf"] ?? 0;
    }
  },
  { include: ["gateway.ws.event"] },
);
setDiagnosticsEnabledForProcess(true);

async function run(count: number) {
  for (let batch = 0; batch < count; batch++) {
    for (let frame = 0; frame < frames; frame++) {
      const variant = frame % 5;
      const event =
        variant === 0
          ? "chat"
          : variant === 1
            ? "presence"
            : variant === 4
              ? "unknown"
              : "session.message";
      recordGatewayWsEvent(
        event,
        1_024,
        variant === 2 ? subscribed : variant === 3 ? roster : undefined,
        variant === 1 ? "delta" : undefined,
      );
      recordGatewayWsEvent(event, 0, undefined, undefined, 256);
    }
    await yieldImmediate();
    await waitForDiagnosticEventsDrained();
  }
}

const inspector = new Session();
inspector.connect();
async function allocation(count: number) {
  global.gc?.();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4_096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await run(count);
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  let total = 0;
  let owner = 0;
  function visit(node: HeapProfiler.SamplingHeapProfileNode, owned = false) {
    const underOwner = owned || node.callFrame.url.includes("/ws-connection-diagnostics.");
    total += node.selfSize;
    if (underOwner) {
      owner += node.selfSize;
    }
    for (const child of node.children) {
      visit(child, underOwner);
    }
  }
  visit(profile.head);
  return {
    total: total / (count * frames),
    owner: owner / (count * frames),
  };
}

const cold = await allocation(1);
await run(25);
const warm = await allocation(batches);
const start = process.cpuUsage();
const wall = performance.now();
await run(batches);
const cpu = process.cpuUsage(start);
const wallMs = performance.now() - wall;
assert.equal(delivered, (1 + 25 + batches * 2) * frames);
assert.equal(histogram, delivered);
unsubscribe();
const inactiveStart = process.cpuUsage();
for (let frame = 0; frame < batches * frames; frame++) {
  assert.equal(recordGatewayWsEvent("chat", 1_024), false);
}
const inactiveCpu = process.cpuUsage(inactiveStart);
inspector.disconnect();
console.log(
  JSON.stringify({
    coldBytesPerFrame: cold.total,
    coldOwnerBytesPerFrame: cold.owner,
    bytesPerFrame: warm.total,
    ownerBytesPerFrame: warm.owner,
    cpuUsPerFrame: (cpu.user + cpu.system) / (batches * frames),
    wallMs,
    inactiveCpuUsPerFrame: (inactiveCpu.user + inactiveCpu.system) / (batches * frames),
    frames: delivered,
    histogram,
  }),
);
