/**
 * Owner-only projection benchmark; no Gateway, SQLite, or operator state access.
 * Run timing and allocation in separate processes for each revision, alternating AB/BA:
 * node --import ./scripts/tsx.mjs scripts/perf/session-actor-projection-measure.ts --iterations 20000
 * Add --allocations for sampled allocation, --output <file> to save JSON.
 * --owner <path> selects the real hydration module from a prepared revision. Alternatively,
 * preload worker-retained-heap-preload.ts with OPENCLAW_BENCH_BASELINE_DIR for source overrides.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import type { SessionActorStoredState } from "../../src/config/sessions/session-actor-hydration.types.js";
import { summarizeGcByKind } from "../lib/gc-profile-summary.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "20000" },
    allocations: { type: "boolean", default: false },
    output: { type: "string" },
    "start-at": { type: "string" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 20000,
});
const startAt = parseStrictIntegerOption({
  raw: values["start-at"],
  label: "--start-at",
  min: 1,
  fallback: 0,
});
const ownerUrl = values.owner
  ? pathToFileURL(path.resolve(values.owner))
  : new URL("../../src/config/sessions/session-actor-hydration.worker.ts", import.meta.url);
const owner: typeof import("../../src/config/sessions/session-actor-hydration.worker.js") =
  await import(ownerUrl.href);
const actors = 10000;
const eventsPerActor = 8;
function fixture(index: number): SessionActorStoredState {
  const sessionId = `synthetic-session-${index}`;
  const sessionKey = `agent:main:subagent:${sessionId}`;
  const version = { generation: `generation-${index}`, rawSeq: eventsPerActor, updatedAt: 1000 };
  const state: SessionActorStoredState = {
    agentId: "main",
    path: "/synthetic/agent.sqlite",
    hot: {
      target: {
        sessionKey,
        database: {
          kind: "file",
          physicalIdentity: "synthetic",
          nativeLocation: "/synthetic/agent.sqlite",
          birthtime: "1",
        },
      },
      version: { epoch: `epoch-${index}`, sequence: index },
      writeToken: `${index}`,
      dependencySessionIds: [sessionId],
      entry: { sessionId, updatedAt: 1000, label: `Actor ${index}` },
      hasBoard: index % 10 === 0,
      participants: Array.from({ length: 3 }, (_, person) => ({
        identity: { type: "profile", id: `person-${index}-${person}` },
        contributionCount: person + 1,
        firstPromptedAt: person,
        lastPromptedAt: 1000,
      })),
      members: Array.from({ length: 3 }, (_, person) => ({
        identityId: `person-${index}-${person}`,
        addedBy: "owner",
        addedAt: person,
      })),
      pendingInputs: [],
      completionKeys: [],
      transcript: {
        version,
        watermark: { generation: version.generation, maxSeq: eventsPerActor },
        anchorsState: "unavailable",
        anchors: [],
        idempotency: [],
        modelContext: { kind: "unavailable", reason: "projection", generation: version.generation },
      },
    },
    entryRows: new Map(),
    window: undefined,
    hasBoard: index % 10 === 0,
    pendingInputs: new Map(),
    completions: new Map(),
    completionsComplete: true,
    transcript: {
      complete: true,
      coldArchive: undefined,
      identities: new Map(),
      active: new Map(),
      navigation: [],
      payloads: new Map(),
      projection: {
        activeEventCount: eventsPerActor,
        activeMessageCount: eventsPerActor,
        indexedSeq: eventsPerActor,
        leafEventId: `event-${eventsPerActor}`,
        needsRebuild: false,
        hasUnclassifiedEvents: false,
      },
      contextStats: { eventCount: eventsPerActor, sizeBytes: 2048, boundaryActivePosition: 0 },
    },
  };
  for (let seq = 1; seq <= eventsPerActor; seq++) {
    state.transcript.identities.set(`event-${seq}`, {
      created_at: seq,
      event_id: `event-${seq}`,
      event_type: "message",
      message_idempotency_key: null,
      parent_id: seq === 1 ? null : `event-${seq - 1}`,
      seq,
      session_id: sessionId,
    });
    state.transcript.active.set(seq, {
      active_position: seq,
      context_eligible: 1,
      event_seq: seq,
      message_position: seq,
      session_id: sessionId,
    });
    state.transcript.navigation.push({ seq, id: `event-${seq}`, type: "message" });
  }
  return state;
}
const states = Array.from({ length: actors }, (_, index) => fixture(index));
let checksum = 0;
function run(count: number) {
  for (let index = 0; index < count; index++) {
    const state = states[index % actors]!;
    state.hot = owner.projectSessionActorHotState(state);
    checksum +=
      state.hot.version.sequence + state.hot.participants.length + state.hot.members.length;
  }
}
function digest() {
  const hash = createHash("sha256");
  for (const state of states) {
    hash.update(JSON.stringify(state.hot));
  }
  return hash.digest("hex");
}
run(actors); // Warm every distinct state and establish the canonical projected shape.
const expected = digest();
const inspector = new Session();
inspector.connect();
try {
  await inspector.post("HeapProfiler.collectGarbage");
  if (startAt) {
    assert(Date.now() < startAt, "Missed synchronized warm start");
    await delay(startAt - Date.now());
  }
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  checksum = 0;
  const gc = new GCProfiler();
  gc.start();
  const processStarted = process.cpuUsage();
  const threadStarted = process.threadCpuUsage();
  const started = performance.now();
  run(iterations);
  const elapsedMs = performance.now() - started;
  const threadCpu = process.threadCpuUsage(threadStarted);
  const processCpu = process.cpuUsage(processStarted);
  const statistics = gc.stop()?.statistics ?? [];
  const memoryAfter = process.memoryUsage();
  const hostLoadAfter = loadavg();
  let allocationBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const total = (node: typeof profile.head): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + total(child), 0);
    allocationBytes = total(profile.head);
  }
  const actual = digest();
  assert.equal(actual, expected, "Projection changed between warmup and measurement");
  const byKind = summarizeGcByKind(statistics);
  const result = {
    node: process.version,
    owner: ownerUrl.href,
    baselineDirectory: process.env.OPENCLAW_BENCH_BASELINE_DIR,
    mode: values.allocations ? "sampled-allocation" : "timing",
    actors,
    eventsPerActor,
    participantsPerActor: 3,
    membersPerActor: 3,
    warmupOperations: actors,
    iterations,
    startAt,
    elapsedMs,
    nsPerOperation: (elapsedMs * 1e6) / iterations,
    threadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
    processCpuMs: (processCpu.user + processCpu.system) / 1000,
    allocationBytes,
    allocationBytesPerOperation:
      allocationBytes === undefined ? undefined : allocationBytes / iterations,
    gc: {
      count: statistics.length,
      totalMs: byKind.reduce((sum, item) => sum + item.totalMs, 0),
      byKind,
    },
    hostLoadBefore,
    hostLoadAfter,
    memoryBefore,
    memoryAfter,
    checksum,
    digest: actual,
    scope:
      "Internal actor projection only; excludes hydration, serialization, admission, SQL, and Gateway",
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) {
    await writeFile(values.output, json);
  }
  process.stdout.write(json);
} finally {
  inspector.disconnect();
}
