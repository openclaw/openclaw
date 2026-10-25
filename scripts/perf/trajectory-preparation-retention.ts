/**
 * Synthetic trajectory owner lifetime audit (not Gateway traffic).
 * Run: node --expose-gc --import ./scripts/tsx.mjs
 *   scripts/perf/trajectory-preparation-retention.ts --state-dir <isolated-dir>
 *   --phase pending|flushed --recorders 64
 * Alternate phases for five samples each. Both execute identical recording and
 * persistence; only the forced-GC observation point changes. This compares
 * lifecycle phases on the same source, not baseline and candidate implementations.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    phase: { type: "string", default: "pending" },
    recorders: { type: "string", default: "64" },
  },
});
assert(global.gc, "Use --expose-gc");
assert(values["state-dir"], "Use a new isolated --state-dir");
assert(["pending", "flushed"].includes(values.phase));
const count = Number(values.recorders);
assert(Number.isSafeInteger(count) && count > 0);
const stateDir = path.resolve(values["state-dir"]);
assert(!fs.existsSync(stateDir), "Refusing to reuse existing state");
fs.mkdirSync(stateDir, { recursive: true });
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
});
const { replaceSessionEntry } = await import("../../src/config/sessions/session-accessor.js");
const { createTrajectoryRuntimeRecorder } = await import("../../src/trajectory/runtime.js");
const { loadSqliteTrajectoryRuntimeEvents } =
  await import("../../src/trajectory/runtime-store.sqlite.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const target = {
  agentId: "main",
  sessionId: "synthetic-trajectory",
  sessionKey: "agent:main:synthetic-trajectory",
  storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
};
await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
const makeRecorder = async (runId: string) => {
  const recorder = await createTrajectoryRuntimeRecorder({
    ...target,
    sessionTarget: target,
    runId,
    provider: "synthetic",
    modelId: "synthetic",
    workspaceDir: stateDir,
  });
  assert(recorder);
  return recorder;
};
const warm = await makeRecorder("warmup");
warm.recordEvent("session.started");
await warm.flush();
const recorders: Awaited<ReturnType<typeof makeRecorder>>[] = [];
for (let index = 0; index < count; index++) {
  recorders.push(await makeRecorder(`synthetic-${index}`));
}
async function collect() {
  for (let pass = 0; pass < 3; pass++) {
    await nextTurn();
    global.gc!();
  }
}
await collect();
const heapBefore = process.memoryUsage().heapUsed;
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024 });
const inputs: WeakRef<object>[] = [];
function trackInput(value: unknown) {
  if (value && typeof value === "object") {
    inputs.push(new WeakRef(value));
    Object.values(value).forEach(trackInput);
  }
}
const expected = createHash("sha256");
for (const [index, recorder] of recorders.entries()) {
  const metadata = {
    skills: {
      entries: Array.from({ length: 40 }, (_, skill) => ({
        name: `synthetic-${index}-skill-${skill}`,
        description: `Synthetic trajectory guidance ${skill}. `.repeat(12),
      })),
    },
    prompting: { skillsPrompt: "Synthetic skill catalog. ".repeat(400) },
  };
  trackInput(metadata);
  expected.update(JSON.stringify(metadata));
  recorder.recordEvent("session.started", { toolCount: 40 });
  recorder.recordEvent("trace.metadata", metadata);
}
const pending = recorders.map((recorder) => recorder.describeFlushState());
assert(pending.every((state) => state?.includes("pendingRows=2")));
const flush = async () => {
  for (const recorder of recorders) {
    await recorder.flush();
    assert.equal(recorder.describeFlushState(), undefined);
  }
};
if (values.phase === "flushed") {
  await flush();
}
await collect();
const observedHeap = process.memoryUsage().heapUsed;
const { profile } = await inspector.post("HeapProfiler.getSamplingProfile");
let sampledLiveOwnerBytes = 0;
let ownerAllocationNodes = 0;
function visit(node: typeof profile.head, inOwner = false) {
  const owned = inOwner || node.callFrame.functionName === "recordEvent";
  if (owned) {
    sampledLiveOwnerBytes += node.selfSize;
    ownerAllocationNodes += Number(node.selfSize > 0);
  }
  for (const child of node.children) {
    visit(child, owned);
  }
}
visit(profile.head);
const survivingInputs = inputs.filter((input) => input.deref()).length;
assert.equal(survivingInputs, 0, "The recorder retained original preparation objects");
if (values.phase === "pending") {
  assert(sampledLiveOwnerBytes > 0, "Sampling did not observe the pending payload owner");
} else {
  assert.equal(sampledLiveOwnerBytes, 0, "Recorded payload allocations survived successful flush");
}
const observedPending = recorders.map((recorder) => recorder.describeFlushState());
await inspector.post("HeapProfiler.stopSampling");
inspector.disconnect();
if (values.phase === "pending") {
  await flush();
}
const events = await loadSqliteTrajectoryRuntimeEvents(target);
assert.equal(events.length, 1 + count * 2);
const actual = createHash("sha256");
for (let index = 0; index < count; index++) {
  const pair = events.slice(1 + index * 2, 3 + index * 2);
  for (const [offset, event] of pair.entries()) {
    assert.equal(event.traceSchema, "openclaw-trajectory");
    assert.equal(event.schemaVersion, 1);
    assert.equal(event.traceId, target.sessionId);
    assert.equal(event.sessionId, target.sessionId);
    assert.equal(event.sessionKey, target.sessionKey);
    assert.equal(event.runId, `synthetic-${index}`);
    assert.equal(event.source, "runtime");
    assert.equal(event.provider, "synthetic");
    assert.equal(event.modelId, "synthetic");
    assert.equal(event.workspaceDir, stateDir);
    assert.equal(event.seq, offset + 1);
    assert.equal(event.sourceSeq, offset + 1);
    assert(Number.isFinite(Date.parse(event.ts)));
  }
  assert.equal(pair[0]?.type, "session.started");
  assert.deepEqual(pair[0]?.data, { toolCount: 40 });
  assert.equal(pair[1]?.type, "trace.metadata");
}
for (const event of events) {
  if (event.type === "trace.metadata") {
    actual.update(JSON.stringify(event.data));
  }
}
const payloadHash = actual.digest("hex");
assert.equal(payloadHash, expected.digest("hex"));
console.log(
  JSON.stringify({
    node: process.version,
    phase: values.phase,
    recorders: count,
    recordedEvents: count * 2,
    persistedEvents: events.length,
    queuedBytesBeforeFlush: pending.reduce(
      (sum, state) => sum + Number(state?.match(/queuedBytes=(\d+)/)?.[1]),
      0,
    ),
    queuedBytesAtObservation: observedPending.reduce(
      (sum, state) => sum + Number(state?.match(/queuedBytes=(\d+)/)?.[1] ?? 0),
      0,
    ),
    inputObjects: inputs.length,
    survivingInputs,
    sampledLiveOwnerBytes,
    ownerAllocationNodes,
    profileSamples: profile.samples.length,
    heapDeltaBytes: observedHeap - heapBefore,
    payloadHash,
    scope: "Same-source lifecycle observation; recorder handles retained through verification",
  }),
);
await closeOpenClawAgentDatabasesAsync();
await closeOpenClawStateDatabaseAsync();
