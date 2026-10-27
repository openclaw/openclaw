/**
 * Host actor admission microbenchmark: 64 actors, assistant/tool message appends,
 * with and without a retained phase. The synthetic memory sink isolates capture,
 * admission, phase bookkeeping and receipt delivery; it does not measure SQLite,
 * source-authority preparation, provider execution, or whole-Gateway performance.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-actor-append-measure.ts
 * Add --owner-file src/config/sessions/.session-actor-executor.base.ts for a saved
 * sibling module; --events 10000 controls appends per workload. Run --allocation
 * separately (1 KiB sampling, including collected objects). Alternate base/head
 * timing and allocation passes; require equal counters/digests and report spread.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type {
  SessionActor,
  SessionActorOutcome,
  SessionActorPhaseResults,
} from "../../src/config/sessions/session-actor-contract.js";
import { createSessionActorMemoryState } from "../../src/config/sessions/session-actor-memory-state.js";
import { createSessionActorCommittedOutcome } from "../../src/config/sessions/session-actor-receipt.js";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string", default: "src/config/sessions/session-actor-executor.ts" },
    events: { type: "string", default: "10000" },
    allocation: { type: "boolean", default: false },
  },
});
const events = Number(values.events);
assert(Number.isSafeInteger(events) && events >= 64);
const owner = path.resolve(values["owner-file"]);
const {
  createSessionActorWithExecutor,
}: typeof import("../../src/config/sessions/session-actor-executor.js") = await import(
  pathToFileURL(owner).href
);
const ownerSha256 = createHash("sha256").update(readFileSync(owner)).digest("hex");
const messages = [
  JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "Synthetic streamed answer. ".repeat(40) }],
    timestamp: 1,
  }),
  JSON.stringify({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "Synthetic tool output. ".repeat(40) }],
    isError: false,
    timestamp: 1,
  }),
];

async function workload(phased: boolean, count: number, measure: boolean) {
  let accepted = 0,
    lifetimeChecks = 0,
    sourceChecks = 0,
    retainedBytes = 0,
    emptyReducerInputs = 0;
  const authority = {
    assertCurrent() {
      sourceChecks++;
    },
    authorize() {
      sourceChecks++;
    },
  };
  const inputs = Array.from({ length: count }, (_, index) => ({
    commandId: String(index),
    phaseId: "turn",
    append: {
      kind: "message" as const,
      input: {
        scope: {
          agentId: "main",
          storePath: "/synthetic/bench.db",
          sessionKey: `agent:main:bench-${index % 64}`,
          sessionId: `session-${index % 64}`,
        },
        cwd: "/synthetic",
        messageJson: messages[index % messages.length]!,
      },
    },
  }));
  const retained: unknown[] = [];
  const actors = Array.from({ length: 64 }, (_, slot) => {
    const target = {
      database: { kind: "memory" as const, handle: `owner-${slot}`, incarnation: "bench" },
      sessionKey: `agent:main:bench-${slot}`,
    };
    let hot = createSessionActorMemoryState(target).hot;
    hot.version = { epoch: "bench", sequence: 0 };
    hot.entry = { sessionId: `session-${slot}`, updatedAt: 1 };
    return createSessionActorWithExecutor({
      target,
      lifetime: {
        assertCurrent() {
          lifetimeChecks++;
        },
        assertReadable() {},
      },
      createExecutor: (guards) => ({
        snapshot: () => hot,
        read: async () => hot,
        release: async () => {},
        async command(phase, input, current) {
          assert.equal(phase, "appendTranscriptEvent");
          assert("append" in input && input.append?.kind === "message");
          const original = inputs[Number(input.commandId)]!;
          assert.notEqual(input, original);
          assert.notEqual(input.append, original.append);
          assert.notEqual(input.append.input, original.append.input);
          assert.equal(input.append.input.messageJson, original.append.input.messageJson);
          guards.assertAccepted();
          current.assertCurrent();
          current.authorize("commit", hot);
          const before = hot;
          hot = { ...hot, version: { ...hot.version, sequence: hot.version.sequence + 1 } };
          // Synthetic acceptance receipt only: this sink does not persist or project history.
          const outcome = createSessionActorCommittedOutcome({
            phase,
            command: input,
            before,
            after: hot,
            applied: { value: { projectionNeedsReconcile: false }, reducers: [] },
          });
          accepted++;
          emptyReducerInputs += Number(input.reducers?.length === 0);
          retainedBytes += input.append.input.messageJson.length;
          retained[slot] = {
            commandId: outcome.receipt.commandId,
            sequence: outcome.receipt.afterVersion.sequence,
            messageJson: input.append.input.messageJson,
          };
          // This sink accepts only appendTranscriptEvent, whose result includes projection facts.
          return outcome as SessionActorOutcome<SessionActorPhaseResults[typeof phase]>;
        },
      }),
    });
  });
  const gc: Record<string, { count: number; ms: number; maxMs: number }> = {};
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const kind = String((entry as typeof entry & { detail: { kind: number } }).detail.kind);
      const row = (gc[kind] ??= { count: 0, ms: 0, maxMs: 0 });
      row.count++;
      row.ms += entry.duration;
      row.maxMs = Math.max(row.maxMs, entry.duration);
    }
  });
  global.gc?.();
  await setImmediate();
  await setImmediate();
  observer.observe({ entryTypes: ["gc"] });
  const inspector = new Session();
  if (measure && values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const memoryBefore = process.memoryUsage(),
    hostLoadBefore = loadavg();
  const cpuStart = process.threadCpuUsage(),
    start = performance.now();
  const turn = async (actor: SessionActor, slot: number) => {
    for (let index = slot; index < count; index += 64) {
      const result = await actor.appendTranscriptEvent(inputs[index]!, authority);
      assert.equal(result.kind, "committed");
    }
  };
  await Promise.all(
    actors.map((actor, slot) =>
      phased
        ? actor.withPhase("turn", authority, (phase) => turn(phase.actor, slot))
        : turn(actor, slot),
    ),
  );
  const elapsedMs = performance.now() - start,
    cpu = process.threadCpuUsage(cpuStart);
  const memoryAfter = process.memoryUsage();
  let sampledBytes: number | undefined;
  if (measure && values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledBytes = sum(profile.head);
    inspector.disconnect();
  }
  await setImmediate();
  await setImmediate();
  observer.disconnect();
  assert.equal(accepted, count);
  assert(lifetimeChecks >= count * 2);
  assert.equal(sourceChecks, count * 2);
  const digest = createHash("sha256").update(JSON.stringify(retained)).digest("hex");
  if (measure) {
    console.log(
      JSON.stringify({
        owner,
        ownerSha256,
        node: process.version,
        actors: 64,
        phased,
        events: count,
        mode: values.allocation ? "allocation" : "timing",
        accepted,
        emptyReducerInputs,
        lifetimeChecks,
        sourceChecks,
        retainedBytes,
        digest,
        elapsedMs,
        wallUsPerEvent: (elapsedMs * 1000) / count,
        threadCpuUsPerEvent: (cpu.user + cpu.system) / count,
        sampledBytes,
        sampledBytesPerEvent: sampledBytes === undefined ? undefined : sampledBytes / count,
        gc,
        memoryBefore,
        memoryAfter,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
      }),
    );
  }
  await Promise.all(actors.map((actor) => actor.release()));
}
for (const phased of [false, true]) {
  await workload(phased, 1024, false);
  await workload(phased, events, true);
}
