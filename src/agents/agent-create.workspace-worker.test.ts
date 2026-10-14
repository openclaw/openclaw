import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readConfigFileSnapshotForWrite, registerConfigWriteListener } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as fsSafe from "../infra/fs-safe.js";
import * as snapshots from "../infra/sqlite-readonly-worker.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { reconstructAgentDeletionJournal } from "../state/agent-deletion-journal-recovery.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { readAgentProvenance } from "../test-utils/agent-provenance.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAgent } from "./agent-create.js";
import { prepareAgentAuthProfileRowsRead } from "./auth-profiles/sqlite-read.js";
import { resolveAuthProfileDatabasePath } from "./auth-profiles/sqlite.js";
import * as workspaceModule from "./workspace.js";
import {
  DEFAULT_IDENTITY_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceBootstrapPending,
} from "./workspace.js";

function addRecoveryHold(agentId: string, heldPath: string) {
  runOpenClawStateWriteTransaction((database) => {
    database.db.exec("DROP TABLE agent_deletion_journal");
    reconstructAgentDeletionJournal(database, [{ agentId, path: heldPath }]);
  });
}

it("preserves IDENTITY.md when a recovery hold arrives during its awaited read", async () => {
  const state = await createOpenClawTestState({ scenario: "minimal" });
  const identityPath = path.join(state.workspaceDir, DEFAULT_IDENTITY_FILENAME);
  const original = "# Identity\n- **Name:** Kept\n";
  let inserted = false;
  try {
    await fs.writeFile(identityPath, original);
    await ensureAgentWorkspace({ dir: state.workspaceDir, ensureBootstrapFiles: true });
    const configBefore = await fs.readFile(state.configPath, "utf8");
    const root = fsSafe.root;
    vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const handle = await root(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
        const result = await read(...readArgs);
        if (
          args[0] === state.workspaceDir &&
          readArgs[0] === DEFAULT_IDENTITY_FILENAME &&
          !inserted
        ) {
          inserted = true;
          addRecoveryHold("guarded", state.path("held.sqlite"));
        }
        return result;
      });
      return handle;
    });
    const result = await createAgent({
      entry: { id: "guarded", identity: { name: "Replacement" } },
      workspace: state.workspaceDir,
    });
    expect(inserted).toBe(true);
    expect(result).toMatchObject({
      status: "error",
      reason: "already-exists",
      message: expect.stringContaining("held databases"),
    });
    expect(await fs.readFile(identityPath, "utf8")).toBe(original);
    expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
  } finally {
    vi.restoreAllMocks();
    await state.cleanup();
  }
});

it("refuses bootstrap publication when a recovery hold arrives during root preparation", async () => {
  const state = await createOpenClawTestState({ scenario: "minimal" });
  let inserted = false;
  try {
    await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), "Synthetic instructions.\n");
    const root = fsSafe.root;
    vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const handle = await root(...args);
      if (args[0] === state.workspaceDir && !inserted) {
        inserted = true;
        addRecoveryHold("guarded", state.path("held.sqlite"));
      }
      return handle;
    });
    await expect(
      ensureAgentWorkspace({
        dir: state.workspaceDir,
        ensureBootstrapFiles: true,
        guard: { recoveryHoldPredicate: { agentId: "guarded", held: [], applies: true } },
      }),
    ).rejects.toThrow("held databases");
    expect(inserted).toBe(true);
    expect(await fs.readdir(state.workspaceDir)).toEqual(["AGENTS.md"]);
  } finally {
    vi.restoreAllMocks();
    await state.cleanup();
  }
});

it("records operator and agent creation provenance after roster commits", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "empty",
    label: "agent-creation-provenance",
  });
  const ensureWorkspace = ensureAgentWorkspace;
  const preparation = vi
    .spyOn(workspaceModule, "ensureAgentWorkspace")
    .mockImplementation(async (params) => {
      const snapshot = vi.spyOn(snapshots, "runSqliteReadOnlyWorkerSync").mockImplementation(() => {
        throw new Error("Workspace creation must not spawn synchronous SQLite snapshots");
      });
      try {
        const result = await ensureWorkspace(params);
        expect(snapshot).not.toHaveBeenCalled();
        return result;
      } finally {
        snapshot.mockRestore();
      }
    });
  let grants = 0;
  const spy = probe.admission(workerAdmission, (request, grant, admit) => {
    const sql = observeMainThreadSql();
    try {
      admit(request, grant);
      sql.expectIdle();
      grants++;
    } finally {
      sql.restore();
    }
  });
  try {
    await createAgent({ name: "Operator Child", workspace: state.path("operator-child") });
    await createAgent({
      name: "Agent Child",
      workspace: state.path("agent-child"),
      provenance: { createdVia: "agent", creatorAgentId: "main" },
    });

    expect(preparation).toHaveBeenCalled();
    expect(grants).toBeGreaterThan(0);
    expect(readAgentProvenance("operator-child", { env: state.env })).toMatchObject({
      agentId: "operator-child",
      createdVia: "operator",
      creatorAgentId: null,
      createdAtMs: expect.any(Number),
    });
    expect(readAgentProvenance("agent-child", { env: state.env })).toMatchObject({
      agentId: "agent-child",
      createdVia: "agent",
      creatorAgentId: "main",
      createdAtMs: expect.any(Number),
    });
  } finally {
    spy.mockRestore();
    preparation.mockRestore();
    await state.cleanup();
  }
});

