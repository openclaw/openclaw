/**
 * Native MessageChannel cost of actor admission using synthetic Team-shaped entries.
 * Use --synthetic for a 32 KiB skills prompt without opening a database, or seed
 * --state-dir with team-shape-stress.ts and mock turns first; never pass live state.
 * node --import ./scripts/tsx.mjs scripts/perf/session-actor-admission-measure.ts \
 *   --synthetic --mode timing [--owner <baseline-command.ts>]
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
import type { SessionActorHotState } from "../../src/config/sessions/session-actor-contract.js";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    synthetic: { type: "boolean", default: false },
    "session-key": { type: "string", default: "agent:main:transcript-broadcast-measure-child-0" },
    mode: { type: "string", default: "timing" },
    owner: { type: "string" },
  },
});
assert(
  Boolean(values["state-dir"]) !== values.synthetic,
  "Choose --synthetic or --state-dir <synthetic-state>",
);
assert(values.mode === "timing" || values.mode === "allocation");
const project: typeof projectSessionActorAuthority = values.owner
  ? (await import(pathToFileURL(path.resolve(values.owner)).href)).projectSessionActorAuthority
  : projectSessionActorAuthority;
async function readState(): Promise<Pick<SessionActorHotState, "target" | "entry" | "writeToken">> {
  if (values.synthetic) {
    return {
      target: {
        sessionKey: values["session-key"],
        database: {
          kind: "file",
          physicalIdentity: "synthetic-team-shaped-database",
          birthtime: "1",
          nativeLocation: "/synthetic/agent.sqlite",
        },
      },
      writeToken: "synthetic-entry-revision-1",
      entry: {
        sessionId: "synthetic-team-shaped-session",
        updatedAt: 1,
        lifecycleRevision: "synthetic-lifecycle-1",
        activeWriterRunId: "synthetic-run-1",
        skillsSnapshot: {
          prompt: "Synthetic skill instructions. ".repeat(1200).slice(0, 32 * 1024),
          skills: [],
        },
      },
    };
  }
  process.env.OPENCLAW_STATE_DIR = path.resolve(values["state-dir"]!);
  const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
    await import("../../src/state/openclaw-agent-db.js");
  const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
  const { readOpenClawAgentDatabaseIdentity } =
    await import("../../src/state/openclaw-agent-db-identity.js");
  const { createSessionActorFactory } =
    await import("../../src/config/sessions/session-actor-durable.js");
  try {
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
    try {
      const state = await actor.read({ assertCurrent() {}, authorize() {} });
      assert(state.entry?.skillsSnapshot, "Run mock-provider turns before this measurement");
      return state;
    } finally {
      await actor.release();
    }
  } finally {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
  }
}
const state = await readState();
const reference = { entry: state.entry, writeToken: state.writeToken };
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
  facts: { kind: "session-actor-admission", snapshot: project(state, reference) },
});
function send(verify = false) {
  port1.postMessage(envelope(), []);
  const reply = receiveMessageOnPort(port2);
  assert(reply);
  const snapshot: ReturnType<typeof projectSessionActorAuthority> = reply.message.facts.snapshot;
  let entry;
  if ("entryReference" in snapshot) {
    assert.equal(snapshot.entryReference, reference.writeToken);
    entry = reference.entry;
  } else {
    entry = snapshot.entry;
  }
  assert.equal(entry?.sessionId, state.entry?.sessionId);
  if (verify) {
    assert.deepEqual(
      { target: snapshot.target, entry },
      { target: state.target, entry: state.entry },
    );
  }
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
try {
  send(true);
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
      fixture: values.synthetic ? "synthetic-32k-skills-prompt" : "synthetic-gateway-row",
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
