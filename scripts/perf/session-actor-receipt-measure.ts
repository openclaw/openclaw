/**
 * Actor receipt capture + native MessageChannel delivery, with synthetic Team-shaped
 * 32 KiB skills metadata and an 8.8 KiB append. No database or live Gateway is used.
 * node --import ./scripts/tsx.mjs scripts/perf/session-actor-receipt-measure.ts \
 *   --arm base --mode timing
 * Repeat with --arm candidate, alternating AB/BA order for at least two pairs
 * (prefer five samples per arm). Run the same order separately with --mode allocation;
 * the inspector includes objects collected by minor and major GC. Timing and GC
 * conclusions use only timing passes. Each invocation measures 5,000 operations.
 * Both arms use production receipt capture (serialize + structuredClone), then a
 * real MessagePort crossing; the candidate also restores its detached entry.
 * CPU includes sender and receiver in this isolate, not whole-Gateway throughput.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { serialize } from "node:v8";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import type { SessionActorHotState } from "../../src/config/sessions/session-actor-contract.js";
import {
  createSessionActorCommittedOutcome,
  projectSessionActorCommittedOutcome,
  restoreSessionActorCommittedOutcome,
  type SessionActorCommittedWireOutcome,
} from "../../src/config/sessions/session-actor-receipt.js";
import { captureSqliteWorkerCommitReceipt } from "../../src/infra/sqlite-worker-operation-settlement.js";

const { values } = parseArgs({
  options: {
    arm: { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "5000" },
  },
});
assert(values.arm === "base" || values.arm === "candidate", "Choose --arm base or candidate");
assert(values.mode === "timing" || values.mode === "allocation");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);

const before: SessionActorHotState = {
  target: {
    sessionKey: "agent:main:synthetic-receipt-measure",
    database: {
      kind: "file",
      physicalIdentity: "synthetic-team-shaped-database",
      birthtime: "1",
      nativeLocation: "/synthetic/agent.sqlite",
    },
  },
  version: { epoch: "synthetic-owner", sequence: 1000 },
  writeToken: "synthetic-entry-revision-1000",
  dependencySessionIds: ["synthetic-session"],
  entry: {
    sessionId: "synthetic-session",
    updatedAt: 1,
    lifecycleRevision: "synthetic-lifecycle",
    activeWriterRunId: "synthetic-run",
    skillsSnapshot: { prompt: "s".repeat(32 * 1024), skills: [{ name: "synthetic-skill" }] },
  },
  hasBoard: false,
  participants: [],
  members: [],
  pendingInputs: [],
  completionKeys: [],
  transcript: {
    version: { generation: "synthetic-generation", rawSeq: 1000, updatedAt: 1 },
    watermark: { generation: "synthetic-generation", maxSeq: 1000 },
    anchorsState: "unavailable",
    anchors: [],
    idempotency: [],
    modelContext: { kind: "unavailable", reason: "projection", generation: "synthetic-generation" },
  },
};
const after: SessionActorHotState = {
  ...before,
  version: { ...before.version, sequence: 1001 },
  writeToken: "synthetic-entry-revision-1001",
  transcript: {
    ...before.transcript,
    version: { ...before.transcript.version, rawSeq: 1001, updatedAt: 2 },
    watermark: { ...before.transcript.watermark, maxSeq: 1001 },
  },
};
const sharedBuffer = new ArrayBuffer(64);
const event = {
  type: "message",
  id: "synthetic-append-1001",
  parentId: "synthetic-append-1000",
  message: { role: "assistant", content: [{ type: "text", text: "m".repeat(8800) }] },
  firstView: new Uint8Array(sharedBuffer, 0, 32),
  secondView: new Uint8Array(sharedBuffer, 16, 32),
};
event.firstView[16] = 42;
const outcome = createSessionActorCommittedOutcome({
  phase: "appendTranscriptEvent",
  command: { commandId: "synthetic-append", phaseId: "synthetic-turn" },
  before,
  after,
  payloads: new Map([[1001, { event, serializedBytes: serialize(event).byteLength }]]),
  applied: { value: { projectionNeedsReconcile: false }, reducers: [] },
});
type WireOutcome = SessionActorCommittedWireOutcome<typeof outcome.value>;
const { port1, port2 } = new MessageChannel();
function send(arm: "base" | "candidate") {
  const wire = arm === "base" ? outcome : projectSessionActorCommittedOutcome(outcome, before);
  const captured = captureSqliteWorkerCommitReceipt(wire);
  assert(captured.kind === "inline", "Fixture must exercise the ordinary inline receipt");
  port1.postMessage(captured.facts);
  const received = receiveMessageOnPort(port2);
  assert(received);
  const result: WireOutcome = received.message;
  return arm === "base" ? result : restoreSessionActorCommittedOutcome(result, before);
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
const inspector = new Session();
const collections: Array<{ start: number; duration: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    collections.push({ start: entry.startTime, duration: entry.duration });
  }
});
try {
  const projected = projectSessionActorCommittedOutcome(outcome, before);
  assert.equal(projected.receipt.entryReference, before.writeToken);
  assert.equal(projected.receipt.postimage.entry, undefined);
  const baseline = send("base");
  const candidate = send("candidate");
  assert.deepEqual(candidate, baseline);
  assert.deepEqual(candidate, outcome);
  assert.notEqual(candidate.receipt.postimage.entry, before.entry);
  assert.notEqual(candidate.receipt.postimage.entry?.skillsSnapshot, before.entry?.skillsSnapshot);
  // The fixture owns this event shape; the check includes aliasing, not just equal bytes.
  const delivered = candidate.receipt.transcript.appendedEvents?.[0]?.event as typeof event;
  assert.equal(delivered.firstView.buffer, delivered.secondView.buffer);
  assert.notEqual(delivered.firstView.buffer, sharedBuffer);
  assert.equal(delivered.secondView[0], 42);

  for (let index = 0; index < 1000; index++) {
    send(values.arm);
  }
  await setImmediate();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  observer.observe({ entryTypes: ["gc"] });
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpuStart = process.threadCpuUsage();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    send(values.arm);
  }
  const end = performance.now();
  const cpu = process.threadCpuUsage(cpuStart);
  const memoryAfter = process.memoryUsage();
  const hostLoadAfter = loadavg();
  await setImmediate();
  await setImmediate();
  const sampled =
    values.mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  const pauses = collections.filter(({ start: at }) => at >= start && at < end);
  const wire =
    values.arm === "base" ? outcome : projectSessionActorCommittedOutcome(outcome, before);
  const allocatedBytes = sampled ? allocated(sampled.profile.head) : undefined;
  console.log(
    JSON.stringify({
      arm: values.arm,
      mode: values.mode,
      iterations,
      fixture: "32k-entry-8.8k-append",
      serializedBytesPerOperation: serialize(wire).byteLength,
      elapsedMs: end - start,
      mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
      sampledAllocatedBytes: allocatedBytes,
      sampledAllocatedBytesPerOperation:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      gc: {
        count: pauses.length,
        totalMs: pauses.reduce((sum, pause) => sum + pause.duration, 0),
        maxMs: Math.max(0, ...pauses.map((pause) => pause.duration)),
      },
      hostLoadBefore,
      hostLoadAfter,
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
  port1.close();
  port2.close();
}