it("preserves env references from guided staging when preparation changes the environment", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "minimal",
    label: "guided-stage-env",
  });
  const oldToken = process.env.GUIDED_STAGE_TOKEN;
  try {
    process.env.GUIDED_STAGE_TOKEN = "synthetic-read-value";
    const config = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
    await state.writeConfig({
      ...config,
      gateway: { ...config.gateway, auth: { mode: "token", token: "${GUIDED_STAGE_TOKEN}" } },
    });
    const writeSnapshot = await readConfigFileSnapshotForWrite();
    const staged = writeSnapshot.snapshot.sourceConfig;
    expect(staged.gateway?.auth?.token).toBe("synthetic-read-value");
    await Promise.resolve();
    process.env.GUIDED_STAGE_TOKEN = "synthetic-after-guided-await";
    const created = await createAgent({
      name: "guided",
      workspace: state.path("guided-workspace"),
      stagedConfig: { config: staged, writeSnapshot },
      prepareConfigCommit: async () => {
        await Promise.resolve();
        process.env.GUIDED_STAGE_TOKEN = "synthetic-after-preparation";
      },
    });
    expect(created).toMatchObject({ status: "created", agentId: "guided" });
    const saved = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
    expect(saved.gateway?.auth?.token).toBe("${GUIDED_STAGE_TOKEN}");
    expect(saved.agents?.entries?.guided).toBeDefined();
  } finally {
    if (oldToken === undefined) {
      delete process.env.GUIDED_STAGE_TOKEN;
    } else {
      process.env.GUIDED_STAGE_TOKEN = oldToken;
    }
    await state.cleanup();
  }
});

it("keeps a fresh named workspace pending through the first run setup", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "minimal",
    label: "named-agent-hatch",
  });
  const workspace = state.path("named-workspace");

  try {
    const created = await createAgent({ name: "Researcher", workspace });

    expect(created).toMatchObject({ status: "created", bootstrapPending: true });
    expect(await isWorkspaceBootstrapPending(workspace)).toBe(true);

    const firstRunWorkspace = await ensureAgentWorkspace({
      dir: workspace,
      ensureBootstrapFiles: true,
    });
    expect(firstRunWorkspace.bootstrapPending).toBe(true);
    expect(await isWorkspaceBootstrapPending(workspace)).toBe(true);
    expect(
      await fs.readFile(path.join(workspace, DEFAULT_IDENTITY_FILENAME), "utf8"),
    ).not.toContain("Researcher");
  } finally {
    await state.cleanup();
  }
});

it.each(["default", "custom"] as const)(
  "prepares the %s agent database before publishing its roster entry",
  async (location) => {
    const state = await createOpenClawTestState({
      scenario: "minimal",
      label: "agent-create-ready",
    });
    const agentDir = location === "custom" ? state.path("custom-agent") : state.agentDir("worker");
    let reader: ReturnType<typeof prepareAgentAuthProfileRowsRead> | undefined;
    const unsubscribe = registerConfigWriteListener((event) => {
      if (event.sourceConfig.agents?.entries?.worker) {
        reader = prepareAgentAuthProfileRowsRead({
          agentId: "worker",
          databasePath: resolveAuthProfileDatabasePath(agentDir),
          env: state.env,
        });
      }
    });
    try {
      expect(
        await createAgent({
          name: "worker",
          ...(location === "custom" ? { agentDir } : {}),
          workspace: state.path("worker"),
        }),
      ).toMatchObject({ status: "created" });
      expect(reader).toBeDefined();
      // The real runtime reader captures physical identity at publication, before any later open.
      await expect(reader!.read()).resolves.toMatchObject({
        store: { status: "missing", reason: "row" },
        state: { status: "missing", reason: "row" },
        cacheable: true,
      });
    } finally {
      unsubscribe();
      await reader?.dispose();
      await state.cleanup();
    }
  },
);
