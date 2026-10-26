/**
 * Owner benchmark: initial recovery plus a second boot, real session persistence,
 * 10,000 retained rows, and synthetic terminal worker-placement/model responses.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/failed-placement-recovery-bench.ts \
 *   --state-dir "$PWD/.local/failed-placement-candidate" --iterations 2000
 * Repeat with --allocations (sampling distorts timing), and alternate base/candidate.
 * --owner selects a historical recoverStore module copied beside its original so
 * relative imports retain the same dependency revision; also pass
 * --expected-dispatches-per-session 1 for the pre-fix owner (candidate defaults to 0).
 * Acceptance: zero candidate dispatches, terminal status survives the second boot,
 * one candidate notice, and the saved answer remains available. Report CPU and
 * allocation per failed session, including both boots, without Gateway-wide claims.
 * Fixture creation, warmup, and outcome verification are outside measurements.
 * Idle dashboards are seeded already archived at the common fixture timestamp;
 * maintenance remains enabled, and exact archived/retained counts must stay fixed.
 * The placement observation is synthetic: this measures the recovery owner and
 * persistence, not placement lookup, Gateway RPC, providers, or a full restart.
 * The state directory must be fresh and is removed after owned databases close.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { hostname, loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { InternalSessionEntry as SessionEntry } from "../../src/config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../../src/gateway/server-instance-runtime.types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    owner: { type: "string" },
    retained: { type: "string", default: "10000" },
    iterations: { type: "string", default: "2000" },
    warmup: { type: "string", default: "16" },
    "expected-dispatches-per-session": { type: "string", default: "0" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "--state-dir must name a fresh synthetic state directory");
assert(global.gc, "Run with --expose-gc");
const integer = (key: "retained" | "iterations" | "warmup" | "expected-dispatches-per-session") =>
  parseStrictIntegerOption({ raw: values[key], label: `--${key}`, min: 0, fallback: 0 });
const retained = integer("retained");
const iterations = integer("iterations");
const warmup = integer("warmup");
const expectedDispatches = integer("expected-dispatches-per-session");
assert(iterations > 0 && retained >= iterations + warmup);
const stateDir = path.resolve(values["state-dir"]);
const ownerUrl = values.owner
  ? pathToFileURL(path.resolve(values.owner))
  : new URL(
      "../../src/agents/main-session-recovery/main-session-restart-recovery-store.ts",
      import.meta.url,
    );
const ownerSourceSha256 = createHash("sha256")
  .update(await readFile(ownerUrl))
  .digest("hex");
await mkdir(stateDir, { mode: 0o700 });
const syntheticEnv = {
  PATH: process.env.PATH,
  HOME: stateDir,
  OPENCLAW_HOME: stateDir,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  TMPDIR: stateDir,
};
for (const key of Object.keys(process.env)) {
  delete process.env[key];
}
Object.assign(process.env, syntheticEnv);

const inspector = new Session();
const { cleanupSessionStateForTest } =
  await import("../../src/test-utils/session-state-cleanup.js");
try {
  const { captureRuntimeConfigAsyncReader } = await import("../../src/config/io.js");
  await captureRuntimeConfigAsyncReader()();
  const { recoverStore } = (await import(
    ownerUrl.href
  )) as typeof import("../../src/agents/main-session-recovery/main-session-restart-recovery-store.js");
  const {
    replaceSessionEntry,
    applySessionEntryLifecycleMutation,
    loadSessionEntry,
    loadTranscriptEvents,
  } = await import("../../src/config/sessions/session-accessor.js");
  const { readSessionEntrySummariesInWorker } =
    await import("../../src/config/sessions/session-entry-read-runtime.js");
  const { mainSessionRecoveryLog } =
    await import("../../src/agents/main-session-recovery/main-session-restart-recovery-shared.js");
  // Recovery diagnostics remain enabled in normal operation; omit console/log IO
  // from this owner workload so the comparison measures work, not log sinks.
  mainSessionRecoveryLog.info = () => {};
  mainSessionRecoveryLog.warn = () => {};
  const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const reason = "Worker setup failed. Use Stop cloud worker to finish cleanup, then retry.";
  const savedAnswer = "Synthetic retained answer.";
  const fixtureAt = Date.now();
  const expectedRows = { retained, archived: retained - iterations - warmup };
  const row = (index: number) => ({
    sessionKey: `agent:main:dashboard:synthetic-${index}`,
    entry: {
      sessionId: `synthetic-session-${index}`,
      updatedAt: fixtureAt,
      status: index < iterations + warmup ? "failed" : "done",
      abortedLastRun: index < iterations + warmup,
      ...(index < iterations + warmup
        ? { pendingFinalDelivery: { kind: "replayable", text: savedAnswer, createdAt: fixtureAt } }
        : { archivedAt: fixtureAt, archiveReason: "manual" }),
    } satisfies SessionEntry,
  });
  const first = row(0);
  await replaceSessionEntry(
    { agentId: "main", storePath, sessionKey: first.sessionKey },
    first.entry,
  );
  for (let offset = 1; offset < retained; offset += 100) {
    const replacements = Array.from({ length: Math.min(100, retained - offset) }, (_, index) =>
      row(offset + index),
    );
    await applySessionEntryLifecycleMutation({
      agentId: "main",
      storePath,
      skipMaintenance: true,
      upserts: replacements,
    });
  }
  let dispatches = 0;
  let placementObservations = 0;
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected recovery effect");
  };
  const gatewayRuntime: GatewayRecoveryRuntime = {
    prepareRestartRecovery: () => undefined,
    prepareFailedWorkerPlacement: async () => {
      placementObservations++;
      return { reason, isCurrent: () => true, release: () => {} };
    },
    dispatchAgent: async <T>() => {
      dispatches++;
      return { status: "error", error: "Worker turn rejected in placement failed" } as T;
    },
    dispatchSessionMethod: unexpected,
    waitForAgent: unexpected,
    sendRecoveryNotice: unexpected,
    resumeChatInput: unexpected,
  };
  const read = () => readSessionEntrySummariesInWorker({ agentId: "main", storePath });
  const recover = (preparedEntries: Awaited<ReturnType<typeof read>>) =>
    recoverStore({
      storeAgentId: "main",
      storePath,
      stateDir,
      gatewayRuntime,
      preparedEntries,
      handledSessionKeys: new Set(),
    });
  const countRows = (entries: Awaited<ReturnType<typeof read>>) => ({
    retained: entries.length,
    archived: entries.filter(({ entry }) => entry.archivedAt !== undefined).length,
  });
  const seededRows = countRows(await read());
  assert.deepEqual(seededRows, expectedRows, "fixture must persist the complete archived shape");
  if (warmup) {
    await recover(
      (await read()).filter(({ sessionKey }) => Number(sessionKey.split("-").at(-1)) < warmup),
    );
  }
  const warmedRows = countRows(await read());
  assert.deepEqual(warmedRows, expectedRows, "warmup must preserve the archived fixture shape");
  global.gc();
  dispatches = placementObservations = 0;
  const memoryBefore = process.memoryUsage();
  const loadBefore = loadavg();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuBefore = process.threadCpuUsage();
  const processCpuBefore = process.cpuUsage();
  const started = performance.now();
  const firstBoot = await recover(await read());
  const firstBootDispatches = dispatches;
  const secondBoot = await recover(await read());
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  const processCpu = process.cpuUsage(processCpuBefore);
  const memoryAfter = process.memoryUsage();
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
  const allocatedBytes = profile ? allocated(profile.head) : undefined;
  const settledRows = countRows(await read());
  assert.deepEqual(
    settledRows,
    expectedRows,
    "both recovery passes must preserve the archived fixture shape",
  );
  assert.equal(dispatches, iterations * expectedDispatches);
  assert.equal(dispatches, firstBootDispatches, "second boot must not dispatch again");
  assert.equal(firstBoot.failed, 0);
  assert.equal(secondBoot.failed, 0);
  const sample = row(warmup);
  const target = { agentId: "main", storePath, sessionKey: sample.sessionKey };
  const settled = loadSessionEntry(target);
  assert.equal(settled?.status, "failed");
  assert.equal(settled.abortedLastRun, false);
  const transcript = JSON.stringify(
    await loadTranscriptEvents({ ...target, sessionId: sample.entry.sessionId }),
  );
  assert(settled.pendingFinalDelivery?.kind === "replayable" || transcript.includes(savedAnswer));
  if (expectedDispatches === 0) {
    assert.equal(settled.pendingFinalDelivery, undefined, "failed recovery must not block Resume");
    assert(transcript.includes(savedAnswer), "saved answer must survive terminal settlement");
    assert.equal(transcript.split(reason).length, 2, "one persisted failure notice");
  }
  console.log(
    JSON.stringify({
      workload:
        "failed worker main recovery, two boots; synthetic placement/model; real persistence",
      ownerSourceSha256,
      host: hostname(),
      node: process.version,
      retained,
      fixtureAt,
      actualRows: {
        seeded: seededRows,
        warmed: warmedRows,
        settled: settledRows,
      },
      iterations,
      warmup,
      allocationSampling: values.allocations,
      dispatches,
      firstBootDispatches,
      placementObservations,
      firstBoot,
      secondBoot,
      elapsedMs,
      mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
      mainThreadCpuUsPerSession: (cpu.user + cpu.system) / iterations,
      processCpuMs: (processCpu.user + processCpu.system) / 1000,
      mainThreadAllocatedBytes: allocatedBytes,
      mainThreadAllocatedBytesPerSession:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      loadBefore,
      loadAfter: loadavg(),
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  inspector.disconnect();
  await cleanupSessionStateForTest({ stateDir });
  await rm(stateDir, { recursive: true });
}
