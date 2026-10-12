// Subagent registry SQLite store private-handoff cases: parentCompletion
// envelopes must stay invisible to every released reader and survive restart.
import { describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  isReleasedSubagentRunRecord,
  releasedSubagentPayloadFilter,
} from "./subagent-registry.store.released-reader.test-support.js";
import {
  loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentSessionListRunsFromSqlite,
  readSubagentRun,
} from "./subagent-registry.store.sqlite.js";
import {
  createRun,
  type SubagentRegistryDatabase,
  useTemporaryOpenClawStateDir,
} from "./subagent-registry.store.sqlite.test-support.js";

describe("subagent registry sqlite store private handoffs", () => {
  useTemporaryOpenClawStateDir();

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
    saveSubagentRegistryToSqlite(new Map([run, publicRun].map((entry) => [entry.runId, entry])));
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
    expect(loadSubagentRunsForChildSessionFromSqlite(run.childSessionKey, database)).toEqual([
      original,
    ]);
    expect(
      loadSubagentSessionListRunsFromSqlite(undefined, openOpenClawStateDatabase()).get(run.runId),
    ).toMatchObject({
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
      expect(
        loadSubagentSessionListRunsFromSqlite(undefined, openOpenClawStateDatabase()).size,
      ).toBe(0);
    }
  });
});
