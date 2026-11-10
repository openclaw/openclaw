/**
 * Synthetic trajectory owner lifetime/allocation audit (not Gateway traffic).
 * Run: node --expose-gc --import ./scripts/tsx.mjs
 *   scripts/perf/trajectory-preparation-retention.ts --state-dir <isolated-dir>
 *   --phase pending|flushed --mode survivors|allocation|timing --recorders 64
 * For a baseline overlay, set OPENCLAW_BENCH_BASELINE_DIR and preload
 * ./scripts/perf/worker-retained-heap-preload.ts after the TSX preload. Preserve
 * the changed modules at their repository-relative paths; use an empty overlay
 * for the candidate. Alternate variants for five process samples per mode.
 * Survivor samples follow three forced GCs with recorder handles still live.
 * Allocation mode includes collected objects. Only untraced timing-mode CPU/GC
 * is timing evidence; its window includes fixture work and GC notification drain.
 * A separate --trace-gc-nvp --phase flushed pass marks capture through forced
 * GC for promotion context. Sampling stacks include helper allocations: zero
 * sampled survivors is not exhaustive reachability proof.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    phase: { type: "string", default: "pending" },
    recorders: { type: "string", default: "64" },
    mode: { type: "string", default: "survivors" },
    variant: { type: "string", default: "current" },
  },
});
assert(global.gc, "Use --expose-gc");
assert(values["state-dir"], "Use a new isolated --state-dir");
assert(["pending", "flushed"].includes(values.phase));
assert(["survivors", "allocation", "timing"].includes(values.mode));
const traced = process.execArgv.includes("--trace-gc-nvp");
assert(!traced || values.phase === "flushed", "Traced runs require --phase flushed");
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
function metadataFixture(index: number) {
  return {
    skills: {
      entries: Array.from({ length: 40 }, (_, skill) => ({
        name: `synthetic-${index}-skill-${skill}`,
        description: `Synthetic trajectory guidance ${skill}. `.repeat(12),
      })),
    },
    prompting: { skillsPrompt: "Synthetic skill catalog. ".repeat(400) },
  };
}
const warm = await makeRecorder("warmup");
warm.recordEvent("trace.metadata", metadataFixture(-1));
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
await nextTurn();
await nextTurn();
const heapBefore = process.memoryUsage().heapUsed;
const inspector = new Session();
if (values.mode !== "timing") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: values.mode === "allocation",
    includeObjectsCollectedByMinorGC: values.mode === "allocation",
  });
}
const inputs: WeakRef<object>[] = [];
function trackInput(value: unknown) {
  if (value && typeof value === "object") {
    inputs.push(new WeakRef(value));
    Object.values(value).forEach(trackInput);
  }
}
const expected = createHash("sha256");
function recordPreparations() {
  // A synchronous frame must return before GC; the module's await frame can
  // otherwise keep its final loop-local fixture alive independently of the sink.
  for (const [index, recorder] of recorders.entries()) {
    const metadata = metadataFixture(index);
    trackInput(metadata);
    expected.update(JSON.stringify(metadata));
    recorder.recordEvent("session.started", { toolCount: 40 });
    recorder.recordEvent("trace.metadata", metadata);
  }
}
const collections: Array<{ kind: number; duration: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
    collections.push({ kind: detail.kind, duration: entry.duration });
  }
});
if (traced) {
  console.log("trajectory-audit:work-start");
}
observer.observe({ entryTypes: ["gc"] });
const cpuBefore = process.cpuUsage();
const workStarted = performance.now();
recordPreparations();
await nextTurn();
await nextTurn();
observer.disconnect();
const workMs = performance.now() - workStarted;
const cpu = process.cpuUsage(cpuBefore);
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
const profile =
  values.mode === "timing"
    ? undefined
    : (await inspector.post("HeapProfiler.getSamplingProfile")).profile;
let sampledOwnerBytes = 0;
let sampledSerializationBytes = 0;
let sampledBrandingBytes = 0;
let ownerAllocationNodes = 0;
const runtimeUrl = new URL("../../src/trajectory/runtime.ts", import.meta.url).href;
const stringifyUrl = new URL("../../src/utils/safe-json.ts", import.meta.url).href;
function visit(
  node: NonNullable<typeof profile>["head"],
  inOwner = false,
  inPayload = false,
  inBranding = false,
) {
  // TSX reports the recordEvent arrow as anonymous; its source URL is stable.
  const owned = inOwner || node.callFrame.url === runtimeUrl;
  const payload = inPayload || (owned && node.callFrame.url === stringifyUrl);
  const branding =
    inBranding ||
    (owned &&
      ["createDiagnosticRecord", "createDiagnosticArray"].includes(node.callFrame.functionName));
  if (owned) {
    sampledOwnerBytes += node.selfSize;
    ownerAllocationNodes += Number(node.selfSize > 0);
  }
  if (payload) {
    sampledSerializationBytes += node.selfSize;
  }
  if (branding) {
    sampledBrandingBytes += node.selfSize;
  }
  for (const child of node.children) {
    visit(child, owned, payload, branding);
  }
}
if (profile) {
  visit(profile.head);
}
const survivingInputs = inputs.filter((input) => input.deref()).length;
assert.equal(survivingInputs, 0, "The recorder retained original preparation objects");
if (profile && values.phase === "pending") {
  assert(sampledSerializationBytes > 0, "Sampling did not observe the pending serialized payloads");
}
const observedPending = recorders.map((recorder) => recorder.describeFlushState());
if (profile) {
  await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
}
if (traced) {
  console.log("trajectory-audit:work-end");
}
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
for (const event of events.slice(1)) {
  if (event.type === "trace.metadata") {
    actual.update(JSON.stringify(event.data));
  }
}
const payloadHash = actual.digest("hex");
assert.equal(payloadHash, expected.digest("hex"));
console.log(
  JSON.stringify({
    node: process.version,
    mode: values.mode,
    variant: values.variant,
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
    sampledOwnerBytes: profile ? sampledOwnerBytes : undefined,
    sampledSerializationBytes: profile ? sampledSerializationBytes : undefined,
    sampledBrandingBytes: profile ? sampledBrandingBytes : undefined,
    ownerAllocationNodes,
    profileSamples: profile?.samples.length,
    workMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    gc: [...new Set(collections.map(({ kind }) => kind))].map((kind) => {
      const pauses = collections
        .filter((entry) => entry.kind === kind)
        .map((entry) => entry.duration);
      return {
        kind,
        count: pauses.length,
        totalMs: pauses.reduce((sum, duration) => sum + duration, 0),
        maxMs: Math.max(0, ...pauses),
      };
    }),
    heapDeltaBytes: observedHeap - heapBefore,
    payloadHash,
    scope: "Synthetic recorder/sink audit; retained handles and checked SQLite readback",
  }),
);
await closeOpenClawAgentDatabasesAsync();
await closeOpenClawStateDatabaseAsync();
