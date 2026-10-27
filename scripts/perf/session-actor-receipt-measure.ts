/**
 * Worker receipt capture + host delivery, restoration, and entry freezing, with
 * synthetic Team-shaped 32 KiB skills metadata and an 8.8 KiB append.
 * --phase patch measures an unchanged bookkeeping patch with no transcript delta;
 * its base arm matches the protocol before unchanged patch entry reuse.
 * node --import ./scripts/tsx.mjs scripts/perf/session-actor-receipt-measure.ts \
 *   --arm base --mode timing
 * Repeat with --arm candidate, alternating AB/BA order for at least two pairs
 * (prefer five samples per arm). Run the same order separately with --mode allocation;
 * the inspector includes objects collected by minor and major GC. Timing and GC
 * conclusions use only timing passes. Each invocation measures 5,000 operations.
 * A real Worker performs production receipt capture (serialize + structuredClone)
 * and sends bounded batches of 32 receipts. CPU, allocation, and GC are measured
 * only in the receiving main isolate; sender thread CPU is reported separately.
 * Host work includes deserialization, production restoration, and the replica's
 * entry-freezing helper, but excludes SQL, admission, publication, and the rest of
 * replica settlement. This owner benchmark does not replace Gateway load proof.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { serialize } from "node:v8";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import type { SessionActorHotState } from "../../src/config/sessions/session-actor-contract.js";
import {
  createSessionActorCommittedOutcome,
  projectSessionActorCommittedOutcome,
  restoreSessionActorCommittedOutcome,
  type SessionActorCommittedWireOutcome,
} from "../../src/config/sessions/session-actor-receipt.js";
import { captureSqliteWorkerCommitReceipt } from "../../src/infra/sqlite-worker-operation-settlement.js";
import { freezeTrustedJsonSnapshot } from "../../src/shared/immutable-data.js";

const { values } = parseArgs({
  options: {
    arm: { type: "string" },
    mode: { type: "string", default: "timing" },
    phase: { type: "string", default: "append" },
    iterations: { type: "string", default: "5000" },
  },
});
const arm: unknown = isMainThread ? values.arm : workerData.arm;
const phase: unknown = isMainThread ? values.phase : workerData.phase;
assert(phase === "append" || phase === "patch");
assert(arm === "base" || arm === "candidate", "Choose --arm base or candidate");
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
const appended: SessionActorHotState = {
  ...before,
  version: { ...before.version, sequence: 1001 },
  writeToken: "synthetic-entry-revision-1001",
  transcript: {
    ...before.transcript,
    version: { ...before.transcript.version, rawSeq: 1001, updatedAt: 2 },
    watermark: { ...before.transcript.watermark, maxSeq: 1001 },
  },
};
const after = phase === "patch" ? { ...appended, transcript: before.transcript } : appended;
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
  phase: phase === "patch" ? "patch" : "appendTranscriptEvent",
  command: { commandId: "synthetic-append", phaseId: "synthetic-turn" },
  before,
  after,
  payloads: new Map([[1001, { event, serializedBytes: serialize(event).byteLength }]]),
  applied: {
    value: phase === "patch" ? undefined : { projectionNeedsReconcile: false },
    reducers: [],
  },
});
type WireOutcome = SessionActorCommittedWireOutcome<typeof outcome.value>;
type BatchComplete = { kind: "batch-complete"; senderCpuMs: number };
if (!isMainThread) {
  assert(parentPort);
  parentPort.on("message", (count: number) => {
    const cpuStart = process.threadCpuUsage();
    for (let index = 0; index < count; index++) {
      const wire = arm === "base" ? outcome : projectSessionActorCommittedOutcome(outcome, before);
      const captured = captureSqliteWorkerCommitReceipt(wire);
      assert(captured.kind === "inline", "Fixture must exercise the ordinary inline receipt");
      parentPort!.postMessage(captured.facts, []);
    }
    const cpu = process.threadCpuUsage(cpuStart);
    parentPort!.postMessage(
      {
        kind: "batch-complete",
        senderCpuMs: (cpu.user + cpu.system) / 1000,
      } satisfies BatchComplete,
      [],
    );
  });
} else {
  await measure();
}

function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
async function measure() {
  freezeTrustedJsonSnapshot(before.entry);
  const sender = new Worker(new URL(import.meta.url), { workerData: { arm, phase } });
  let senderCpuMs = 0;
  let last: WireOutcome | undefined;
  async function receive(count: number) {
    for (let offset = 0; offset < count; offset += 32) {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          sender.off("message", onMessage);
          reject(error);
        };
        const onMessage = (message: WireOutcome | BatchComplete) => {
          if (message.kind === "batch-complete") {
            senderCpuMs += message.senderCpuMs;
            sender.off("message", onMessage);
            sender.off("error", onError);
            resolve();
          } else {
            last = arm === "base" ? message : restoreSessionActorCommittedOutcome(message, before);
            freezeTrustedJsonSnapshot(last.receipt.postimage.entry);
          }
        };
        sender.on("message", onMessage);
        sender.once("error", onError);
        sender.postMessage(Math.min(32, count - offset), []);
      });
    }
  }
  const inspector = new Session();
  const collections: Array<{ start: number; duration: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      collections.push({ start: entry.startTime, duration: entry.duration });
    }
  });
  try {
    await receive(1);
    assert(last);
    assert.deepEqual(last, outcome);
    if (arm === "candidate") {
      assert.equal(last.receipt.postimage.entry, before.entry);
      assert.equal(last.receipt.postimage.entry?.skillsSnapshot, before.entry?.skillsSnapshot);
    } else {
      assert.notEqual(last.receipt.postimage.entry, before.entry);
    }
    // The fixture owns this event shape; the check includes aliasing, not just equal bytes.
    if (phase === "append") {
      const delivered = last.receipt.transcript.appendedEvents?.[0]?.event as typeof event;
      assert.equal(delivered.firstView.buffer, delivered.secondView.buffer);
      assert.notEqual(delivered.firstView.buffer, sharedBuffer);
      assert.equal(delivered.secondView[0], 42);
    }

    await receive(1000);
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
    senderCpuMs = 0;
    const start = performance.now();
    await receive(iterations);
    const end = performance.now();
    const cpu = process.threadCpuUsage(cpuStart);
    const memoryAfter = process.memoryUsage();
    const hostLoadAfter = loadavg();
    await setImmediate();
    await setImmediate();
    const sampled =
      values.mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
    const pauses = collections.filter(({ start: at }) => at >= start && at < end);
    const wire = arm === "base" ? outcome : projectSessionActorCommittedOutcome(outcome, before);
    const allocatedBytes = sampled ? allocated(sampled.profile.head) : undefined;
    console.log(
      JSON.stringify({
        arm,
        mode: values.mode,
        iterations,
        fixture: phase === "patch" ? "32k-entry-unchanged-patch" : "32k-entry-8.8k-append",
        serializedBytesPerOperation: serialize(wire).byteLength,
        elapsedMs: end - start,
        mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
        senderThreadCpuMs: senderCpuMs,
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
    await sender.terminate();
  }
}
