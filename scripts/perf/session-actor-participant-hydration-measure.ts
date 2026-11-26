/**
 * Synthetic SQLite actor hydration; no Gateway or production state access.
 * Prepare once, then alternate fresh baseline/candidate processes against the same fixture:
 *   node --import ./scripts/tsx.mjs scripts/perf/session-actor-participant-hydration-measure.ts \
 *     --prepare-only --output <new-fixture-directory>
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-actor-participant-hydration-measure.ts \
 *     --fixture <fixture> --output <new-results> --participants 2 --iterations 3000 --mode timing
 * Repeat with --participants 32 and separately with --mode allocation. Allocation sampling
 * includes collected objects; its CPU/GC timings are diagnostic, never acceptance gates.
 * --baseline-dir replaces only files present beneath that root through the existing preload;
 * save src/config/sessions/session-actor-hydration.worker.ts there with its original relative path.
 * The fixture has 10,000 sessions and 64 active sessions per participant cohort. --snapshot writes
 * a post-window heap containing that cohort's hydrated states; raw snapshots stay local.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler, getHeapStatistics, serialize, writeHeapSnapshot } from "node:v8";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "prepare-only": { type: "boolean", default: false },
    fixture: { type: "string" },
    output: { type: "string" },
    "baseline-dir": { type: "string" },
    participants: { type: "string", default: "2" },
    iterations: { type: "string", default: "3000" },
    mode: { type: "string", default: "timing" },
    snapshot: { type: "boolean", default: false },
  },
});
assert(values.output, "--output must name a new directory");
assert(values["prepare-only"] !== Boolean(values.fixture), "Choose --prepare-only or --fixture");
const participants = Number(values.participants);
const iterations = Number(values.iterations);
assert(participants === 2 || participants === 32, "--participants must be 2 or 32");
assert(Number.isSafeInteger(iterations) && iterations >= 1000, "Use at least 1,000 iterations");
assert(values.mode === "timing" || values.mode === "allocation", "Unknown measurement mode");
const output = path.resolve(values.output);
const root = values.fixture ? path.resolve(values.fixture) : output;
const ownerSource = values["baseline-dir"]
  ? path.resolve(values["baseline-dir"], "src/config/sessions/session-actor-hydration.worker.ts")
  : fileURLToPath(
      new URL("../../src/config/sessions/session-actor-hydration.worker.ts", import.meta.url),
    );
// A missing overlay must fail instead of silently measuring the current owner as baseline.
const ownerSha256 = createHash("sha256").update(readFileSync(ownerSource)).digest("hex");
mkdirSync(output);
for (const directory of ["home", "tmp"]) {
  mkdirSync(path.join(output, directory));
}
process.env = {
  ...createGatewayBenchEnv(path.join(output, "home"), path.join(output, "config.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(output, "tmp"),
};
writeFileSync(path.join(output, "config.json"), JSON.stringify({ plugins: { enabled: false } }));
if (values["baseline-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["baseline-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const owner = await import("../../src/state/openclaw-agent-db.js");
const options = { agentId: "main", env: process.env };
const cohortSize = 64;
const key = (count: number, index: number) => `agent:main:participant-hydration-${count}-${index}`;
const sessionId = (count: number, index: number) => `participant-hydration-${count}-${index}`;

try {
  const database = owner.openOpenClawAgentDatabase(options);
  if (values["prepare-only"]) {
    const { writeSessionEntry } =
      await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
    const { recordSessionParticipantFromWorker } =
      await import("../../src/config/sessions/session-accessor.sqlite-participants.native.js");
    owner.runOpenClawAgentWriteTransaction(() => {
      for (let index = 0; index < 10_000; index++) {
        const count = index < cohortSize ? 2 : index < cohortSize * 2 ? 32 : 0;
        const slot = count === 32 ? index - cohortSize : index;
        const sessionKey = key(count, slot);
        const id = sessionId(count, slot);
        writeSessionEntry(database, sessionKey, {
          sessionId: id,
          updatedAt: 1,
          label: `Synthetic session ${index}`,
          ...(count ? {} : { archivedAt: 2 }),
        });
        for (let participant = 0; participant < count; participant++) {
          recordSessionParticipantFromWorker(
            database,
            { agentId: "main", sessionKey, storePath: database.path },
            {
              identity: { type: "agent", id: `synthetic-peer-${participant}` },
              promptedAt: participant + 1,
            },
          );
        }
      }
    }, options);
    console.log(
      JSON.stringify({ fixture: root, sessions: 10_000, cohortSize, participants: [2, 32] }),
    );
  } else {
    assert(typeof globalThis.gc === "function", "Run measurements with --expose-gc");
    const { readOpenClawAgentDatabaseIdentity } =
      await import("../../src/state/openclaw-agent-db-identity.js");
    const { hydrateSessionActorState } =
      await import("../../src/config/sessions/session-actor-hydration.worker.js");
    const identity = readOpenClawAgentDatabaseIdentity(database);
    assert(typeof identity.identity === "string");
    const physicalIdentity = identity.identity;
    const targets = Array.from({ length: cohortSize }, (_, index) => ({
      sessionKey: key(participants, index),
      database: {
        kind: "file" as const,
        physicalIdentity,
        birthtime: identity.birthtime,
        nativeLocation: database.path,
      },
    }));
    const hydrate = (index: number) =>
      hydrateSessionActorState(
        database,
        targets[index % cohortSize]!,
        { epoch: "synthetic-hydration", sequence: 0 },
        "synthetic-hydration",
      );
    const digest = createHash("sha256");
    for (let index = 0; index < cohortSize; index++) {
      const state = hydrate(index);
      assert(state.hot.entry);
      assert.equal(state.hot.entry.sessionId, sessionId(participants, index));
      assert.equal(state.hot.participants.length, participants);
      assert.deepEqual(
        state.hot.entry.participants,
        state.hot.participants.map(({ identity: participant }) => ({ identity: participant })),
      );
      digest.update(JSON.stringify(state.hot));
    }
    for (let index = 0; index < 256; index++) {
      hydrate(index);
    }
    globalThis.gc();
    const inspector = values.mode === "allocation" ? new Session() : undefined;
    if (inspector) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 512,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const gc = new GCProfiler();
    gc.start();
    const hostLoad = { before: loadavg(), after: [] as number[] };
    const cpu = process.threadCpuUsage();
    const allocatedBefore = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
    const started = performance.now();
    let participantCount = 0;
    for (let index = 0; index < iterations; index++) {
      participantCount += hydrate(index).hot.participants.length;
    }
    const elapsedMs = performance.now() - started;
    const cpuUsage = process.threadCpuUsage(cpu);
    const allocatedAfter = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
    const gcProfile = gc.stop();
    hostLoad.after = loadavg();
    assert.equal(participantCount, iterations * participants);
    let allocatedBytes: number | undefined;
    if (inspector) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      inspector.disconnect();
      const sum = (node: typeof profile.head): number =>
        node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
      allocatedBytes = sum(profile.head);
      writeFileSync(path.join(output, "allocation.heapprofile"), JSON.stringify(profile));
    }
    globalThis.gc();
    const heapBeforeResidency = process.memoryUsage().heapUsed;
    const retained = targets.map((_, index) => hydrate(index));
    globalThis.gc();
    const heapAfterResidency = process.memoryUsage().heapUsed;
    const snapshot = values.snapshot
      ? writeHeapSnapshot(path.join(output, "hydrated.heapsnapshot"))
      : undefined;
    const result = {
      node: process.version,
      fixture: root,
      owner: values["baseline-dir"] ?? "current",
      ownerSha256,
      mode: values.mode,
      participants,
      iterations,
      cohortSize,
      snapshotDigest: digest.digest("hex"),
      elapsedMs,
      cpuMs: (cpuUsage.user + cpuUsage.system) / 1000,
      allocatedBytes,
      totalAllocatedBytes:
        typeof allocatedBefore === "number" && typeof allocatedAfter === "number"
          ? allocatedAfter - allocatedBefore
          : undefined,
      allocatedBytesPerHydration:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      hostLoad,
      gcProfile,
      heapBeforeResidency,
      heapAfterResidency,
      retainedSerializedBytes: serialize(retained).byteLength,
      snapshot,
    };
    writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    const { gcProfile: _gcProfile, ...summary } = result;
    console.log(JSON.stringify(summary));
  }
} finally {
  await owner.closeOpenClawAgentDatabasesAsync();
  const state = await import("../../src/state/openclaw-state-db.js");
  await state.closeOpenClawStateDatabaseAsync();
  const lifecycle = await import("../../src/shared/global-singleton.js");
  await lifecycle.drainGlobalSingletonLifecycleState();
}
