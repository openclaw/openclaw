/**
 * Native MessageChannel cost of actor admission using a real synthetic Gateway row.
 * Seed with team-shape-stress.ts and mock turns first; never pass live state.
 * node --import ./scripts/tsx.mjs scripts/perf/session-actor-admission-measure.ts \
 *   --state-dir <synthetic-state> --mode timing [--owner <baseline-command.ts>]
 * Repeat in alternating order with --mode allocation (collected objects included).
 * Setup reads one full actor snapshot outside measurement; 5,000 measured sends
 * exercise the production projection and native clone in one isolate. CPU includes
 * sender and receiver; this is owner transport cost, not whole-Gateway latency.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serialize } from "node:v8";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { projectSessionActorAuthority } from "../../src/config/sessions/session-actor-command.js";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "session-key": { type: "string", default: "agent:main:transcript-broadcast-measure-child-0" },
    mode: { type: "string", default: "timing" },
    owner: { type: "string" },
  },
});
assert(values["state-dir"], "--state-dir must name synthetic Gateway state");
assert(values.mode === "timing" || values.mode === "allocation");
process.env.OPENCLAW_STATE_DIR = path.resolve(values["state-dir"]);
const project: typeof projectSessionActorAuthority = values.owner
  ? (await import(pathToFileURL(path.resolve(values.owner)).href)).projectSessionActorAuthority
  : projectSessionActorAuthority;
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { readOpenClawAgentDatabaseIdentity } =
  await import("../../src/state/openclaw-agent-db-identity.js");
const { createSessionActorFactory } =
  await import("../../src/config/sessions/session-actor-durable.js");
const options = { agentId: "main", env: process.env };
const database = openOpenClawAgentDatabase(options);
const identity = readOpenClawAgentDatabaseIdentity(database);
assert(identity.identity);
const actor = await createSessionActorFactory({ ...options, path: database.path }).acquire(
  {
    sessionKey: values["session-key"],
    database: {
      kind: "file",
      physicalIdentity: identity.identity,
      birthtime: identity.birthtime,
      nativeLocation: database.path,
    },
  },
  { assertCurrent() {}, assertReadable() {} },
);
assert(!("kind" in actor));
const state = await actor.read({ assertCurrent() {}, authorize() {} });
assert(state.entry?.skillsSnapshot, "Run mock-provider turns before this measurement");
await actor.release();
await closeOpenClawAgentDatabasesAsync();
await closeOpenClawStateDatabaseAsync();
const { port1, port2 } = new MessageChannel();
const inspector = new Session();
const pauses: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const event of list.getEntries()) {
    pauses.push(event.duration);
  }
});
const envelope = () => ({
  stage: "transaction",
  facts: { kind: "session-actor-admission", snapshot: project(state) },
});
function send() {
  port1.postMessage(envelope(), []);
  const reply = receiveMessageOnPort(port2);
  assert(reply?.message.facts.snapshot.entry.sessionId === state.entry?.sessionId);
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
try {
  for (let index = 0; index < 1000; index++) {
    send();
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
  const iterations = 5000;
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    send();
  }
  const elapsedMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  await setImmediate();
  const profile =
    values.mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  console.log(
    JSON.stringify({
      mode: values.mode,
      iterations,
      serializedBytesPerOperation: serialize(envelope()).byteLength,
      entryBytes: serialize(state.entry).byteLength,
      cpuMs: (used.user + used.system) / 1000,
      elapsedMs,
      sampledAllocatedBytes: profile ? allocated(profile.profile.head) : undefined,
      gc: {
        count: pauses.length,
        totalMs: pauses.reduce((a, b) => a + b, 0),
        maxMs: Math.max(0, ...pauses),
      },
      hostLoad: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
  port1.close();
  port2.close();
}
