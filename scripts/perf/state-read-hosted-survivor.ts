/**
 * Linux/Node, one fresh process per sample. Use the same file on both revisions:
 * node --import ./scripts/tsx.mjs scripts/perf/state-read-hosted-survivor.ts reversed
 * Use "ordered" for the control. The post-burst checkpoint precedes 200 warm reads.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { stop as stopEsbuild } from "esbuild";
import { initializeGatewayResourceProfile } from "../../src/infra/gateway-resource-profile.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../src/infra/kysely-sync.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../src/infra/runtime-process-url.js";
import { claimsSharedHostSlot, createHostedWorker } from "../../src/infra/shared-worker-host.js";
import { getTrackedWorkerPoolSnapshot } from "../../src/infra/worker-cpu.js";
import { initializeWorkerMemoryBudget } from "../../src/infra/worker-memory-budget.js";
import {
  captureRetainedNativeWorkerSource,
  closeDefaultRetainedNativeWorkerSource,
} from "../../src/infra/worker-native-lifecycle.js";
import { drainGlobalSingletonLifecycleState } from "../../src/shared/global-singleton.js";
import { writeConfigMachineStateInDatabase } from "../../src/state/config-machine-state-write.js";
import { createStateReadPool } from "../../src/state/openclaw-state-read-pool.js";
import type { OpenClawStateReadReply } from "../../src/state/openclaw-state-read.types.js";

const order = process.argv[2];
assert(
  process.platform === "linux" && (order === "ordered" || order === "reversed"),
  "expected Linux and an ordered or reversed preparation",
);
const root = mkdtempSync(path.join(tmpdir(), "openclaw-reader-"));
const databasePath = path.join(root, "state.sqlite");
const db = new DatabaseSync(databasePath);
let updatedAtMs: number;
try {
  db.exec(
    "CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER)",
  );
  updatedAtMs = writeConfigMachineStateInDatabase(db, "nodeHost.config", 1);
} finally {
  clearNodeSqliteKyselyCacheForDatabase(db);
  db.close();
}
const request = {
  databasePath,
  location: databasePath,
  context: { environment: { OPENCLAW_STATE_DIR: root } },
  command: { type: "nodeHost.config" as const },
  checkFreshAdmission: false,
};
function check(reply: OpenClawStateReadReply) {
  assert(
    reply.ok &&
      reply.type === "nodeHost.config" &&
      reply.row?.updated_at_ms === updatedAtMs &&
      reply.row.value_json === "1",
  );
}
function meter() {
  const cpu = process.cpuUsage();
  const main = process.threadCpuUsage();
  const start = performance.now();
  return () => {
    const elapsedMs = performance.now() - start;
    const thread = process.threadCpuUsage(main);
    const total = process.cpuUsage(cpu);
    return {
      elapsedMs,
      mainCpuUs: thread.user + thread.system,
      processCpuUs: total.user + total.system,
    };
  };
}

initializeWorkerMemoryBudget(initializeGatewayResourceProfile({ profile: "lean" }), undefined);
const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
const sqlite = resolveRuntimeProcessEntrypointUrl("sqliteStore");
const url = resolveRuntimeProcessEntrypointUrl("stateRead");
assert(claimsSharedHostSlot(sqlite, "sqlite-store:agent"));
const sibling = createHostedWorker(sqlite, {}, { key: "sqlite-store:agent", ready: false });
const pool = createStateReadPool(url, source);
function census() {
  const rows = getTrackedWorkerPoolSnapshot().workerCensus;
  const host = rows.find((row) => row.kind === "shared-worker-host.worker.js");
  const fds = readdirSync("/proc/self/fd").filter((fd) => {
    try {
      return readlinkSync("/proc/self/fd/" + fd) === databasePath;
    } catch {
      return false;
    }
  }).length;
  return {
    physical: rows.reduce((total, row) => total + row.count, 0),
    dedicated: source.activeWorkerPaths().filter((p) => p?.includes("openclaw-state-read.worker"))
      .length,
    endpoints: host?.hostedEndpoints ?? 0,
    fds,
    rss: process.memoryUsage.rss(),
  };
}

const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
try {
  await once(sibling, "started");
  const setup = meter();
  const tasks = gates.map((gate) =>
    pool.run(async () => {
      await gate.promise;
      return request;
    }, {}),
  );
  const first = order === "ordered" ? 0 : 1;
  for (const index of [first, 1 - first]) {
    gates[index]!.resolve();
    check(await tasks[index]!);
  }
  const bothCompletedAt = performance.now();
  const setupTiming = setup();
  const both = census();
  assert.equal(both.dedicated, 1);
  assert.equal(both.endpoints, 2);
  const wait = meter();
  await delay(Math.max(0, bothCompletedAt + 32_000 - performance.now()));
  const idleTiming = wait();
  const checkpointMs = performance.now() - bothCompletedAt;
  const survivor = census();
  assert.equal(pool.getSnapshot().workers, 1);
  assert.equal(survivor.fds, both.fds - 1);
  assert.equal(survivor.dedicated + survivor.endpoints, 2);
  assert(!sibling.executionStopped);
  const latencies: number[] = [];
  const warm = meter();
  for (let i = 0; i < 200; i++) {
    const start = performance.now();
    check(await pool.run(request, {}));
    latencies.push(performance.now() - start);
  }
  const read = warm();
  latencies.sort((a, b) => a - b);
  assert.equal(pool.getSnapshot().workersCreated, 2);
  console.log(
    JSON.stringify({
      order,
      node: process.version,
      both,
      checkpointMs,
      survivor,
      setup: setupTiming,
      idle: idleTiming,
      read: {
        ...read,
        count: latencies.length,
        medianMs: (latencies[99]! + latencies[100]!) / 2,
        p95Ms: latencies[189]!,
      },
    }),
  );
} finally {
  for (const gate of gates) {
    gate.resolve();
  }
  const cleanup = meter();
  try {
    await pool.close();
  } finally {
    sibling.retiring("idle_timeout");
    try {
      await sibling.terminate();
    } finally {
      await closeDefaultRetainedNativeWorkerSource();
    }
  }
  const cost = cleanup();
  // The profile logged through the file worker; tsx also started esbuild's sync service.
  // Join these process-wide owners outside the measured reader teardown.
  await drainGlobalSingletonLifecycleState();
  await stopEsbuild();
  const deadline = performance.now() + 10_000;
  while (getTrackedWorkerPoolSnapshot().workerCount > 0 && performance.now() < deadline) {
    await delay(10);
  }
  const closed = census();
  rmSync(root, { recursive: true, force: true });
  assert.equal(closed.physical, 0);
  console.log(JSON.stringify({ cleanup: cost, closed }));
}
