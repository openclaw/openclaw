// Diagnostic dispatcher owner benchmark (not whole-Gateway latency).
// node --import ./scripts/tsx.mjs scripts/perf/diagnostic-frozen-trace-measure.ts
//   --workload tool|rpc --consumers core|all|none --mode timing|allocation|counts --iterations 5000
// RPCs copy their captured trace for each of four phases; tools reuse one trace
// across start/terminal events. Core models run-activity + audit subscriptions;
// all adds an exporter-shaped subscriber. Payloads are synthetic and bounded.
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import {
  emitTrustedDiagnosticEvent as emit,
  onInternalDiagnosticEvent,
  onTrustedToolExecutionEvent,
  waitForDiagnosticEventsDrained as drain,
  type DiagnosticEventInput,
} from "../../src/infra/diagnostic-events.js";
import { freezeDiagnosticTraceContext } from "../../src/infra/diagnostic-trace-context.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    workload: { type: "string", default: "tool" },
    consumers: { type: "string", default: "core" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "5000" },
  },
});
assert(["tool", "rpc"].includes(values.workload));
assert(["core", "all", "none"].includes(values.consumers));
assert(["timing", "allocation", "counts"].includes(values.mode));
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 5000,
  min: 1,
  label: "iterations",
});
let deliveries = 0;
let clones = 0;
if (values.consumers !== "none") {
  onInternalDiagnosticEvent(() => deliveries++, {
    include: ["tool.execution.started", "tool.execution.completed"],
  });
  onTrustedToolExecutionEvent(() => deliveries++);
}
if (values.consumers === "all") {
  onInternalDiagnosticEvent(() => deliveries++);
}
const traceInput = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: "01" };
async function run(count: number) {
  for (let i = 0; i < count; i++) {
    const trace = freezeDiagnosticTraceContext(traceInput);
    if (values.workload === "tool") {
      const tool = {
        trace,
        runId: `run-${i}`,
        sessionKey: `agent:synthetic:session-${i % 10000}`,
        toolName: "read",
        toolCallId: `call-${i}`,
        paramsSummary: { kind: "object" as const },
      };
      emit({ type: "tool.execution.started", ...tool });
      emit({ type: "tool.execution.completed", ...tool, durationMs: 5 });
    } else {
      const phases: DiagnosticEventInput[] = [
        {
          type: "gateway.rpc",
          method: "sessions.list",
          phase: "received",
          clientKind: "control-ui",
        },
        {
          type: "gateway.rpc",
          method: "sessions.list",
          phase: "handler",
          outcome: "returned",
          durationMs: 1,
          admissionMs: 0,
        },
        {
          type: "gateway.rpc",
          method: "sessions.list",
          phase: "response",
          outcome: "ok",
          durationMs: 1,
          responseBytes: 1024,
        },
        {
          type: "gateway.rpc",
          method: "sessions.list",
          phase: "dispatch",
          outcome: "returned",
          durationMs: 1,
          response: "sent",
        },
      ];
      for (const event of phases) {
        emit({ ...event, trace: freezeDiagnosticTraceContext(trace) });
      }
    }
    if (i % 32 === 31) {
      await drain();
    }
  }
  await drain();
}
await run(1000);
deliveries = 0;
const originalClone = globalThis.structuredClone;
if (values.mode === "counts") {
  globalThis.structuredClone = (value, options) => {
    clones++;
    return originalClone(value, options);
  };
}
const inspector = new Session();
if (values.mode === "allocation") {
  await startCollectedHeapSampling(inspector, 1024);
}
const hostLoad = loadavg();
const cpuStart = process.cpuUsage();
const started = performance.now();
await run(iterations);
const wallMs = performance.now() - started;
const cpu = process.cpuUsage(cpuStart);
let sampledBytes: number | undefined;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
}
globalThis.structuredClone = originalClone;
const eventsPerOperation = values.workload === "tool" ? 2 : 4;
const expectedDeliveries =
  values.workload === "tool"
    ? values.consumers === "none"
      ? 0
      : values.consumers === "core"
        ? 4
        : 6
    : values.consumers === "all"
      ? 4
      : 0;
assert.equal(deliveries, iterations * expectedDeliveries);
console.log(
  JSON.stringify({
    ...values,
    iterations,
    eventsPerOperation,
    deliveries,
    clones: values.mode === "counts" ? clones : undefined,
    cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
    wallMs,
    sampledBytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    hostLoad,
    rss: process.memoryUsage().rss,
    heapUsed: process.memoryUsage().heapUsed,
  }),
);
