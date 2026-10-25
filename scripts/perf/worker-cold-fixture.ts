// Offline setup only, before launching a Gateway against this synthetic fixture:
// node --import ./scripts/tsx.mjs scripts/perf/worker-cold-fixture.ts --state-dir .local/worker-base
// One native maintenance pass creates at most 128 genuine cold transcripts. The
// resulting worker-cold-summary.json lists current session keys for first/repeat
// chat.history reads. Start from a fresh team-shape fixture for each comparison.
// --resume verifies existing archive files and recovers a missing summary without archiving again.
import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Worker } from "node:worker_threads";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { DB } from "../../src/state/openclaw-agent-db.generated.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: { "state-dir": { type: "string" }, resume: { type: "boolean", default: false } },
});
assert(values["state-dir"], "--state-dir must identify an existing offline team-shape fixture");
const root = realpathSync(values["state-dir"]);
const fixture = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert.equal(fixture.format, "openclaw-team-shape-v1");
assert(fixture.sessionCount > 0, "the fixture must contain synthetic sessions");
const configPath = path.join(root, "openclaw.json");
const originalConfig = readFileSync(configPath, "utf8");
const config: OpenClawConfig = JSON.parse(originalConfig);
assert.deepEqual(Object.keys(config.agents?.entries ?? {}), ["main"]);
assert.equal(config.session?.store, undefined, "use the fixture's canonical agent database");
const previousEnv = process.env;
const nativeExits = new Set<Promise<void>>();
const trackNativeExit = (worker: Worker) => {
  const exited = new Promise<void>((resolve) => {
    worker.once("exit", () => resolve());
  });
  nativeExits.add(exited);
  void exited.then(() => nativeExits.delete(exited));
};
process.on("worker", trackNativeExit);
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_PROFILE: fixture.profile,
  OPENCLAW_SKIP_CHANNELS: "1",
  TMPDIR: path.join(root, "tmp"),
  TMP: path.join(root, "tmp"),
  TEMP: path.join(root, "tmp"),
  USERPROFILE: path.join(root, "home"),
  ...(previousEnv.DEVELOPER_DIR ? { DEVELOPER_DIR: previousEnv.DEVELOPER_DIR } : {}),
};

try {
  // Storage resolvers must first load after the synthetic environment is installed.
  const [
    agentDb,
    stateDb,
    readOnly,
    sql,
    cold,
    maintenance,
    workers,
    lifecycle,
    coldState,
    codec,
    compiler,
  ] = await Promise.all([
    import("../../src/state/openclaw-agent-db.js"),
    import("../../src/state/openclaw-state-db.js"),
    import("../../src/state/openclaw-agent-db-readonly.js"),
    import("../../src/infra/kysely-sync.js"),
    import("../../src/config/sessions/session-cold-storage.js"),
    import("../../src/commands/doctor-sqlite-maintenance-lock.js"),
    import("../../src/infra/worker-cpu.js"),
    import("../../src/shared/global-singleton.js"),
    import("../../src/config/sessions/session-cold-storage-state.js"),
    import("../../src/config/sessions/session-cold-storage-codec.js"),
    import("esbuild"),
  ]);
  const databaseOptions = { agentId: "main", env: process.env };
  const databasePath = agentDb.resolveOpenClawAgentSqlitePath(databaseOptions);
  const readCold = () => {
    const result = readOnly.withOpenClawAgentDatabaseReadOnly(({ db: native }) => {
      const rows = sql.executeSqliteQuerySync(
        native,
        sql
          .getNodeSqliteKysely<DB>(native)
          .selectFrom("session_transcript_cold_archives as cold")
          .innerJoin("session_windows as window", "window.session_id", "cold.session_id")
          .innerJoin("session_nodes as node", "node.session_key", "window.session_key")
          .select([
            "window.session_key as sessionKey",
            "cold.session_id as sessionId",
            "node.current_session_id as currentSessionId",
            "cold.event_count as eventCount",
            "cold.storage",
            "cold.archive_bytes as archiveBytes",
          ])
          .orderBy("cold.session_id"),
      ).rows;
      for (const row of rows) {
        const archive = coldState.readSessionColdTranscript(native, row.sessionId);
        assert(archive);
        codec.verifyPublishedSessionColdArchive(databasePath, archive);
      }
      return rows;
    }, databaseOptions);
    assert(result.found, "the synthetic agent database must already exist");
    return result.value;
  };
  const summary = await maintenance.withDoctorSqliteMaintenanceLock({
    env: process.env,
    operation: "prepare synthetic cold transcript workload",
    protectedPaths: [databasePath],
    run: async (authority) => {
      try {
        const existing = readCold();
        if (values.resume) {
          assert(existing.length > 0, "--resume requires existing cold archives");
        } else {
          assert.equal(existing.length, 0, "use --resume to verify existing cold archives");
        }
        const result = values.resume
          ? { archivedTranscripts: existing.length, externalizedTranscripts: 0 }
          : await cold.runSessionColdStorageMaintenance({
              config: {
                ...config,
                session: {
                  ...config.session,
                  maintenance: {
                    ...config.session?.maintenance,
                    // Warn mode disables unrelated deleted/reset archive retention pruning.
                    mode: "warn",
                    coldStorage: { enabled: true, afterDays: 0 },
                  },
                },
              },
              assertCurrent: () => authority.assertCurrent(),
            });
        authority.assertCurrent();
        const sessions = values.resume ? existing : readCold();
        assert(result.archivedTranscripts > 0 && result.archivedTranscripts <= 128);
        assert.equal(sessions.length, result.archivedTranscripts);
        assert.equal(result.externalizedTranscripts, 0);
        assert(sessions.every((row) => row.sessionId === row.currentSessionId));
        assert(sessions.every((row) => row.eventCount > 0 && row.storage === "file"));
        return {
          format: "openclaw-worker-cold-fixture-v1",
          ...result,
          sessionKeys: sessions.map((row) => row.sessionKey),
          sessions,
        };
      } finally {
        // Agent close drains registered readers; whole-state close retires their
        // retained pools. Archive operation promises already join native exit.
        try {
          await agentDb.closeOpenClawAgentDatabasesAsync(root);
        } finally {
          await stateDb.closeOpenClawStateDatabaseAsync();
        }
      }
    },
  });
  // Database closure may leave process-scoped native carriers/admission services warm.
  await lifecycle.drainGlobalSingletonLifecycleState("close");
  // Source loading also owns esbuild's synchronous-service Worker outside runtime pools.
  await compiler.stop();
  // State ownership requests heartbeat termination synchronously; join its native
  // exit after release instead of mistaking the pending exit event for a live owner.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(nativeExits),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const remaining = workers
            .getTrackedWorkerLifecycleSnapshot()
            .workerLifecycle.filter(
              (entry) => entry.started > entry.retired.reduce((sum, row) => sum + row.count, 0),
            )
            .map((entry) => entry.script);
          reject(new Error(`Owned workers did not exit after cleanup: ${remaining.join(", ")}`));
        }, 60_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(readFileSync(configPath, "utf8"), originalConfig, "fixture config changed");
  assert.equal(workers.getTrackedWorkerLifecycleSnapshot().workerCount, 0, "owned workers remain");
  const output = path.join(root, "worker-cold-summary.json");
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ output, archivedTranscripts: summary.archivedTranscripts }));
} finally {
  process.off("worker", trackNativeExit);
  process.env = previousEnv;
}
