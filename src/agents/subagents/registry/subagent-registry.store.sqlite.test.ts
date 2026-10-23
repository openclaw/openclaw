// Subagent registry SQLite store tests cover canonical snapshot and exact-row persistence.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, constants } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sqliteQueries from "../../../infra/kysely-sync.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
} from "../../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { requireNativeSqliteDatabase } from "../../../test-utils/native-sqlite.js";
import {
  createSubagentStoreRunFixture as createRun,
  loadSubagentRegistryFromSqlite,
  persistRegistryFixture,
  saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForChildSession,
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForSessions,
  prepareSubagentSessionListReadCache,
} from "./subagent-registry-state.js";
import { bindSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "./subagent-registry.store.kernel.js";
import {
  isReleasedSubagentRunRecord,
  releasedSubagentPayloadFilter,
} from "./subagent-registry.store.released-reader.test-support.js";
import {
  loadSubagentMaintenanceRunsInDatabase,
  readSubagentRun,
  loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentSessionListRunsFromSqlite,
  loadSubagentRunsForSessionsInDatabase,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentDisplayStatus } from "./subagent-session-metrics.js";

type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;

function saveRuns(...runs: SubagentRunRecord[]) {
  saveSubagentRegistryToSqlite(new Map(runs.map((run) => [run.runId, run])));
}

function readCompact(keys?: string[]) {
  return loadSubagentSessionListRunsFromSqlite(keys, openOpenClawStateDatabase());
}

function readPayload(runId: string) {
  return openOpenClawStateDatabase()
    .db.prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
    .get(runId);
}

function writePayload(runId: string, payload: string) {
  openOpenClawStateDatabase()
    .db.prepare("UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?")
    .run(payload, runId);
}

describe("subagent registry sqlite store", () => {
  let tempStateDir: string | null = null;

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-sqlite-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempStateDir);
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
  });

  it("reads current maintenance rows in one statement without a transaction envelope", () => {
    const run = createRun();
    saveRuns(run);
    const database = openOpenClawStateDatabase();
    using transactionSql = vi.spyOn(database.db, "exec");
    const first = loadSubagentMaintenanceRunsInDatabase(database);
    expect([...first.keys()]).toEqual([run.runId]);
    expect(transactionSql).not.toHaveBeenCalled();
    saveRuns();
    const next = loadSubagentMaintenanceRunsInDatabase(database);
    expect(next.size).toBe(0);
  });

  it("reads unbound old-schema rows and rolls back first-use parent-store columns with registration", async () => {
    const legacy = createRun();
    saveRuns(legacy);
    const original = openOpenClawStateDatabase();
    closeOpenClawStateDatabaseForTest();
    await fs.rename(original.path, `${original.path}.template`);
    await fs.copyFile(`${original.path}.template`, original.path, fs.constants.COPYFILE_EXCL);
    const old = new DatabaseSync(original.path);
    try {
      for (const column of ["requester_store_path", "controller_store_path"]) {
        if (
          old
            .prepare("PRAGMA table_info(subagent_runs)")
            .all()
            .some((row) => row.name === column)
        ) {
          old.exec(`ALTER TABLE subagent_runs DROP COLUMN ${column}`);
        }
      }
    } finally {
      old.close();
    }
    // Legacy bytes represent a previous process, not this process's admitted file generation.
    const legacyPath = `${original.path}.legacy`;
    await fs.copyFile(original.path, legacyPath);
    await fs.rename(legacyPath, original.path);
    const current = openOpenClawStateDatabase();
    const version = current.db.prepare("PRAGMA user_version").get();
    const schema = current.db.prepare("PRAGMA schema_version").get();
    expect(loadSubagentRegistryFromSqlite().get(legacy.runId)?.requesterStorePath).toBeUndefined();
    expect(readCompact().get(legacy.runId)?.requesterStorePath).toBeUndefined();
    expect(current.db.prepare("PRAGMA schema_version").get()).toEqual(schema);

    const bound = createRun({
      runId: "bound-registration",
      requesterStorePath: path.join(tempStateDir!, "requester.sqlite"),
      controllerStorePath: path.join(tempStateDir!, "controller.sqlite"),
    });
    expect(() =>
      runOpenClawStateWriteTransaction((database) => {
        writeSubagentRunValuesInDatabase(database, [bindSubagentRunRecord(bound)], []);
        throw new Error("registration rolled back");
      }),
    ).toThrow("registration rolled back");
    expect(current.db.prepare("PRAGMA schema_version").get()).toEqual(schema);
    expect(loadSubagentRegistryFromSqlite().has(bound.runId)).toBe(false);

    saveSubagentRegistryChangesToSqlite(new Map([[bound.runId, bound]]), [bound.runId]);
    const stores = {
      requesterStorePath: bound.requesterStorePath,
      controllerStorePath: bound.controllerStorePath,
    };
    expect(loadSubagentRegistryFromSqlite().get(bound.runId)).toMatchObject(stores);
    expect(readCompact().get(bound.runId)).toMatchObject(stores);
    expect(loadSubagentRegistryFromSqlite().get(legacy.runId)?.requesterStorePath).toBeUndefined();
    const columns = current.db.prepare("PRAGMA table_info(subagent_runs)").all();
    for (const name of ["requester_store_path", "controller_store_path"]) {
      expect(columns.find((column) => column.name === name)).toMatchObject({
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      });
    }
    expect(current.db.prepare("PRAGMA user_version").get()).toEqual(version);
    const olderReader = new DatabaseSync(current.path, { readOnly: true });
    try {
      const row = olderReader
        .prepare(
          "SELECT run_id, child_session_key, controller_session_key, requester_session_key, created_at, payload_json FROM subagent_runs WHERE run_id = ?",
        )
        .get(bound.runId);
      expect(row?.run_id).toBe(bound.runId);
      expect(isReleasedSubagentRunRecord(JSON.parse(String(row?.payload_json)))).toBe(true);
      expect(olderReader.prepare("PRAGMA user_version").get()).toEqual(version);
    } finally {
      olderReader.close();
    }
  });

  it("reuses a complete compact tree with isolated full records and owner writes", async () => {
    await withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
      const run = createRun({ model: "original-model" });
      const keys = [run.requesterSessionKey];
      const readFull = async () =>
        (await getSubagentRunsSnapshotForChildSession(new Map(), run.childSessionKey)).get(
          run.runId,
        );
      const cached = () => getSubagentSessionListRunsSnapshotForSessions(new Map(), keys);
      const persist = (record?: SubagentRunRecord) =>
        persistRegistryFixture(new Map(record ? [[record.runId, record]] : []), [run.runId]);
      saveRuns(run);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const queries = vi.spyOn(sqliteQueries, "executeSqliteQuerySync");
      clearSubagentRunsReadCacheForTest();
      try {
        await prepareSubagentSessionListReadCache();
        queries.mockClear();
        const first = cached();
        expect(first.size).toBe(1);
        expect(queries).not.toHaveBeenCalled();
        expect(cached()).toEqual(first);
        expect(getSubagentSessionListRunsSnapshotForRead(new Map(), keys)).toEqual(first);
        expect(queries).not.toHaveBeenCalled();

        const replaced = { ...run, model: "updated-model" };
        persist(replaced);
        expect(await readFull()).toMatchObject({
          model: replaced.model,
          task: run.task,
          completion: run.completion,
          delivery: run.delivery,
        });
        queries.mockClear();
        clock.mockReturnValue(now + 60_000);
        const refreshed = cached();
        expect(refreshed.get(run.runId)?.model).toBe(replaced.model);
        expect(refreshed.get(run.runId)).not.toHaveProperty("task");
        expect(refreshed.get(run.runId)).not.toHaveProperty("completion");
        expect(queries).not.toHaveBeenCalled();

        const moved = { ...replaced, controllerSessionKey: "agent:main:other" };
        const live = new Map([[run.runId, moved]]);
        expect(getSubagentSessionListRunsSnapshotForRead(live, keys).size).toBe(0);
        expect(
          getSubagentSessionListRunsSnapshotForRead(live, [moved.controllerSessionKey]).get(
            run.runId,
          )?.model,
        ).toBe(replaced.model);

        const published = { ...replaced, model: "published-model" };
        persist(published);
        expect(cached().get(run.runId)?.model).toBe(published.model);
        expect((await readFull())?.task).toBe(run.task);
        expect(loadSubagentRegistryFromSqlite().get(run.runId)?.model).toBe(published.model);
        persist();
        expect(getSubagentSessionListRunsSnapshotForRead(new Map(), keys).size).toBe(0);
        expect(
          (await getSubagentRunsSnapshotForChildSession(new Map(), run.childSessionKey)).size,
        ).toBe(0);
        expect(loadSubagentRegistryFromSqlite().size).toBe(0);
      } finally {
        queries.mockRestore();
        clock.mockRestore();
        clearSubagentRunsReadCacheForTest();
      }
    });
  });

  it("keeps full identity selection and records in one snapshot across an external move", async () => {
    const run = createRun({ model: "original-model" });
    saveRuns(run);
    const database = openOpenClawStateDatabase();
    const { path: databasePath } = database;
    const db = requireNativeSqliteDatabase(database.db);
    const read = (keys: readonly string[]) =>
      loadSubagentRunsForSessionsInDatabase(database, keys, []);
    const writer = new DatabaseSync(databasePath);
    let moved = false;
    db.setAuthorizer((action, table, column) => {
      if (
        !moved &&
        action === constants.SQLITE_READ &&
        table === "subagent_runs" &&
        column === "payload_json"
      ) {
        moved = true;
        writer
          .prepare(
            "UPDATE subagent_runs SET requester_session_key = ?, payload_json = ? WHERE run_id = ?",
          )
          .run(
            "agent:main:other",
            JSON.stringify({ ...run, model: "replacement-model" }),
            run.runId,
          );
      }
      return constants.SQLITE_OK;
    });
    try {
      const before = read([run.requesterSessionKey]);
      expect(moved).toBe(true);
      expect(before.runs.get(run.runId)).toMatchObject({
        requesterSessionKey: run.requesterSessionKey,
        model: "original-model",
      });
      db.setAuthorizer(null);
      expect(read([run.requesterSessionKey]).runs.size).toBe(0);
      expect(read(["agent:main:other"]).runs.get(run.runId)?.model).toBe("replacement-model");
    } finally {
      db.setAuthorizer(null);
      writer.close();
    }
  });

  it("preserves private handoffs across every current reader and restart", async () => {
    const run = createRun({
      completionTarget: "parent",
      completionRequesterSessionId: "original-parent",
      controllerSessionKey: "agent:main:controller",
      requesterSettleWake: {
        status: "dispatching",
        attemptCount: 1,
        batchRunIds: ["run-one", "public-run"],
        requesterYieldBatch: true,
        rearmGeneration: 2,
        yieldedFinalDeliverable: true,
      },
      completion: {
        required: true,
        resultText: "private marker",
        fallbackResultText: "private fallback",
        terminalReply: {
          disposition: "visible",
          text: "private marker\nMEDIA:https://example.com/private.png",
        },
      },
    });
    run.delivery!.status = "suspended";
    const publicRun = createRun({
      runId: "public-run",
      childSessionKey: "agent:main:subagent:public",
    });
    saveRuns(run, publicRun);
    const original = loadSubagentRegistryFromSqlite().get(run.runId)!;
    expect(original.requesterSettleWake).toEqual(run.requesterSettleWake);
    const stored = readPayload(run.runId) as { payload_json: string };
    expect(JSON.parse(stored.payload_json)).toEqual({ parentCompletion: original });
    expect(isReleasedSubagentRunRecord(JSON.parse(stored.payload_json))).toBe(false);
    closeOpenClawStateDatabaseForTest();
    const database = openOpenClawStateDatabase();
    expect(loadSubagentRegistryFromSqlite().get(run.runId)).toEqual(original);
    expect(readSubagentRun(database, run.runId)).toEqual(original);
    expect(loadSubagentRunsForChildSessionFromSqlite(run.childSessionKey, database)).toEqual([
      original,
    ]);
    expect(readCompact().get(run.runId)).toMatchObject({
      runId: run.runId,
      execution: {
        status: "terminal",
        startedAt: 110,
        endedAt: 250,
        outcome: { status: "ok" },
      },
      delivery: { status: "suspended" },
    });
    expect([
      ...loadSubagentSessionListRunsFromSqlite(
        ["agent:main:controller"],
        openOpenClawStateDatabase(),
      ).values(),
    ]).toMatchObject([{ runId: run.runId, delivery: { status: "suspended" } }]);
    const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(database.db);
    const releasedRows = executeSqliteQuerySync(
      database.db,
      stateDb.selectFrom("subagent_runs").selectAll().where(releasedSubagentPayloadFilter()),
    ).rows;
    expect(releasedRows.map((row) => row.run_id)).toEqual([publicRun.runId]);
    // The released full reader feeds both mixed settle and nested summaries.
    const releasedRuns = new Map(
      releasedRows.flatMap((row) => {
        const payload: unknown = JSON.parse(row.payload_json);
        return isReleasedSubagentRunRecord(payload) ? [[row.run_id, payload] as const] : [];
      }),
    );
    expect(JSON.stringify([...releasedRuns.values()])).not.toContain("private marker");
    // An old full-snapshot write can discard the unavailable private feature;
    // it must never promote its nested payload into public completion state.
    saveSubagentRegistryToSqlite(releasedRuns);
    expect(loadSubagentRegistryFromSqlite().has(run.runId)).toBe(false);
    expect(loadSubagentRegistryFromSqlite().get(publicRun.runId)?.completion).toEqual(
      publicRun.completion,
    );
  });

  it("rejects malformed private envelopes identically in full and projected readers", async () => {
    const run = createRun();
    saveRuns(run);
    for (const parentCompletion of [
      run,
      { ...run, completionTarget: "parent", delivery: { status: "invalid" } },
    ]) {
      writePayload(run.runId, JSON.stringify({ parentCompletion }));
      expect(loadSubagentRegistryFromSqlite().size).toBe(0);
      expect(readCompact().size).toBe(0);
    }
  });

  it.each([
    {
      name: "visible",
      terminalReply: {
        disposition: "visible",
        text: "restart-visible",
        modelRouteChange: "Model route changed: requested/model → actual/model.",
      } as const,
      resultText: "restart-visible",
    },
    {
      name: "empty",
      terminalReply: { disposition: "empty" } as const,
      resultText: null,
    },
  ])(
    "restores $name terminal reply in completion and pending delivery after restart",
    async ({ terminalReply, resultText }) => {
      const base = createRun();
      const run = createRun({
        completion: { ...base.completion!, resultText, terminalReply },
        delivery: {
          status: "pending",
          payload: { ...base.delivery!.payload!, terminalReply },
        },
      });

      saveRuns(run);
      closeOpenClawStateDatabaseForTest();

      const restored = loadSubagentRegistryFromSqlite().get(run.runId);
      expect(restored?.completion).toMatchObject({ terminalReply, resultText });
      expect(restored?.delivery).toMatchObject({
        status: "pending",
        payload: { terminalReply },
      });
    },
  );

  it("preserves legacy retained results until Doctor promotes canonical completion state", async () => {
    const expectCanonical = (record: SubagentRunRecord | undefined) => {
      expect(record?.completion).toMatchObject({
        required: true,
        resultText: "NO_REPLY",
        fallbackResultText: "legacy retained result",
      });
      for (const field of ["frozenResultText", "fallbackFrozenResultText"]) {
        expect(record?.delivery?.payload).not.toHaveProperty(field);
      }
    };
    const run = createRun({
      completion: { required: true, resultText: "NO_REPLY" },
      delivery: {
        status: "suspended",
        suspendedAt: 300,
        suspendedReason: "permanent_failure",
        payload: {
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          childSessionKey: "agent:main:subagent:one",
          childRunId: "run-one",
          task: "check sqlite persistence",
          outcome: { status: "ok" },
          expectsCompletionMessage: true,
          frozenResultText: "NO_REPLY",
          fallbackFrozenResultText: "legacy retained result",
        } as NonNullable<SubagentRunRecord["delivery"]>["payload"] & {
          frozenResultText: string;
          fallbackFrozenResultText: string;
        },
      },
    });
    saveRuns(run);
    const before = readPayload(run.runId);
    openOpenClawStateDatabase()
      .db.prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
      .run("2026.7.0");
    closeOpenClawStateDatabaseForTest();

    expect(readPayload(run.runId)).toEqual(before);
    closeOpenClawStateDatabaseForTest();
    expect(repairOpenClawStateDatabaseSchema().warnings).toEqual([]);

    expectCanonical(loadSubagentRegistryFromSqlite().get(run.runId));
    const stored = readPayload(run.runId) as { payload_json: string };
    expectCanonical(JSON.parse(stored.payload_json));
    closeOpenClawStateDatabaseForTest();
    expectCanonical(loadSubagentRegistryFromSqlite().get(run.runId));
  });

  it("loads a canonical lightweight session-list projection", async () => {
    const projection = {
      runId: "run-one",
      childSessionKey: "agent:main:subagent:one",
      requesterSessionKey: "agent:main:main",
      createdAt: 100,
      childAgentId: "main",
      model: "openai/gpt-5.6",
      swarmRunId: "stable-collector",
      generation: 3,
      sessionStartedAt: 105,
      accumulatedRuntimeMs: 90,
      runTimeoutSeconds: 7_200,
      endedReason: "subagent-error",
      cleanupCompletedAt: 300,
      execution: {
        status: "terminal",
        interruptionReason: "gateway-restart",
        startedAt: 110,
        endedAt: 250,
        outcome: { status: "error" },
      },
      delivery: {
        status: "suspended",
        disposition: "intentional_non_delivery",
        suspendedAt: 275,
      },
    } as const;
    const run = createRun({
      ...projection,
      execution: {
        ...projection.execution,
        outcome: { status: "error", error: "full payload detail" },
      },
      delivery: { ...projection.delivery, suspendedReason: "expiry" },
      task: "x".repeat(8_192),
    });
    saveRuns(run);
    expect(readCompact().get(run.runId)).toEqual(projection);
  });

  it("uses the last duplicate JSON key: terminal then invalid", () => {
    for (const completionTarget of [undefined, "parent"] as const) {
      const run = createRun({ completionTarget });
      saveRuns(run);
      const original = bindSubagentRunRecord(run).payload_json;
      const payload = original
        .replace('"execution":{', '"execution":{"status":"terminal"},"execution":{')
        .replace('"status":"terminal","startedAt"', '"status":"invalid","startedAt"');
      writePayload(run.runId, payload);
      expect(loadSubagentRegistryFromSqlite().has(run.runId), "canonical row eligibility").toBe(
        false,
      );
      expect(readCompact().has(run.runId), "compact row eligibility").toBe(false);
    }
  });

  it("omits retained bodies from every duplicate parent envelope", () => {
    const marker = "retained-duplicate-body:" + "x".repeat(2_048);
    const run = createRun({
      completionTarget: "parent",
      task: marker,
      execution: { status: "terminal", outcome: { status: "ok", error: marker } },
      completion: { required: true, resultText: marker },
      delivery: { status: "pending", lastError: marker },
    });
    saveRuns(run);
    const payload = bindSubagentRunRecord(run)
      .payload_json.replace('"execution":', '"execution":{"status":"invalid"},"execution":')
      .replace('"completion":', '"completion":{"required":false},"completion":')
      .replace('"delivery":', '"delivery":{"status":"failed"},"delivery":')
      .replace(
        '"parentCompletion":',
        '"parentCompletion":{"completionTarget":"parent"},"parentCompletion":',
      );
    writePayload(run.runId, payload);
    expect(loadSubagentRegistryFromSqlite().get(run.runId)).toMatchObject({
      execution: { status: "terminal" },
      delivery: { status: "pending" },
    });
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(readCompact().get(run.runId)).toMatchObject({
        execution: { status: "terminal" },
        delivery: { status: "pending" },
      });
      expect(parse.mock.calls.some(([text]) => text.includes("retained-duplicate-body:"))).toBe(
        false,
      );
    } finally {
      parse.mockRestore();
    }
    expect(readPayload(run.runId)?.payload_json).toBe(payload);
  });

  it("retains yielded pause reason in cold compact parent reads", () => {
    const run = createRun({ pauseReason: "sessions_yield", completionTarget: "parent" });
    saveRuns(run);
    closeOpenClawStateDatabaseForTest();

    const compact = readCompact().get(run.runId);
    expect(compact?.pauseReason).toBe("sessions_yield");
    expect(resolveSubagentDisplayStatus(compact!)).toBe("waiting for external continuation");
  });

  it("rejects writes outside the canonical nested state", async () => {
    const missingState = createRun({ execution: undefined });
    const retiredState = createRun();
    Object.assign(retiredState.delivery!, { handoffLeaseId: "lease-1" });
    const invalidStatus = createRun({
      execution: { status: "running\n" } as unknown as SubagentRunRecord["execution"],
    });

    for (const run of [missingState, retiredState, invalidStatus]) {
      expect(() =>
        saveSubagentRegistryChangesToSqlite(new Map([[run.runId, run]]), [run.runId]),
      ).toThrow("subagent run is missing canonical nested state");
    }
  });

  it("repairs a tainted delivered status when completion is not required", async () => {
    const run = createRun({
      expectsCompletionMessage: false,
      completion: { required: false },
      delivery: { status: "not_required", announcedAt: 300 },
    });
    saveRuns(run);

    writePayload(
      run.runId,
      JSON.stringify({
        ...run,
        delivery: { status: "delivered", announcedAt: 300, deliveredAt: 300 },
      }),
    );

    const restoredRun = loadSubagentRegistryFromSqlite().get(run.runId)!;
    expect(restoredRun.delivery).toMatchObject({
      status: "not_required",
      announcedAt: 300,
      deliveredAt: 300,
    });
  });

  it("loads explicit controller rows and null-controller requester fallbacks", async () => {
    const controller = "agent:main:controller";
    const other = "agent:main:other";
    saveRuns(
      ...[
        ["explicit", controller, other],
        ["fallback", undefined, controller],
        ["empty-controller", "", controller],
        ["padded-controller", ` ${controller} `, other],
        ["other", "agent:main:other-controller", controller],
      ].map(([runId, controllerSessionKey, requesterSessionKey]) =>
        createRun({ runId, controllerSessionKey, requesterSessionKey }),
      ),
    );
    expect([...readCompact([` ${controller} `, " "]).keys()]).toEqual([
      "empty-controller",
      "explicit",
      "fallback",
      "padded-controller",
    ]);
    expect([...readCompact([controller, "agent:main:other-controller"]).keys()]).toEqual([
      "empty-controller",
      "explicit",
      "fallback",
      "other",
      "padded-controller",
    ]);
    expect(readCompact(["   "])).toEqual(new Map());
  });
});
