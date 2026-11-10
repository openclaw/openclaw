import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { readConfigFileSnapshotForWrite, registerConfigWriteListener } from "../config/config.js";
import * as fsSafe from "../infra/fs-safe.js";
import * as snapshots from "../infra/sqlite-readonly-worker.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { reconstructAgentDeletionJournal } from "../state/agent-deletion-journal-recovery.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { readAgentProvenance } from "../test-utils/agent-provenance.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createAgentTestState } from "./agent-create.integration.test-support.js";
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

async function createState(layout?: "state-only", scenario: "minimal" | "empty" = "minimal") {
  return await createAgentTestState("workspace-worker", { layout, scenario }, () => {
    vi.restoreAllMocks();
  });
}

function holdDuring(state: Awaited<ReturnType<typeof createState>>, stage: "root" | "read") {
  const root = fsSafe.root;
  let inserted = false;
  const insert = () => {
    if (!inserted) {
      inserted = true;
      addRecoveryHold("guarded", state.path("held.sqlite"));
    }
  };
  vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
    const handle = await root(...args);
    if (args[0] === state.workspaceDir) {
      if (stage === "root") {
        insert();
      } else {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
          const result = await read(...readArgs);
          if (readArgs[0] === DEFAULT_IDENTITY_FILENAME) {
            insert();
          }
          return result;
        });
      }
    }
    return handle;
  });
  return () => expect(inserted).toBe(true);
}

it("preserves IDENTITY.md when a recovery hold arrives during its awaited read", async () => {
  const state = await createState();
  const identityPath = path.join(state.workspaceDir, DEFAULT_IDENTITY_FILENAME);
  const original = "# Identity\n- **Name:** Kept\n";
  await fs.writeFile(identityPath, original);
  await ensureAgentWorkspace({ dir: state.workspaceDir, ensureBootstrapFiles: true });
  const configBefore = await state.readConfig();
  const expectHold = holdDuring(state, "read");
  const result = await createAgent({
    entry: { id: "guarded", identity: { name: "Replacement" } },
    workspace: state.workspaceDir,
  });
  expectHold();
  expect(result).toMatchObject({
    status: "error",
    reason: "already-exists",
    message: expect.stringContaining("held databases"),
  });
  expect(await fs.readFile(identityPath, "utf8")).toBe(original);
  expect(await state.readConfig()).toBe(configBefore);
});

it("refuses bootstrap publication when a recovery hold arrives during root preparation", async () => {
  const state = await createState();
  await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), "Synthetic instructions.\n");
  const expectHold = holdDuring(state, "root");
  await expect(
    ensureAgentWorkspace({
      dir: state.workspaceDir,
      ensureBootstrapFiles: true,
      guard: { recoveryHoldPredicate: { agentId: "guarded", held: [], applies: true } },
    }),
  ).rejects.toThrow("held databases");
  expectHold();
  expect(await fs.readdir(state.workspaceDir)).toEqual(["AGENTS.md"]);
});

it("records operator and agent creation provenance after roster commits", async () => {
  const state = await createState("state-only", "empty");
  const ensureWorkspace = ensureAgentWorkspace;
  const preparation = vi
    .spyOn(workspaceModule, "ensureAgentWorkspace")
    .mockImplementation(async (params) => {
      using snapshot = vi.spyOn(snapshots, "runSqliteReadOnlyWorkerSync").mockImplementation(() => {
        throw new Error("Workspace creation must not spawn synchronous SQLite snapshots");
      });

      const result = await ensureWorkspace(params);
      expect(snapshot).not.toHaveBeenCalled();
      return result;
    });
  let grants = 0;
  probe.admission(workerAdmission, (request, grant, admit) => {
    const sql = observeMainThreadSql();
    try {
      admit(request, grant);
      sql.expectIdle();
      grants++;
    } finally {
      sql.restore();
    }
  });
  const actors = [
    ["Operator Child", "operator-child", "operator", null],
    ["Agent Child", "agent-child", "agent", "main"],
  ] as const;
  for (const [name, agentId, createdVia, creatorAgentId] of actors) {
    await createAgent({
      name,
      workspace: state.path(agentId),
      ...(creatorAgentId ? { provenance: { createdVia, creatorAgentId } } : {}),
    });
  }
  for (const [, agentId, createdVia, creatorAgentId] of actors) {
    expect(readAgentProvenance(agentId, { env: state.env })).toMatchObject({
      agentId,
      createdVia,
      creatorAgentId,
      createdAtMs: expect.any(Number),
    });
  }
  expect(preparation).toHaveBeenCalled();
  expect(grants).toBeGreaterThan(0);
});

