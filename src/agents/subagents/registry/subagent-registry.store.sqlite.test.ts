// Subagent registry SQLite store tests cover canonical snapshot and exact-row persistence.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync, constants } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  readSubagentRun,
  loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentRunsForControllerFromSqlite,
  loadSubagentRegistryFromSqlite,
  loadSubagentSessionListRunsFromSqlite,
  loadSubagentRunsForSessionsFromSqlite,
  saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;

function createRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-one",
    childSessionKey: "agent:main:subagent:one",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "check sqlite persistence",
    cleanup: "keep",
    createdAt: 100,
    expectsCompletionMessage: true,
    execution: {
      status: "terminal",
      startedAt: 110,
      endedAt: 250,
      outcome: { status: "ok", startedAt: 110, endedAt: 250, elapsedMs: 140 },
    },
    completion: {
      required: true,
      resultText: "done",
      capturedAt: 260,
      terminalReply: { disposition: "visible", text: "done" },
    },
    delivery: {
      status: "pending",
      createdAt: 270,
      lastAttemptAt: 280,
      attemptCount: 2,
      lastError: "retry later",
      payload: {
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        childSessionKey: "agent:main:subagent:one",
        childRunId: "run-one",
        task: "check sqlite persistence",
        startedAt: 110,
        endedAt: 250,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
      },
    },
    ...overrides,
  };
}

// Frozen v2026.9.4 reader eligibility (3a9d69db306cd7f081e06254cb89c4bcc14a7107).
// Keep these guards independent of the current codec: downgrade must fail closed.
const EXECUTION_STATUSES = new Set("queued running interrupted terminal".split(" "));
const DELIVERY_STATUSES = new Set(
  "not_required pending in_progress delivered failed suspended discarded".split(" "),
);

function hasStateStatus(
  value: unknown,
  statuses: ReadonlySet<string>,
): value is Record<string, unknown> {
  return isRecord(value) && typeof value.status === "string" && statuses.has(value.status);
}

function isReleasedSubagentRunRecord(value: unknown): value is SubagentRunRecord {
  return (
    isRecord(value) &&
    hasStateStatus(value.execution, EXECUTION_STATUSES) &&
    isRecord(value.completion) &&
    typeof value.completion.required === "boolean" &&
    hasStateStatus(value.delivery, DELIVERY_STATUSES) &&
    !(
      "handoffLeaseId" in value.delivery ||
      "handoffLeasedAt" in value.delivery ||
      "handoffInjectedAt" in value.delivery
    )
  );
}

function releasedSubagentPayloadFilter() {
  return /* kysely-allow-raw: Keep projection eligibility identical to the full canonical payload parser. */ sql<boolean>`json_valid(payload_json)
    AND json_type(payload_json, '$.execution') = 'object'
    AND json_extract(payload_json, '$.execution.status')
      IN ('queued', 'running', 'interrupted', 'terminal')
    AND json_type(payload_json, '$.completion') = 'object'
    AND json_type(payload_json, '$.completion.required') IN ('true', 'false')
    AND json_type(payload_json, '$.delivery') = 'object'
    AND json_extract(payload_json, '$.delivery.status')
      IN (
        'not_required',
        'pending',
        'in_progress',
        'delivered',
        'failed',
        'suspended',
        'discarded'
      )
    AND json_type(payload_json, '$.delivery.handoffLeaseId') IS NULL
    AND json_type(payload_json, '$.delivery.handoffLeasedAt') IS NULL
    AND json_type(payload_json, '$.delivery.handoffInjectedAt') IS NULL`;
}

