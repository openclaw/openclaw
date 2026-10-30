import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { mock, test } from "node:test";
import { isMainThread } from "node:worker_threads";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createDurableProcessStore,
  type DurableProcessRecord,
} from "./bash-durable-process-store.js";

assert.equal(isMainThread, true, "Durable process persistence requires the host writer broker");
const record: DurableProcessRecord = {
  id: "opaque-process-id",
  agentId: "main",
  sessionKey: "agent:main:test",
  sessionId: "owning-session-id",
  unitName: "openclaw-proc-0123456789abcdef.service",
  command: "exec",
  cwd: "/workspace",
  logPath: "/state/processes/opaque-process-id.log",
  startedAt: 100,
  notifyOnExit: true,
  notifyOnExitEmptySuccess: false,
  cleanupMs: 60_000,
  maxOutputChars: 30_000,
  cancellationRequested: false,
};

void test("upgrades an existing database on first use and reopens registry facts through the host broker", async () => {
  await withOpenClawTestState(
    { scenario: "empty", label: "durable-process-store" },
    async ({ env }) => {
      const absent = createDurableProcessStore({ env });
      assert.deepEqual(await absent.list(), []);
      assert.equal(fs.existsSync(`${env.OPENCLAW_STATE_DIR}/state/openclaw.sqlite`), false);
      // The manual published-driver cell supplies a closed candidate-Doctor database.
      const upgradeDatabase = process.argv[2];
      if (upgradeDatabase) {
        assert.equal(fs.existsSync(`${upgradeDatabase}-wal`), false);
        fs.mkdirSync(`${env.OPENCLAW_STATE_DIR}/state`, { recursive: true });
        fs.copyFileSync(
          upgradeDatabase,
          path.join(env.OPENCLAW_STATE_DIR!, "state/openclaw.sqlite"),
        );
      }
      const { path: databasePath, db } = openOpenClawStateDatabase({ env });
      assert.equal(
        db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'durable_background_processes'")
          .get(),
        undefined,
      );
      const metadataBefore = db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all();
      await closeOpenClawStateDatabaseAsync();
      const store = createDurableProcessStore({ env });
      assert.deepEqual(await store.list(), []);
      await store.upsert(record);
      const finished: DurableProcessRecord = {
        ...record,
        endedAt: 200,
        result: { reason: "exit", exitCode: 7, exitSignal: null, durationMs: 100 },
      };
      // Warm registry operations must stay in the workers, including retained prepared statements.
      const refuseHostSql = () => {
        throw new Error("Durable process persistence executed host SQL");
      };
      for (const method of ["prepare", "exec"] as const) {
        mock.method(DatabaseSync.prototype, method, refuseHostSql);
      }
      for (const method of ["get", "all", "run", "iterate"] as const) {
        mock.method(StatementSync.prototype, method, refuseHostSql);
      }
      try {
        assert.deepEqual(await store.list(), [record]);
        await store.upsert(finished);
        assert.deepEqual(await store.list(), [finished]);
      } finally {
        mock.restoreAll();
      }
      await assert.rejects(
        store.upsert({ ...finished, notificationSettled: true }, () => {
          throw new Error("process owner retired");
        }),
        /process owner retired/,
      );
      await closeOpenClawStateDatabaseAsync();
      {
        using inspection = new DatabaseSync(databasePath, { readOnly: true });
        assert.equal(
          inspection.prepare("PRAGMA user_version").get()?.user_version,
          OPENCLAW_STATE_SCHEMA_VERSION,
        );
        assert.deepEqual(
          inspection.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
          metadataBefore,
        );
        assert.equal(inspection.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
        assert.deepEqual(
          inspection
            .prepare("SELECT id, record_json FROM durable_background_processes")
            .all()
            .map((row) => Object.assign({}, row)),
          [{ id: record.id, record_json: JSON.stringify(finished) }],
        );
      }
      const restored = createDurableProcessStore({ env });
      assert.deepEqual(await restored.list(), [finished]);
      await restored.remove(record.id);
      assert.deepEqual(await restored.list(), []);
    },
  );
});
