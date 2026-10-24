import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  inspectQaExecutionIdentityStorage,
  readNativeQaSubagentRuns,
} from "./execution-identity-storage-inspection.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { runQaSuiteScenarioDefinition } from "./suite-runtime-flow.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

function createGateway(stateDir: string) {
  return {
    baseUrl: "http://127.0.0.1:1",
    tempRoot: stateDir,
    workspaceDir: stateDir,
    runtimeEnv: { OPENCLAW_STATE_DIR: stateDir },
    call: async () => {
      throw new Error("unexpected Gateway call");
    },
  };
}

let stateDir: string;
let databasePath: string;
let gateway: ReturnType<typeof createGateway>;
beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qa-identity-"));
  databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  gateway = createGateway(stateDir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDir, { force: true, recursive: true });
});

async function withDatabase<T>(action: (db: DatabaseSync) => T, readOnly = false) {
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath, { readOnly });
  try {
    return action(db);
  } finally {
    db.close();
  }
}

describe("inspectQaExecutionIdentityStorage", () => {
  it("awaits worker counts through the scenario flow without caller-thread SQLite", async () => {
    await withDatabase((database) => {
      database.exec(`
        CREATE TABLE execution_identity_contexts (context_id TEXT PRIMARY KEY);
        CREATE TABLE execution_decision_facts (run_id TEXT, action_family TEXT, reason_code TEXT);
        INSERT INTO execution_identity_contexts VALUES ('context-1'), ('context-2');
        INSERT INTO execution_decision_facts VALUES
          ('run-1', 'message', 'message_suppressed_inbound_metadata_echo'),
          ('run-1', 'model-routing', 'model_route_selected');
      `);
      database.exec(
        "CREATE TABLE subagent_runs (payload_json TEXT NOT NULL, requester_session_key TEXT NOT NULL, created_at INTEGER NOT NULL)",
      );
      for (const requesterSessionKey of ["parent", "other-parent"]) {
        for (const privateCompletion of [false, true]) {
          const run = {
            runId: `${requesterSessionKey}-${privateCompletion ? "private" : "public"}`,
            childSessionKey: `${requesterSessionKey}-child`,
            requesterSessionKey,
            ...(privateCompletion ? { completionTarget: "parent" } : {}),
            execution: { status: "terminal", outcome: { status: "ok" } },
            delivery: { status: "not_required", disposition: "intentional_non_delivery" },
            task: "private fixture prompt must not be returned",
          };
          database
            .prepare("INSERT INTO subagent_runs VALUES (?, ?, ?)")
            .run(
              JSON.stringify(privateCompletion ? { parentCompletion: run } : run),
              requesterSessionKey,
              privateCompletion ? 2 : 1,
            );
        }
      }
    });

    const nativeCalls = [
      ...(["prepare", "exec", "close"] as const).map((name) =>
        vi.spyOn(DatabaseSync.prototype, name),
      ),
      ...(["get", "all", "iterate", "run"] as const).map((name) =>
        vi.spyOn(StatementSync.prototype, name),
      ),
    ];
    await withDatabase((db) => {
      expect(db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts").get()).toEqual(
        { count: 2 },
      );
    }, true);
    expect(nativeCalls.map((call) => call.mock.calls.length)).toEqual([1, 0, 1, 1, 0, 0, 0]);
    vi.clearAllMocks();

    const scenario = makeQaSuiteTestScenario("execution-identity-worker-counts");
    scenario.execution.flow = {
      steps: [
        {
          name: "inspect isolated execution identity state",
          actions: [
            { set: "counts", value: { expr: "inspectQaExecutionIdentityStorage(env)" } },
            { assert: "counts.contextCount === 2 && counts.decisionCount === 2" },
            { set: "runs", value: { expr: "readNativeQaSubagentRuns(env, 'parent')" } },
            {
              assert:
                "runs.length === 2 && runs[0].runId === 'parent-private' && runs[0].createdAt === 2 && runs[1].runId === 'parent-public' && runs[1].createdAt === 1 && runs.every(run => run.requesterSessionKey === 'parent' && run.childSessionKey === 'parent-child' && run.execution.outcome.status === 'ok' && run.delivery.disposition === 'intentional_non_delivery' && !('task' in run) && !('completionTarget' in run))",
            },
          ],
        },
      ],
    };
    const result = await runQaSuiteScenarioDefinition({
      env: {
        gateway,
        lab: {},
        webSessionIds: new Set(),
        transport: createQaChannelTransport(createQaBusState()),
        outputDir: stateDir,
        repoRoot: stateDir,
        providerMode: "mock-openai",
        primaryModel: "synthetic/model",
        alternateModel: "synthetic/model",
        mock: null,
        cfg: {},
      },
      scenario,
      constants: {
        imageUnderstandingPngBase64: "",
        imageUnderstandingLargePngBase64: "",
        imageUnderstandingValidPngBase64: "",
      },
    });
    expect(result).toMatchObject({ status: "pass" });
    expect(
      await inspectQaExecutionIdentityStorage(
        { gateway },
        {
          runId: "run-1",
          actionFamily: "message",
          reasonCode: "message_suppressed_inbound_metadata_echo",
        },
      ),
    ).toEqual({ contextCount: 2, decisionCount: 1 });
    expect(nativeCalls.map((call) => call.mock.calls)).toEqual([[], [], [], [], [], [], []]);

    await withDatabase((db) =>
      db.exec(`
          UPDATE subagent_runs
          SET payload_json = json_remove(payload_json, '$.parentCompletion.completionTarget')
          WHERE created_at = 2
        `),
    );
    await expect(readNativeQaSubagentRuns({ gateway }, "parent")).rejects.toThrow();
  });

  it("returns zero without initializing absent audit tables", async () => {
    await withDatabase(() => {});
    await expect(inspectQaExecutionIdentityStorage({ gateway })).resolves.toEqual({
      contextCount: 0,
      decisionCount: 0,
    });
    await expect(readNativeQaSubagentRuns({ gateway })).resolves.toEqual([]);
    await withDatabase((database) => {
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual(
        [],
      );
    }, true);
  });

  it("rejects a missing database without creating state", async () => {
    await expect(inspectQaExecutionIdentityStorage({ gateway })).rejects.toThrow();
    expect(await fs.readdir(stateDir)).toEqual([]);
  });
});
