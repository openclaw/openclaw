// Owner-boundary allocation proof; run on the approved benchmark host with scripts/tsx.mjs.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SessionActorHotState } from "../../src/config/sessions/session-actor-contract.js";
import type { PreparedSessionTranscriptHydration } from "../../src/config/sessions/session-history-read.types.js";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string" },
    "start-file": { type: "string" },
    operations: { type: "string", default: "10000" },
    "interval-ms": { type: "string", default: "1" },
    mode: { type: "string", default: "exact" },
    output: { type: "string" },
    "trace-log": { type: "string" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required");
const tracing = process.execArgv.includes("--trace-gc-nvp");
assert.equal(
  tracing,
  Boolean(values["trace-log"]),
  "--trace-log and --trace-gc-nvp require each other",
);
function markGc(phase: string, profilePath?: string) {
  if (tracing) {
    writeSync(
      1,
      `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
    );
  }
}
const mode = values.mode;
assert(mode === "exact" || mode === "window" || mode === "complete", "Invalid --mode");
const operations = parseStrictIntegerOption({
  raw: values.operations,
  label: "--operations",
  min: 1,
  fallback: 10000,
});
const intervalMs = parseStrictIntegerOption({
  raw: values["interval-ms"],
  label: "--interval-ms",
  min: 0,
  fallback: 1,
});
const ownerUrl = new URL(
  "../../src/config/sessions/session-actor-transcript-replica.ts",
  import.meta.url,
);
const sourceUrl = values["owner-file"]
  ? pathToFileURL(path.resolve(values["owner-file"]))
  : ownerUrl;
let ownerLoaded = false;
if (values["owner-file"]) {
  registerHooks({
    load(url, context, nextLoad) {
      if (url === ownerUrl.href) {
        ownerLoaded = true;
        const loaded = nextLoad(sourceUrl.href, context);
        return { format: loaded.format, source: loaded.source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
const { seedSessionActorTranscriptContext: seed, readSessionActorTranscriptContext: read } =
  await import("../../src/config/sessions/session-actor-transcript-replica.js");
assert(!values["owner-file"] || ownerLoaded, "Requested owner replacement was not loaded");
if (tracing) {
  assert(global.gc, "Trace identification requires --expose-gc");
  markGc("identify-start");
  global.gc();
  markGc("identify-stop");
}
type Bounded = Extract<PreparedSessionTranscriptHydration, { kind: "bounded" }>;
const eventCount = 64;
const textBytes = 16 * 1024;
const limits = { maxBytes: 2 * 1024 ** 2, maxEvents: eventCount };
const version = { generation: "synthetic-generation", rawSeq: eventCount, updatedAt: 1 };
const hot: SessionActorHotState = {
  target: {
    database: { kind: "memory", handle: "synthetic", incarnation: "synthetic" },
    sessionKey: "agent:main:synthetic",
  },
  version: { epoch: "synthetic", sequence: 1 },
  writeToken: "synthetic",
  dependencySessionIds: ["synthetic"],
  entry: { sessionId: "synthetic", updatedAt: 1 },
  hasBoard: false,
  participants: [],
  members: [],
  pendingInputs: [],
  completionKeys: [],
  transcript: {
    version,
    watermark: { generation: version.generation, maxSeq: eventCount },
    anchorsState: "resident",
    anchors: [],
    idempotency: [],
    modelContext: {
      kind: "resident",
      entries: Array.from({ length: eventCount }, (_, index) => ({
        rawSeq: index + 1,
        eventId: `message-${index}`,
      })),
    },
  },
};
function fixture(): Bounded {
  const events = [
    { type: "session", id: "synthetic", version: 3 },
    ...Array.from({ length: eventCount }, (_, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      timestamp: "2026-10-24T00:00:00.000Z",
      message: {
        role: index % 2 ? "assistant" : "user",
        content: [
          {
            type: "text",
            text: Buffer.from(`synthetic-${index}:`.padEnd(textBytes, "x")).toString("utf8"),
          },
        ],
      },
    })),
  ];
  const residentRows = events.map((event, rawSeq) => ({
    rawSeq,
    serializedBytes: Buffer.byteLength(JSON.stringify(event)),
  }));
  return {
    kind: "bounded",
    ...(mode === "exact" ? {} : { residentRows }),
    snapshot: {
      version: { ...version },
      activeLeafEntryId: `message-${eventCount - 1}`,
      opaqueParents: new Map(),
      parents: new Map(
        Array.from({ length: eventCount }, (_, index): [string, string | null] => [
          `message-${index}`,
          index === 0 ? null : `message-${index - 1}`,
        ]),
      ),
      firstKeptRanges: new Map(),
      persistedSuffixStartSeq: 1,
      boundaryCount: 0,
      events,
      cacheTtlProjectionPrefixes: [],
      serializedBytes: residentRows.reduce((sum, row) => sum + row.serializedBytes, 0),
      totalEvents: eventCount,
      transcriptMutationAt: 1,
      truncated: mode !== "complete",
      ...(mode === "complete" ? { completeActivePath: true } : {}),
    },
  };
}
const json = (value: unknown) =>
  JSON.stringify(value, (_key, member) => (member instanceof Map ? [...member] : member));
function requireRead(retained: ReturnType<typeof seed>): Bounded {
  const result = read(retained, hot, limits);
  assert(result, "Retained context unexpectedly missed");
  return result;
}
function requireMode(retained: ReturnType<typeof seed>) {
  assert(retained?.context, "Seeding failed");
  assert(
    mode === "exact"
      ? retained.context.exact
      : mode === "window"
        ? retained.context.window
        : retained.context.rows,
    "Fixture did not exercise its declared context mode",
  );
}
function mutateMessage(snapshot: Bounded["snapshot"]) {
  const event = snapshot.events[1];
  assert(event && typeof event === "object");
  const message: unknown = Reflect.get(event, "message");
  assert(message && typeof message === "object");
  const content: unknown = Reflect.get(message, "content");
  assert(Array.isArray(content));
  const block: unknown = content[0];
  assert(block && typeof block === "object");
  Reflect.set(block, "text", "caller mutation");
}
// Check ownership before capture, including mutable maps, arrays, and nested message payloads.
const proof = fixture();
const proofRetained = seed(undefined, hot, proof, limits);
requireMode(proofRetained);
assert.deepEqual(requireRead(proofRetained).snapshot, proof.snapshot);
const golden = json(requireRead(proofRetained));
mutateMessage(proof.snapshot);
proof.snapshot.events.length = 0;
proof.snapshot.parents.clear();
assert.equal(json(requireRead(proofRetained)), golden, "Seeding leaked the caller's containers");
const detached = requireRead(proofRetained);
mutateMessage(detached.snapshot);
detached.snapshot.parents.clear();
detached.snapshot.events.splice(0, 1);
assert.equal(json(requireRead(proofRetained)), golden, "Reading leaked the retained context");
const prepared = fixture();
let latest = requireRead(seed(undefined, hot, prepared, limits));
const operation = () => {
  latest = requireRead(seed(undefined, hot, prepared, limits));
};
for (let index = 0; index < 32; index++) {
  operation();
}
console.log("PHASE warmed");
if (values["start-file"]) {
  while (!existsSync(values["start-file"])) {
    await delay(50);
  }
  const startAt = Number(readFileSync(values["start-file"], "utf8").trim());
  assert(Number.isSafeInteger(startAt) && startAt > Date.now(), "Missed synchronized start");
  await delay(startAt - Date.now());
}
function allocatedBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocatedBytes(child), 0);
}
function functionAllocation(root: HeapProfiler.SamplingHeapProfileNode, functionName: string) {
  let matchedFrameNodes = 0;
  const visit = (node: HeapProfiler.SamplingHeapProfileNode): number => {
    if (node.callFrame.functionName === functionName) {
      matchedFrameNodes++;
      return allocatedBytes(node);
    }
    return node.children.reduce((sum, child) => sum + visit(child), 0);
  };
  const sampledBytes = visit(root);
  return {
    matchedFrameNodes,
    ...(matchedFrameNodes ? { sampledBytes, bytesPerCall: sampledBytes / operations } : {}),
  };
}
const inspector = values.allocations ? new Session() : undefined;
const latencies = new Float64Array(operations);
try {
  inspector?.connect();
  if (inspector) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const finishDiagnostics = startGatewayBenchDiagnostics();
  const cpuBefore = process.cpuUsage();
  markGc("diagnostics-start", values.output);
  for (let index = 0; index < operations; index++) {
    const started = performance.now();
    operation();
    latencies[index] = performance.now() - started;
    await delay(intervalMs);
  }
  markGc("diagnostics-stop", values.output);
  const cpu = process.cpuUsage(cpuBefore);
  const diagnostics = finishDiagnostics();
  const profile = inspector
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  const promotion = values["trace-log"]
    ? readGatewayGcTrace(values["trace-log"], values.output, "diagnostics")
    : undefined;
  assert.equal(json(latest), golden, "Measured context changed bytes");
  assert.equal(json(requireRead(seed(undefined, hot, prepared, limits))), golden);
  const sorted = latencies.toSorted();
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  const allocation = profile
    ? {
        sampledBytes: allocatedBytes(profile.head),
        byFunction: Object.fromEntries(
          ["seedSessionActorTranscriptContext", "readSessionActorTranscriptContext"].map((name) => [
            name,
            functionAllocation(profile.head, name),
          ]),
        ),
      }
    : undefined;
  const result = {
    scope:
      "Synthetic owner seed/read pairs; no Gateway, turn latency, or live allocation-share claim",
    sourceSha256: hash("sha256", readFileSync(sourceUrl), "hex"),
    ownerReplacement: ownerLoaded,
    mode,
    operations,
    seedCalls: operations,
    readCalls: operations,
    warmupOperations: 32,
    fixture: {
      eventCount,
      textBytes,
      serializedBytes: prepared.snapshot.serializedBytes,
      reusedPreparedSnapshot: true,
    },
    intervalMs,
    goldenSha256: hash("sha256", golden, "hex"),
    timingGateEligible: !values.allocations && !tracing,
    latency: {
      count: operations,
      totalMs,
      meanMs: totalMs / operations,
      p95Ms: sorted[Math.ceil(operations * 0.95) - 1],
      p99Ms: sorted[Math.ceil(operations * 0.99) - 1],
      maxMs: sorted.at(-1),
    },
    cpuMs: (cpu.user + cpu.system) / 1000,
    diagnostics,
    gcMsPerOperation: (diagnostics.gc.durationMs?.total ?? 0) / operations,
    ...(promotion
      ? {
          promotion: {
            ...promotion,
            promotedBytesPerOperation: promotion.promotedBytes / operations,
          },
        }
      : {}),
    ...(allocation === undefined
      ? {}
      : {
          allocation: {
            ...allocation,
            bytesPerSeedReadPair: allocation.sampledBytes / operations,
            samplingInterval: 32768,
            includesCollectedObjects: true,
          },
        }),
  };
  const output = path.resolve(values.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  inspector?.disconnect();
}
