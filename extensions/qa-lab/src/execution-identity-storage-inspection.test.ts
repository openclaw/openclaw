import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { inspectQaExecutionIdentityStorage } from "./execution-identity-storage-inspection.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { runQaSuiteScenarioDefinition, runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";
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

describe("inspectQaExecutionIdentityStorage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("awaits worker counts through the scenario flow without caller-thread SQLite", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qa-identity-counts-"));
    try {
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      const database = new DatabaseSync(databasePath);
      database.exec(`
        CREATE TABLE execution_identity_contexts (context_id TEXT PRIMARY KEY);
        CREATE TABLE execution_decision_facts (
          receipt_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          action_family TEXT NOT NULL,
          reason_code TEXT NOT NULL
        );
        INSERT INTO execution_identity_contexts VALUES ('context-1'), ('context-2');
        INSERT INTO execution_decision_facts VALUES
          ('receipt-1', 'run-1', 'message', 'message_suppressed_inbound_metadata_echo'),
          ('receipt-2', 'run-1', 'model-routing', 'model_route_selected');
      `);
      database.close();

      const nativeCalls = [
        vi.spyOn(DatabaseSync.prototype, "prepare"),
        vi.spyOn(DatabaseSync.prototype, "exec"),
        vi.spyOn(DatabaseSync.prototype, "close"),
        vi.spyOn(StatementSync.prototype, "get"),
        vi.spyOn(StatementSync.prototype, "all"),
        vi.spyOn(StatementSync.prototype, "iterate"),
        vi.spyOn(StatementSync.prototype, "run"),
      ];
      const calibration = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        calibration.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts").get(),
      ).toEqual({ count: 2 });
      calibration.close();
      expect(nativeCalls[0]).toHaveBeenCalledOnce();
      expect(nativeCalls[2]).toHaveBeenCalledOnce();
      expect(nativeCalls[3]).toHaveBeenCalledOnce();
      vi.clearAllMocks();

      const gateway = createGateway(stateDir);
      const scenario = makeQaSuiteTestScenario("execution-identity-worker-counts");
      scenario.execution.flow = {
        steps: [
          {
            name: "inspect isolated execution identity state",
            actions: [
              { set: "counts", value: { expr: "inspectQaExecutionIdentityStorage(env)" } },
              { assert: "counts.contextCount === 2 && counts.decisionCount === 2" },
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
        runScenario: runQaSuiteScenarioSteps,
        splitModelRef: () => null,
        formatErrorMessage: String,
        liveTurnTimeoutMs: () => 60_000,
        resolveQaLiveTurnTimeoutMs: () => 60_000,
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
      for (const nativeCall of nativeCalls) {
        expect(nativeCall).not.toHaveBeenCalled();
      }
    } finally {
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  it("returns zero without initializing absent audit tables", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qa-identity-empty-"));
    try {
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      new DatabaseSync(databasePath).close();
      await expect(
        inspectQaExecutionIdentityStorage({ gateway: createGateway(stateDir) }),
      ).resolves.toEqual({ contextCount: 0, decisionCount: 0 });
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all(),
        ).toEqual([]);
      } finally {
        database.close();
      }
    } finally {
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });

  it("rejects a missing database without creating state", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qa-identity-missing-"));
    try {
      await expect(
        inspectQaExecutionIdentityStorage({ gateway: createGateway(stateDir) }),
      ).rejects.toThrow();
      expect(await fs.readdir(stateDir)).toEqual([]);
    } finally {
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });
});
