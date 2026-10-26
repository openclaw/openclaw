/**
 * Replica seed/read CPU and allocation with eight synthetic 128-message sessions.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-snapshot-copy-measure.ts
 *   --mode complete --iterations 3000 [--owner /absolute/base-snapshot.ts] [--allocations]
 * Repeat for window/exact, alternating base/candidate processes. Allocation sampling
 * includes collected objects; run it separately from timing. Setup and content/isolation
 * checks are outside measurement. Accept identical contents and less CPU/allocation;
 * this owner benchmark makes no whole-Gateway latency claim.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SessionActorHotState } from "../../src/config/sessions/session-actor-state.types.js";
import type { PreparedSessionTranscriptHydration } from "../../src/config/sessions/session-history-read.types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "complete" },
    owner: { type: "string" },
    iterations: { type: "string", default: "3000" },
    allocations: { type: "boolean", default: false },
  },
});
assert(["complete", "window", "exact"].includes(values.mode));
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 3000,
  min: 1,
  label: "iterations",
});
const ownerUrl = new URL("../../src/config/sessions/transcript-snapshot.ts", import.meta.url);
let replaced = false;
if (values.owner) {
  const replacement = pathToFileURL(path.resolve(values.owner)).href;
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== ownerUrl.href) {
        return nextLoad(url, context);
      }
      replaced = true;
      const loaded = nextLoad(replacement, context);
      return { format: loaded.format, source: loaded.source, shortCircuit: true };
    },
  });
}
const { seedSessionActorTranscriptContext: seed, readSessionActorTranscriptContext: read } =
  await import("../../src/config/sessions/session-actor-transcript-replica.js");
assert(!values.owner || replaced, "Baseline override did not load");
const limits = { maxBytes: 4 * 1024 * 1024, maxEvents: 256 };
type Bounded = Extract<PreparedSessionTranscriptHydration, { kind: "bounded" }>;
const fixtures = Array.from({ length: 8 }, (_session, session) => {
  const events = Array.from({ length: 128 }, (_, index) => ({
    type: "message",
    id: `entry-${index}`,
    parentId: index ? `entry-${index - 1}` : null,
    timestamp: "2026-10-26T00:00:00.000Z",
    message: {
      role: index % 3 === 0 ? "user" : index % 3 === 1 ? "assistant" : "toolResult",
      content: [{ type: "text", text: `${session}:${index}:`.padEnd(2048, "x") }],
      details: { items: [{ name: "synthetic", result: [1, 2, 3] }] },
    },
  }));
  const version = { generation: "fixture", rawSeq: 127, updatedAt: 1 };
  const hot: SessionActorHotState = {
    target: {
      database: { kind: "memory", handle: "fixture", incarnation: "fixture" },
      sessionKey: `agent:main:synthetic-${session}`,
    },
    version: { epoch: "fixture", sequence: 1 },
    writeToken: "fixture",
    dependencySessionIds: [`synthetic-${session}`],
    entry: { sessionId: `synthetic-${session}`, updatedAt: 1 },
    hasBoard: false,
    participants: [],
    members: [],
    pendingInputs: [],
    completionKeys: [],
    transcript: {
      watermark: { generation: "fixture", maxSeq: 127 },
      version,
      anchorsState: "resident",
      anchors: [],
      idempotency: [],
      modelContext: {
        kind: "resident",
        entries: events.map((event, rawSeq) => ({ rawSeq, eventId: event.id })),
      },
    },
  };
  const prepared: Bounded = {
    kind: "bounded",
    ...(values.mode === "exact"
      ? {}
      : {
          residentRows: events.map((event, rawSeq) => ({
            rawSeq,
            serializedBytes: Buffer.byteLength(JSON.stringify(event)) + 1,
          })),
        }),
    snapshot: {
      version: { ...version },
      events,
      activeLeafEntryId: "entry-127",
      parents: new Map(events.map((event) => [event.id, event.parentId])),
      opaqueParents: new Map(),
      firstKeptRanges: new Map(),
      persistedSuffixStartSeq: 0,
      boundaryCount: 0,
      cacheTtlProjectionPrefixes: [],
      serializedBytes: events.reduce(
        (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)) + 1,
        0,
      ),
      totalEvents: 128,
      transcriptMutationAt: 1,
      truncated: values.mode !== "complete",
      ...(values.mode === "complete" ? { completeActivePath: true } : {}),
    },
  };
  return { hot, prepared };
});
const retained = fixtures.map(({ hot, prepared }) => seed(undefined, hot, prepared, limits));
for (const [index, { hot, prepared }] of fixtures.entries()) {
  assert.deepEqual(read(retained[index], hot, limits)?.snapshot.events, prepared.snapshot.events);
}
function run(operation: "seed" | "read", count: number) {
  let observed = 0;
  for (let index = 0; index < count; index++) {
    const slot = index % fixtures.length;
    const { hot, prepared } = fixtures[slot]!;
    if (operation === "seed") {
      const result = seed(undefined, hot, prepared, limits);
      assert(result?.context);
      observed += result.version.rawSeq ?? 0;
    } else {
      observed += read(retained[slot], hot, limits)?.snapshot.events.length ?? 0;
    }
  }
  return observed;
}
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
for (const operation of ["seed", "read"] as const) {
  run(operation, 100);
  globalThis.gc?.();
  await setImmediate();
  const collections: number[] = [];
  const observer = new PerformanceObserver((list) => {
    collections.push(...list.getEntries().map((entry) => entry.duration));
  });
  observer.observe({ entryTypes: ["gc"] });
  const inspector = new Session();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const cpu = process.cpuUsage();
  const start = performance.now();
  const observed = run(operation, iterations);
  const elapsedMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  await setImmediate();
  await setImmediate();
  observer.disconnect();
  let allocationBytes: number | undefined;
  if (values.allocations) {
    allocationBytes = sampledBytes(
      (await inspector.post("HeapProfiler.stopSampling")).profile.head,
    );
    inspector.disconnect();
  }
  console.log(
    JSON.stringify({
      operation,
      mode: values.mode,
      iterations,
      observed,
      sourceSha256: hash("sha256", readFileSync(values.owner ?? ownerUrl), "hex"),
      contentSha256: hash(
        "sha256",
        JSON.stringify(fixtures.map(({ prepared }) => prepared.snapshot.events)),
        "hex",
      ),
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      allocationBytes,
      gcMs: collections.reduce((sum, duration) => sum + duration, 0),
      gcCount: collections.length,
      gcMaxMs: Math.max(0, ...collections),
      hostLoad,
      memory: process.memoryUsage(),
    }),
  );
}