describe("subagent registry sqlite store", () => {
  let tempStateDir: string | null = null;

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-sqlite-"));
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
  });

  async function withTempStateEnv<T>(fn: () => Promise<T>): Promise<T> {
    if (!tempStateDir) {
      throw new Error("expected temp state dir");
    }
    return await withEnvAsync({ OPENCLAW_STATE_DIR: tempStateDir }, fn);
  }

  it.each([
    [
      "session-list",
      (keys: readonly string[]) => loadSubagentRunsForSessionsFromSqlite(keys, [], "session-list"),
    ],
    ["full", (keys: readonly string[]) => loadSubagentRunsForSessionsFromSqlite(keys, [], "full")],
  ] as const)(
    "keeps %s identity selection and records in one snapshot across an external move",
    async (_kind, read) => {
      await withTempStateEnv(async () => {
        const run = createRun({ model: "original-model" });
        saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
        const { db, path: databasePath } = openOpenClawStateDatabase();
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
    },
  );

  it.each(["pending", "in_progress", "delivered", "failed", "suspended"] as const)(
    "preserves private %s handoffs across every current reader and restart",
    async (status) => {
      await withTempStateEnv(async () => {
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
        run.delivery!.status = status;
        const publicRun = createRun({
          runId: "public-run",
          childSessionKey: "agent:main:subagent:public",
        });
        saveSubagentRegistryToSqlite(
          new Map([run, publicRun].map((entry) => [entry.runId, entry])),
        );
        const original = loadSubagentRegistryFromSqlite().get(run.runId)!;
        const stored = openOpenClawStateDatabase()
          .db.prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
          .get(run.runId) as { payload_json: string };
        expect(JSON.parse(stored.payload_json)).toEqual({ parentCompletion: original });
        expect(isReleasedSubagentRunRecord(JSON.parse(stored.payload_json))).toBe(false);
        closeOpenClawStateDatabaseForTest();
        const database = openOpenClawStateDatabase();
        expect(loadSubagentRegistryFromSqlite().get(run.runId)).toEqual(original);
        expect(readSubagentRun(database, run.runId)).toEqual(original);
        expect(loadSubagentRunsForChildSessionFromSqlite(run.childSessionKey)).toEqual([original]);
        expect(loadSubagentRunsForControllerFromSqlite("agent:main:controller")).toEqual([
          original,
        ]);
        expect(loadSubagentSessionListRunsFromSqlite().get(run.runId)).toMatchObject({
          runId: run.runId,
          execution: {
            status: "terminal",
            startedAt: 110,
            endedAt: 250,
            outcome: { status: "ok" },
          },
          delivery: { status },
        });
        expect([
          ...loadSubagentSessionListRunsFromSqlite(["agent:main:controller"]).values(),
        ]).toMatchObject([{ runId: run.runId, delivery: { status } }]);
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
    },
  );

  it("rejects malformed private envelopes identically in full and projected readers", async () => {
    await withTempStateEnv(async () => {
      const run = createRun();
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      for (const parentCompletion of [
        run,
        { ...run, completionTarget: "parent", delivery: { status: "invalid" } },
      ]) {
        const db = openOpenClawStateDatabase().db;
        db.prepare("UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?").run(
          JSON.stringify({ parentCompletion }),
          run.runId,
        );
        expect(loadSubagentRegistryFromSqlite().size).toBe(0);
        expect(loadSubagentSessionListRunsFromSqlite().size).toBe(0);
      }
    });
  });

  it("persists subagent runs in the shared sqlite state database", async () => {
    await withTempStateEnv(async () => {
      const run = createRun({
        requesterTurnRunId: "run-requester",
        requesterTurnYielded: true,
        retireAfterRequesterTurn: true,
        endedReason: "subagent-error",
        execution: {
          status: "terminal",
          startedAt: 110,
          endedAt: 250,
          outcome: { status: "error", error: "restart interrupted run", endedAt: 250 },
        },
        terminalOwner: "interrupted-recovery",
        completion: { required: true, resultText: null, capturedAt: 250 },
        requesterSettleWake: {
          status: "dispatching",
          attemptCount: 1,
          replayCount: 1,
          nextAttemptAt: 30_000,
          batchRunIds: ["run-one", "run-two"],
          requesterYieldBatch: true,
          afterRequesterYield: true,
          rearmGeneration: 3,
          lastError: "provider timeout",
          retireAfterSettle: true,
        },
      });

      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      const restored = loadSubagentRegistryFromSqlite();
      expect(restored.get(run.runId)).toMatchObject({
        runId: run.runId,
        childSessionKey: run.childSessionKey,
        requesterSessionKey: run.requesterSessionKey,
        task: run.task,
        requesterTurnRunId: "run-requester",
        requesterTurnYielded: true,
        retireAfterRequesterTurn: true,
        execution: run.execution,
        terminalOwner: "interrupted-recovery",
        completion: run.completion,
        delivery: run.delivery,
        requesterSettleWake: run.requesterSettleWake,
      });
      expect(await fs.stat(path.join(tempStateDir!, "state", "openclaw.sqlite"))).toBeTruthy();
      await expect(fs.stat(path.join(tempStateDir!, "subagents", "runs.json"))).rejects.toThrow();
    });
  });

  it("preserves requester-owned final receipts in the existing SQLite payload", async () => {
    await withTempStateEnv(async () => {
      const requesterVisibleFinal = {
        requesterTurnRunId: "run-requester",
        batchRunIds: ["run-one"],
      };
      const run = createRun({ delivery: { status: "delivered", requesterVisibleFinal } });

      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      closeOpenClawStateDatabaseForTest();

      expect(loadSubagentRegistryFromSqlite().get(run.runId)?.delivery).toMatchObject({
        status: "delivered",
        requesterVisibleFinal,
      });
    });
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
      name: "silent",
      terminalReply: { disposition: "silent" } as const,
      resultText: "NO_REPLY",
    },
    {
      name: "empty",
      terminalReply: { disposition: "empty" } as const,
      resultText: null,
    },
  ])(
    "restores $name terminal reply in completion and pending delivery after restart",
    async ({ name, terminalReply, resultText }) => {
      await withTempStateEnv(async () => {
        const runId = `run-restart-${name}`;
        const run = createRun({
          runId,
          childSessionKey: `agent:main:subagent:${name}`,
          completion: {
            required: true,
            resultText,
            capturedAt: 260,
            terminalReply,
          },
          delivery: {
            status: "pending",
            createdAt: 270,
            attemptCount: 0,
            payload: {
              requesterSessionKey: "agent:main:main",
              requesterDisplayKey: "main",
              childSessionKey: `agent:main:subagent:${name}`,
              childRunId: runId,
              task: "check terminal reply restart",
              startedAt: 110,
              endedAt: 250,
              outcome: { status: "ok" },
              expectsCompletionMessage: true,
              terminalReply,
            },
          },
        });

        saveSubagentRegistryToSqlite(new Map([[runId, run]]));
        closeOpenClawStateDatabaseForTest();

        const restored = loadSubagentRegistryFromSqlite().get(runId);
        expect(restored?.completion).toMatchObject({ terminalReply, resultText });
        expect(restored?.delivery).toMatchObject({
          status: "pending",
          payload: { terminalReply },
        });
      });
    },
  );

  it("uses save calls as whole-registry snapshots", async () => {
    await withTempStateEnv(async () => {
      const first = createRun({ runId: "run-one", childSessionKey: "agent:main:subagent:one" });
      const second = createRun({ runId: "run-two", childSessionKey: "agent:main:subagent:two" });

      saveSubagentRegistryToSqlite(
        new Map([
          [first.runId, first],
          [second.runId, second],
        ]),
      );
      saveSubagentRegistryToSqlite(new Map([[second.runId, second]]));

      expect([...loadSubagentRegistryFromSqlite().keys()]).toEqual(["run-two"]);
    });
  });

  it("promotes legacy retained results into canonical completion state once", async () => {
    await withTempStateEnv(async () => {
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
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      openOpenClawStateDatabase()
        .db.prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
        .run("2026.7.0");
      closeOpenClawStateDatabaseForTest();

      const restored = loadSubagentRegistryFromSqlite().get(run.runId);
      expect(restored?.completion).toMatchObject({
        resultText: "NO_REPLY",
        fallbackResultText: "legacy retained result",
      });
      expect(restored?.delivery?.payload).not.toHaveProperty("frozenResultText");
      expect(restored?.delivery?.payload).not.toHaveProperty("fallbackFrozenResultText");

      const stored = openOpenClawStateDatabase()
        .db.prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
        .get(run.runId) as { payload_json: string };
      const storedPayload = JSON.parse(stored.payload_json) as SubagentRunRecord;
      expect(storedPayload.completion).toMatchObject({
        required: true,
        resultText: "NO_REPLY",
        fallbackResultText: "legacy retained result",
      });
      expect(storedPayload.delivery?.payload).not.toHaveProperty("frozenResultText");
      expect(storedPayload.delivery?.payload).not.toHaveProperty("fallbackFrozenResultText");

      closeOpenClawStateDatabaseForTest();
      expect(loadSubagentRegistryFromSqlite().get(run.runId)?.completion).toMatchObject({
        resultText: "NO_REPLY",
        fallbackResultText: "legacy retained result",
      });
    });
  });

  it("loads a canonical lightweight session-list projection", async () => {
    await withTempStateEnv(async () => {
      const run = createRun({
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
          startedAt: 110,
          endedAt: 250,
          outcome: { status: "error", error: "full payload detail" },
        },
        delivery: {
          status: "suspended",
          suspendedAt: 275,
          suspendedReason: "expiry",
        },
        task: "x".repeat(8_192),
      });
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      expect(loadSubagentSessionListRunsFromSqlite().get(run.runId)).toEqual({
        runId: run.runId,
        swarmRunId: "stable-collector",
        childSessionKey: run.childSessionKey,
        requesterSessionKey: run.requesterSessionKey,
        model: "openai/gpt-5.6",
        generation: 3,
        createdAt: 100,
        execution: {
          status: "terminal",
          startedAt: 110,
          endedAt: 250,
          outcome: { status: "error" },
        },
        sessionStartedAt: 105,
        accumulatedRuntimeMs: 90,
        runTimeoutSeconds: 7_200,
        endedReason: "subagent-error",
        cleanupCompletedAt: 300,
        delivery: { status: "suspended", suspendedAt: 275 },
      });
    });
  });

  it("writes only named registry mutations", async () => {
    await withTempStateEnv(async () => {
      const first = createRun({ runId: "run-one", childSessionKey: "agent:main:subagent:one" });
      const removed = createRun({ runId: "run-two", childSessionKey: "agent:main:subagent:two" });
      const untouched = createRun({
        runId: "run-three",
        childSessionKey: "agent:main:subagent:three",
      });
      const runs = new Map([first, removed, untouched].map((run) => [run.runId, run] as const));
      saveSubagentRegistryToSqlite(runs);

      const { db } = openOpenClawStateDatabase();
      db.exec(`
        CREATE TEMP TABLE subagent_run_write_audit (
          action TEXT NOT NULL,
          run_id TEXT NOT NULL
        );
        CREATE TEMP TRIGGER subagent_run_audit_insert
        AFTER INSERT ON subagent_runs
        BEGIN
          INSERT INTO subagent_run_write_audit VALUES ('insert', NEW.run_id);
        END;
        CREATE TEMP TRIGGER subagent_run_audit_update
        AFTER UPDATE ON subagent_runs
        BEGIN
          INSERT INTO subagent_run_write_audit VALUES ('update', NEW.run_id);
        END;
        CREATE TEMP TRIGGER subagent_run_audit_delete
        AFTER DELETE ON subagent_runs
        BEGIN
          INSERT INTO subagent_run_write_audit VALUES ('delete', OLD.run_id);
        END;
      `);

      first.task = `updated task ${"x".repeat(1_024)}`;
      runs.delete(removed.runId);
      const writes = vi.spyOn(StatementSync.prototype, "run");
      let boundPayloadTextBytes = 0;
      try {
        saveSubagentRegistryChangesToSqlite(runs, [first.runId, removed.runId]);
        boundPayloadTextBytes = writes.mock.calls.flat().reduce<number>((bytes, value) => {
          return typeof value === "string" && value.includes(first.task)
            ? bytes + Buffer.byteLength(value)
            : bytes;
        }, 0);
      } finally {
        writes.mockRestore();
      }

      expect(
        db.prepare("SELECT action, run_id FROM subagent_run_write_audit ORDER BY rowid").all(),
      ).toEqual([
        { action: "update", run_id: first.runId },
        { action: "delete", run_id: removed.runId },
      ]);
      expect([...loadSubagentRegistryFromSqlite().entries()]).toMatchObject([
        [first.runId, { task: first.task }],
        [untouched.runId, { task: untouched.task }],
      ]);
      expect(boundPayloadTextBytes).toBeGreaterThan(Buffer.byteLength(first.task));
      // One payload copy plus room for normalization; rebinding it for UPDATE exceeds this.
      expect(boundPayloadTextBytes).toBeLessThanOrEqual(
        Buffer.byteLength(JSON.stringify(first)) + 256,
      );
    });
  });

  it("rejects writes outside the canonical nested state", async () => {
    await withTempStateEnv(async () => {
      const missingState = createRun({ execution: undefined });
      const retiredState = createRun();
      Object.assign(retiredState.delivery!, { handoffLeaseId: "lease-1" });
      const invalidStatus = createRun({
        execution: { status: "running\n" } as unknown as SubagentRunRecord["execution"],
      });

      for (const run of [missingState, retiredState, invalidStatus]) {
        expect(() => saveSubagentRegistryToSqlite(new Map([[run.runId, run]]))).toThrow(
          "subagent run is missing canonical nested state",
        );
      }
    });
  });

  it("preserves announcedAt for not_required delivery when completion was announced", async () => {
    await withTempStateEnv(async () => {
      const run = createRun({
        expectsCompletionMessage: false,
        completion: { required: false },
        delivery: { status: "not_required", announcedAt: 300 },
      });

      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      const restored = loadSubagentRegistryFromSqlite();
      const restoredRun = restored.get(run.runId)!;
      expect(restoredRun.delivery?.status).toBe("not_required");
      expect(restoredRun.delivery?.announcedAt).toBe(300);
      expect(restoredRun.delivery?.deliveredAt).toBeUndefined();
    });
  });

  it("repairs a tainted delivered status when completion is not required", async () => {
    await withTempStateEnv(async () => {
      const run = createRun({
        expectsCompletionMessage: false,
        completion: { required: false },
        delivery: { status: "not_required", announcedAt: 300 },
      });
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      const { db } = openOpenClawStateDatabase();
      const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
      executeSqliteQuerySync(
        db,
        stateDb
          .updateTable("subagent_runs")
          .set({
            payload_json: JSON.stringify({
              ...run,
              delivery: { status: "delivered", announcedAt: 300, deliveredAt: 300 },
            }),
          })
          .where("run_id", "=", run.runId),
      );

      const restoredRun = loadSubagentRegistryFromSqlite().get(run.runId)!;
      expect(restoredRun.delivery).toMatchObject({
        status: "not_required",
        announcedAt: 300,
        deliveredAt: 300,
      });
    });
  });

  it("does not read or delete the retired JSON registry at runtime", async () => {
    await withTempStateEnv(async () => {
      const legacyRun = createRun({
        runId: "legacy-run",
        childSessionKey: "agent:main:subagent:legacy",
        task: "retired legacy registry",
      });
      const registryPath = path.join(tempStateDir!, "subagents", "runs.json");
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(
        registryPath,
        `${JSON.stringify({ version: 2, runs: { [legacyRun.runId]: legacyRun } })}\n`,
        "utf8",
      );

      const restored = loadSubagentRegistryFromSqlite();

      expect(restored).toEqual(new Map());
      await expect(fs.stat(registryPath)).resolves.toBeTruthy();
      expect(
        openOpenClawStateDatabase().db.prepare("SELECT COUNT(*) AS count FROM subagent_runs").get(),
      ).toEqual({ count: 0 });
    });
  });

  it("ignores rows with retired flat delivery state", async () => {
    await withTempStateEnv(async () => {
      const run = createRun();
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      const { db } = openOpenClawStateDatabase();
      db.prepare("UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?").run(
        JSON.stringify({
          ...run,
          execution: undefined,
          completion: undefined,
          delivery: undefined,
          pendingFinalDelivery: true,
        }),
        run.runId,
      );

      expect(loadSubagentRegistryFromSqlite()).toEqual(new Map());
      expect(loadSubagentSessionListRunsFromSqlite()).toEqual(new Map());

      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      db.prepare("UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?").run(
        JSON.stringify({ ...run, delivery: "pending" }),
        run.runId,
      );
      expect(loadSubagentRegistryFromSqlite()).toEqual(new Map());
      expect(loadSubagentSessionListRunsFromSqlite()).toEqual(new Map());
    });
  });

  it("loads explicit controller rows and null-controller requester fallbacks", async () => {
    await withTempStateEnv(async () => {
      const explicit = createRun({
        runId: "explicit",
        controllerSessionKey: "agent:main:controller",
        requesterSessionKey: "agent:main:other",
      });
      const fallback = createRun({
        runId: "fallback",
        controllerSessionKey: undefined,
        requesterSessionKey: "agent:main:controller",
      });
      const emptyController = createRun({
        runId: "empty-controller",
        controllerSessionKey: "",
        requesterSessionKey: "agent:main:controller",
      });
      const paddedController = createRun({
        runId: "padded-controller",
        controllerSessionKey: " agent:main:controller ",
        requesterSessionKey: "agent:main:other",
      });
      const other = createRun({
        runId: "other",
        controllerSessionKey: "agent:main:other-controller",
        requesterSessionKey: "agent:main:controller",
      });
      saveSubagentRegistryToSqlite(
        new Map([
          [explicit.runId, explicit],
          [fallback.runId, fallback],
          [emptyController.runId, emptyController],
          [paddedController.runId, paddedController],
          [other.runId, other],
        ]),
      );

      expect(
        loadSubagentRunsForControllerFromSqlite("agent:main:controller").map((run) => run.runId),
      ).toEqual(["empty-controller", "explicit", "fallback", "padded-controller"]);
      expect(
        loadSubagentRunsForControllerFromSqlite("agent:main:controller").at(-1)
          ?.controllerSessionKey,
      ).toBe("agent:main:controller");
      expect(loadSubagentRunsForControllerFromSqlite("   ")).toEqual([]);
      expect([
        ...loadSubagentSessionListRunsFromSqlite([" agent:main:controller ", " "]).keys(),
      ]).toEqual(["empty-controller", "explicit", "fallback", "padded-controller"]);
      expect([
        ...loadSubagentSessionListRunsFromSqlite([
          "agent:main:controller",
          "agent:main:other-controller",
        ]).keys(),
      ]).toEqual(["empty-controller", "explicit", "fallback", "other", "padded-controller"]);
      expect(loadSubagentSessionListRunsFromSqlite(["   "])).toEqual(new Map());
    });
  });

  it("loads only the requested child session in deterministic storage order", async () => {
    await withTempStateEnv(async () => {
      const childSessionKey = "agent:main:subagent:restarted";
      const runs = [
        createRun({ runId: "legacy", childSessionKey, createdAt: 300, generation: 1 }),
        createRun({ runId: "latest", childSessionKey, createdAt: 100, generation: 2 }),
        createRun({ runId: "same-zulu", childSessionKey, createdAt: 200, generation: 2 }),
        createRun({ runId: "same-alpha", childSessionKey, createdAt: 200, generation: 2 }),
        createRun({ runId: "other", childSessionKey: "agent:main:subagent:other" }),
      ];
      saveSubagentRegistryToSqlite(new Map(runs.map((run) => [run.runId, run])));

      expect(
        loadSubagentRunsForChildSessionFromSqlite(childSessionKey).map((run) => run.runId),
      ).toEqual(["latest", "same-alpha", "same-zulu", "legacy"]);
      expect(loadSubagentRunsForChildSessionFromSqlite("   ")).toEqual([]);
    });
  });
});
