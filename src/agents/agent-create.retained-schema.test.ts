import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import { readAgentDeletionRecoveryHoldsInWorker } from "../state/agent-deletion-journal.read.js";
import { completeDeletion } from "../state/agent-deletion-journal.test-support.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createAgentTestState,
  prepareRecoveryHolds,
} from "./agent-create.integration.test-support.js";
import { createAgent } from "./agent-create.js";

function acquireOwner(state: Awaited<ReturnType<typeof createAgentTestState>>) {
  return acquireGatewayStateOwner({
    databasePath: resolveOpenClawStateSqlitePath(state.env),
    payload: {
      pid: process.pid,
      role: "gateway",
      createdAt: new Date().toISOString(),
      configPath: state.configPath,
      processNamespace: readGatewayLockProcessNamespace(),
    },
  });
}

it("keeps current-schema held agents unavailable until explicit live restoration releases selected paths", async () => {
  const state = await createAgentTestState("live-held-admission");
  const heldPath = state.path("custom-held.sqlite");
  const cfg = {
    agents: {
      ownership: "explicit" as const,
      entries: { main: { workspace: state.workspaceDir }, retired: {}, kept: {} },
    },
    gateway: { mode: "local" as const },
    session: { store: heldPath },
  };
  await state.writeConfig(cfg);
  const recovery = await prepareRecoveryHolds(state, "retired", [
    { agentId: "retired", path: heldPath },
    { agentId: "retired", path: state.path("parked", "openclaw-agent.sqlite") },
    { agentId: "kept", path: path.join(state.agentDir("kept"), "openclaw-agent.sqlite") },
  ]);
  const owner = acquireOwner(state);
  try {
    await owner.run(async () => {
      await assertOpenClawDatabasesReady({
        env: state.env,
        config: cfg,
        operation: "gateway-startup",
      });
      expect(readAgentDatabaseAdmissionRefusal("retired", { env: state.env })).toMatchObject({
        code: "agent-database-held",
        paths: [recovery.held[0]!.path],
      });
      expect(readAgentDatabaseAdmissionRefusal("main", { env: state.env })?.code).toBe(
        "agent-database-held",
      );
      expect(() =>
        openOpenClawAgentDatabase({ agentId: "retired", path: heldPath, env: state.env }),
      ).toThrow("held for explicit restoration");
      expect(await recovery.readBytes()).toEqual(recovery.bytes);
      await expect(
        createAgent({ name: "retired", skipBootstrap: true, deferInitialization: true }),
      ).resolves.toMatchObject({ status: "existing" });
      expect(readAgentDatabaseAdmissionRefusal("retired", { env: state.env })).toBeUndefined();
      expect(readAgentDatabaseAdmissionRefusal("main", { env: state.env })).toBeUndefined();
      expect(recovery.readHolds()).toEqual(recovery.held.slice(1));
      expect(
        openOpenClawAgentDatabase({ agentId: "retired", path: heldPath, env: state.env }).path,
      ).toBe(recovery.held[0]!.path);
      expect(() => openOpenClawAgentDatabase({ agentId: "kept", env: state.env })).toThrow(
        "held for explicit restoration",
      );
      expect(readAgentDatabaseAdmissionRefusal("kept", { env: state.env })?.code).toBe(
        "agent-database-held",
      );
    });
  } finally {
    owner.release();
  }
});

it.each(["recovery-hold", "retained-deletion"] as const)(
  "migrates an explicitly restored %s before publishing runtime access",
  async (kind) => {
    const state = await createAgentTestState(`restore-schema-${kind}`);
    const agentId = "retired";
    const pathname = path.join(state.agentDir(agentId), "openclaw-agent.sqlite");
    const target = { agentId, path: pathname };
    await state.writeConfig({
      agents:
        kind === "recovery-hold"
          ? {
              ownership: "explicit",
              entries: { main: { workspace: state.workspaceDir }, retired: {} },
            }
          : { defaults: { workspace: state.workspaceDir } },
      gateway: { mode: "local" },
    });
    await prepareRecoveryHolds(state, agentId, [target]);
    const params = { name: agentId, skipBootstrap: true, deferInitialization: true as const };
    if (kind === "recovery-hold") {
      {
        using database = openNodeSqliteDatabase(pathname);
        database.exec("PRAGMA user_version=0; UPDATE schema_meta SET schema_version=0");
      }
      const unsupported = await fs.readFile(pathname);
      await expect(createAgent(params)).resolves.toMatchObject({ status: "error" });
      expect(await fs.readFile(pathname)).toEqual(unsupported);
      expect(await readAgentDeletionRecoveryHoldsInWorker()).toEqual([target]);
    }
    if (kind === "retained-deletion") {
      runOpenClawStateWriteTransaction((database) => {
        database.db.exec(
          "DELETE FROM migration_sources WHERE source_key = 'agent-deletion-journal-reconstruction'",
        );
      });
      completeDeletion(state, agentId, state.path("workspace-retired"));
    }
    {
      using database = openNodeSqliteDatabase(pathname);
      database.exec(
        "DROP TABLE agent_tool_usage; PRAGMA user_version=41; UPDATE schema_meta SET schema_version=41",
      );
    }
    const original = await fs.readFile(pathname);
    if (kind === "retained-deletion") {
      await expect(createAgent({ ...params, bootstrapFirstAgent: true })).resolves.toMatchObject({
        status: "error",
        message: expect.stringContaining("restore the preserved store explicitly"),
      });
      expect(await fs.readFile(pathname)).toEqual(original);
    }
    const owner = acquireOwner(state);
    try {
      await expect(owner.run(() => createAgent(params))).resolves.toMatchObject({
        status: "error",
        message: expect.stringContaining("Stop the Gateway"),
      });
      expect(await fs.readFile(pathname)).toEqual(original);
      expect(await state.readJsonConfig()).not.toHaveProperty("agents.entries.retired.name");
    } finally {
      owner.release();
    }
    await expect(createAgent(params)).resolves.toMatchObject({
      status: kind === "recovery-hold" ? "existing" : "created",
      agentId,
    });
    {
      using database = openNodeSqliteDatabase(pathname, { readOnly: true });
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 42 });
    }
    expect(await fs.readFile(pathname)).not.toEqual(original);
    expect(await readAgentDeletionRecoveryHoldsInWorker()).toEqual([]);
    expect(
      (await fs.readdir(path.dirname(pathname))).some(
        (name) => name.includes(".pre-startup-migration-") && name.endsWith(".scoped.bak"),
      ),
    ).toBe(true);
    expect(
      listSessionEntriesReadOnly({ agentId, env: state.env, storePath: pathname }),
    ).toMatchObject([
      { sessionKey: "agent:retired:main", entry: { sessionId: "preserved-retired" } },
    ]);
  },
);
