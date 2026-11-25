// Owner microbenchmark, not whole-Gateway load: eight interleaved synthetic streams,
// 64 subscribers, small assistant deltas, tool start/result, and lifecycle cleanup.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-event-routing-measure.ts
// --events 20000 [--allocation]. Run CPU and sampled-allocation passes separately.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  withAgentRunLifecycleGeneration,
} from "../../src/infra/agent-events.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../src/infra/agent-run-registry.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    events: { type: "string", default: "20000" },
    allocation: { type: "boolean", default: false },
  },
});
const events = parseStrictIntegerOption({
  raw: values.events,
  label: "--events",
  min: 1,
  fallback: 20000,
});
const runs = Array.from({ length: 8 }, (_, index) => `synthetic-${index}`);
const assistant = { stream: "assistant", data: { delta: "ok " } };
const start = { stream: "tool", data: { phase: "start", name: "read", toolCallId: "tool" } };
const result = {
  stream: "tool",
  data: { phase: "result", name: "read", toolCallId: "tool", result: "ok" },
};
const inputs = runs.map((runId) =>
  [assistant, start, result].map((event) => ({ runId, stream: event.stream, data: event.data })),
);
const hash = createHash("sha256");
let deliveries = 0;
let capture = true;
resetAgentEventsForTest();
for (let index = 0; index < 64; index++) {
  onAgentRuntimeEvent((event) => {
    deliveries++;
    if (capture && index === 0) {
      hash.update(JSON.stringify({ ...event, ts: 0 }));
    }
  });
}
function batch(count: number) {
  for (let index = 0; index < count; index++) {
    const phase = Math.floor(index / runs.length) % 100;
    emitAgentEvent(inputs[index % runs.length]![phase === 0 ? 1 : phase === 99 ? 2 : 0]!);
  }
}
await withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), async () => {
  for (const runId of runs) {
    registerAgentRunContext(runId, {
      agentId: "main",
      sessionKey: `agent:main:${runId}`,
      sessionId: runId,
      isControlUiVisible: true,
      projectSessionLifecycle: true,
      projectSessionMessages: true,
      verboseLevel: "off",
      registeredAt: 1,
    });
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 1 } });
  }
  batch(2000);
  const goldenHash = hash.digest("hex");
  capture = false;
  deliveries = 0;
  globalThis.gc?.();
  const inspector = new Session();
  if (values.allocation) {
    await startCollectedHeapSampling(inspector, 1024);
  }
  const cpuStart = process.threadCpuUsage();
  const started = performance.now();
  batch(events);
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuStart);
  let allocatedBytes: number | undefined;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = sumSampledHeapBytes(profile.head);
    inspector.disconnect();
  }
  assert.equal(deliveries, events * 64);
  console.log(
    JSON.stringify({
      events,
      deliveries,
      allocation: values.allocation,
      goldenHash,
      elapsedMs,
      cpuUsPerEvent: (cpu.user + cpu.system) / events,
      allocatedBytesPerEvent: allocatedBytes === undefined ? undefined : allocatedBytes / events,
      memory: process.memoryUsage(),
      load: loadavg(),
    }),
  );
  for (const runId of runs) {
    clearAgentRunContext(runId);
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
  }
});
resetAgentEventsForTest();
