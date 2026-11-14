/**
 * Owner-only session delta churn; synthetic titles, previews, IDs and paths.
 * node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/session-row-delta-fingerprints-measure.mjs [owner-module] [mode] [sessions=22] [events=4096]
 * Modes: revisions (default), audiences (same revision), collected (GC between events).
 * Compare alternating fresh processes, >=5 pairs, start/end load <=40.
 * 22 active sessions (also run 256), 8 audiences, 4096 events; 512 events warm up first.
 * CPU covers only preparation/diff. Allocation covers the whole yielded driver
 * (including matched fixture construction and patch verification), read once to
 * avoid allocation-counter instrumentation altering weak-sample lifetimes. Each event yields so weak
 * samples can die. Collected mode deliberately removes all old weak samples.
 * Hash counts wrap the real crypto function; exact V8 allocation includes dead
 * objects. Retention is measured after yielding/GC, keeping only delivered vectors.
 * Accept identical patches with lower CPU/allocation; report collected-sample
 * behavior and retained vectors separately. This is not a whole-Gateway stress result.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";
import { freezeTrustedJsonSnapshot } from "../../src/shared/immutable-data.ts";

const [modulePath, mode = "revisions", sessionArg = "22", eventArg = "4096"] =
  process.argv.slice(2);
assert(["revisions", "audiences", "collected"].includes(mode));
assert(global.gc, "Run with --expose-gc");
let hashes = 0;
const nativeHash = crypto.hash;
crypto.hash = (...args) => {
  hashes++;
  return nativeHash(...args);
};
syncBuiltinESMExports();
const { prepareSessionRowDeltaFields: prepare, createSessionRowDeltaDiffer: differ } = await import(
  modulePath
    ? pathToFileURL(resolve(modulePath)).href
    : "../../src/gateway/session-row-delta-fields.ts"
);
const sessions = Number(sessionArg);
assert(Number.isInteger(sessions) && sessions > 0);
const audiences = 8;
const events = Number(eventArg);
assert(Number.isInteger(events) && events > 0);
const fixtures = Array.from({ length: sessions }, (_, index) =>
  freezeTrustedJsonSnapshot({
    key: `agent:main:subagent:synthetic-session-${index}`,
    sessionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    agentId: "main",
    kind: "direct",
    model: "synthetic-model",
    provider: "mock-provider",
    label: `Investigate synthetic project ${index}: preserve session event fields`,
    derivedTitle: `Synthetic session ${index} — verify tool-call results and follow-up`,
    workspaceDir: `/synthetic/worktrees/project-${index}/checkout`,
    cwd: `/synthetic/worktrees/project-${index}/checkout/src/gateway`,
    lastMessagePreview: "Synthetic tool result: the focused checks passed. ".repeat(12),
    lastAssistantMessage: freezeTrustedJsonSnapshot({
      text: "Synthetic preview ".repeat(64),
      timestamp: 1,
    }),
    status: "running",
    visibility: "shared",
    permissionMode: "allow",
    reasoningLevel: "high",
    ...Object.fromEntries(
      Array.from({ length: 24 }, (_counter, field) => [`counter${field}`, field]),
    ),
  }),
);
let baselines = Array.from({ length: sessions }, () => Array(audiences));
let cpuUs = 0,
  calls = 0,
  hashCalls = 0;
async function event(index, measured) {
  const session = index % sessions;
  const source =
    mode === "audiences" ? fixtures[session] : { ...fixtures[session], updatedAt: index };
  const rows = Array.from({ length: audiences }, (_, audience) =>
    freezeTrustedJsonSnapshot({
      ...source,
      snapshotAt: index,
      sharingRole: audience === 0 ? "owner" : "viewer",
    }),
  );
  if (mode === "collected") {
    global.gc();
  }
  const patches = [];
  const cpuStart = process.threadCpuUsage();
  const hashStart = hashes;
  const diff = differ();
  for (const [audience, row] of rows.entries()) {
    const previous = baselines[session][audience];
    const current = prepare(row, source);
    if (previous) {
      const patch = diff(previous, current, row);
      patches.push(patch);
    }
    baselines[session][audience] = current;
  }
  if (measured) {
    const cpu = process.threadCpuUsage(cpuStart);
    cpuUs += cpu.user + cpu.system;
    hashCalls += hashes - hashStart;
    calls += audiences;
  }
  for (const patch of patches) {
    assert.deepEqual(patch, {
      set: mode === "audiences" ? { snapshotAt: index } : { updatedAt: index, snapshotAt: index },
      remove: [],
    });
  }
}
const loadBefore = loadavg()[0];
for (let index = 0; index < 512; index++) {
  await event(index, false);
  await setImmediate();
}
await setImmediate();
global.gc();
const retainedBefore = process.memoryUsage().heapUsed;
const allocationStart = getHeapStatistics().total_allocated_bytes;
for (let index = 512; index < 512 + events; index++) {
  await event(index, true);
  await setImmediate();
}
const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocationStart;
await setImmediate();
global.gc();
const retainedWithVectors = process.memoryUsage().heapUsed;
baselines = [];
await setImmediate();
global.gc();
const retainedWithoutVectors = process.memoryUsage().heapUsed;
console.log(
  JSON.stringify({
    mode,
    sessions,
    events,
    calls,
    hashes: hashCalls,
    cpuMs: cpuUs / 1000,
    allocatedBytes,
    bytesPerCall: allocatedBytes / calls,
    cpuUsPerCall: cpuUs / calls,
    retainedBefore,
    retainedWithVectors,
    retainedVectorBytes: retainedWithVectors - retainedWithoutVectors,
    loadBefore,
    loadAfter: loadavg()[0],
  }),
);