it("publishes guided staging atomically with env references preserved across preparation", async () => {
  const state = await createState("state-only");
  vi.stubEnv("GUIDED_STAGE_TOKEN", "synthetic-read-value");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const config = await state.readJsonConfig();
  await state.writeConfig({
    ...config,
    gateway: { ...config.gateway, auth: { mode: "token", token: "${GUIDED_STAGE_TOKEN}" } },
  });
  const writeSnapshot = await readConfigFileSnapshotForWrite();
  const staged = writeSnapshot.snapshot.sourceConfig;
  expect(staged.gateway?.auth?.token).toBe("synthetic-read-value");
  const workspace = state.path("guided-workspace");
  const agentDir = state.path("guided-agent");
  staged.agents = {
    ...staged.agents,
    entries: { ...staged.agents?.entries, guided: { workspace } },
  };
  staged.channels = { telegram: { enabled: true } };
  const publication = vi.fn();
  onTestFinished(registerConfigWriteListener(publication));
  await Promise.resolve();
  process.env.GUIDED_STAGE_TOKEN = "synthetic-after-guided-await";
  const created = await createAgent({
    entry: {
      id: "guided",
      name: "Guided",
      workspace,
      agentDir,
      model: "openai/gpt-5.5",
      identity: { name: "Guided", emoji: "🔎" },
    },
    stagedConfig: { config: staged, writeSnapshot },
    prepareConfigCommit: async () => {
      await Promise.resolve();
      process.env.GUIDED_STAGE_TOKEN = "synthetic-after-preparation";
    },
  });
  expect(created).toMatchObject({ status: "created", agentId: "guided", workspace, agentDir });
  expect(publication).toHaveBeenCalledOnce();
  const saved = await state.readJsonConfig();
  expect(saved).toMatchObject({
    gateway: { auth: { token: "${GUIDED_STAGE_TOKEN}" } },
    agents: { entries: { main: expect.any(Object), guided: { model: "openai/gpt-5.5" } } },
    channels: { telegram: { enabled: true } },
  });
  expect(saved.agents).not.toHaveProperty("list");
  expect(created).toHaveProperty("config", publication.mock.calls[0]?.[0]?.sourceConfig);
});

it("keeps a fresh named workspace pending through the first run setup", async () => {
  const state = await createState("state-only");
  const workspace = state.path("named-workspace");

  const created = await createAgent({ name: "Researcher", workspace });

  expect(created).toMatchObject({ status: "created", bootstrapPending: true });
  expect(await isWorkspaceBootstrapPending(workspace)).toBe(true);

  const firstRunWorkspace = await ensureAgentWorkspace({
    dir: workspace,
    ensureBootstrapFiles: true,
  });
  expect(firstRunWorkspace.bootstrapPending).toBe(true);
  expect(await isWorkspaceBootstrapPending(workspace)).toBe(true);
  expect(await fs.readFile(path.join(workspace, DEFAULT_IDENTITY_FILENAME), "utf8")).not.toContain(
    "Researcher",
  );
});

it.each(["default", "custom"] as const)(
  "prepares the %s agent database before publishing its roster entry",
  async (location) => {
    const state = await createState();
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
      // Capture physical identity at publication, before any later open.
      await expect(reader!.read()).resolves.toMatchObject({
        store: { status: "missing", reason: "row" },
        state: { status: "missing", reason: "row" },
        cacheable: true,
      });
    } finally {
      unsubscribe();
      await reader?.dispose();
    }
  },
);
