import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { ensureOnboardingAgent } from "../commands/onboard-agent.js";
import {
  mutateConfigFileWithRetry,
  readConfigFileSnapshotForWrite,
  transformConfigFileWithRetry,
  withConfigMutationExclusive,
} from "../config/config.js";
import { migrateLegacyMainSessionKeys } from "../config/sessions/legacy-main-session-migration.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
import { readExactSessionEntryRowForCanonicalRepair } from "../config/sessions/session-accessor.sqlite-canonical-repair.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { createRetainedAgentDatabaseMatcher } from "../state/agent-deletion-discovery.js";
import {
  readAgentDeletionRecoveryHolds,
  reconstructAgentDeletionJournal,
} from "../state/agent-deletion-journal-recovery.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
  readAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import { readAgentProvenance } from "../state/agent-provenance.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { executeSystemAgentOperation } from "../system-agent/operations-execute.js";
import { createSystemAgentTestRuntime } from "../system-agent/system-agent.runtime.test-support.js";
import { nodeFilePath } from "../test-utils/node-file-path.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createAgent } from "./agent-create.js";
import { isAgentDeletionBlocked } from "./agent-lifecycle-registry.js";
import { resolveSharedAuthStorePath } from "./auth-profiles/path-resolve.js";
import { resolveAuthProfileDatabasePath } from "./auth-profiles/sqlite.js";
import { readWorkspaceStateSnapshot } from "./workspace-state-store.js";
import {
  DEFAULT_IDENTITY_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceBootstrapPending,
} from "./workspace.js";

async function prepareRecoveryHolds(
  state: OpenClawTestState,
  agentId: string,
  held = [
    { agentId, path: path.join(state.agentDir(agentId), "openclaw-agent.sqlite") },
    { agentId, path: state.path("parked", "openclaw-agent.sqlite") },
    { agentId: "kept", path: path.join(state.agentDir("kept"), "openclaw-agent.sqlite") },
  ],
) {
  for (const target of held) {
    runOpenClawAgentWriteTransaction(
      (database) =>
        writeSessionEntry(
          database,
          `agent:${target.agentId}:main`,
          {
            sessionId: `preserved-${target.agentId}`,
            updatedAt: 1,
          },
          { previousEntry: null },
        ),
      { ...target, env: state.env },
    );
  }
  closeOpenClawAgentDatabasesForTest();
  runOpenClawStateWriteTransaction(
    (database) => {
      database.db.exec("DROP TABLE agent_deletion_journal");
      reconstructAgentDeletionJournal(database, held);
    },
    { env: state.env },
  );
  return {
    held,
    bytes: await Promise.all(held.map((target) => fs.readFile(target.path))),
    readHolds: () => readAgentDeletionRecoveryHolds(openOpenClawStateDatabase({ env: state.env })),
  };
}

it("restores only the configured held store after explicit creation, never through bootstrap or retargeting", async () => {
  const state = await createOpenClawTestState({ scenario: "minimal", label: "held-agent-restore" });
  try {
    const cfg = {
      agents: { entries: { main: { workspace: state.workspaceDir, agentDir: state.agentDir() } } },
      gateway: { mode: "local" as const },
    };
    await state.writeConfig(cfg);
    const recovery = await prepareRecoveryHolds(state, "main");
    const aliasPath = state.path("held-hardlink.sqlite");
    await fs.link(recovery.held[0]!.path, aliasPath);
    expect(() =>
      openOpenClawAgentDatabase({ agentId: "alias", path: aliasPath, env: state.env }),
    ).toThrow("held after deletion journal reconstruction");
    const params = { name: "main", workspace: state.workspaceDir };
    expect(
      await createAgent({ ...params, agentDir: path.dirname(recovery.held[1]!.path) }),
    ).toMatchObject({
      status: "error",
      reason: "already-exists",
    });
    expect(recovery.readHolds()).toEqual(recovery.held);
    expect(await createAgent({ ...params, bootstrapMain: true })).toMatchObject({
      status: "existing",
    });
    expect(recovery.readHolds()).toEqual(recovery.held);
    expect(await createAgent({ ...params, bootstrapFirstAgent: true })).toMatchObject({
      status: "error",
      reason: "already-exists",
    });
    expect(recovery.readHolds()).toEqual(recovery.held);
    await expect(
      createAgent({
        ...params,
        beforePersistentApply: () => {
          throw new Error("restore authority closed");
        },
      }),
    ).rejects.toThrow("restore authority closed");
    expect(recovery.readHolds()).toEqual(recovery.held);

    expect(await createAgent(params)).toMatchObject({
      status: "existing",
      agentDir: state.agentDir(),
    });
    expect(recovery.readHolds()).toEqual(recovery.held.slice(1));
    const isHeld = createRetainedAgentDatabaseMatcher(state.env, () =>
      resolveConfiguredAgentDatabaseTargets(cfg, { env: state.env }),
    );
    expect(
      isHeld(resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env }), "main"),
    ).toBeFalsy();
    expect(await Promise.all(recovery.held.map((target) => fs.readFile(target.path)))).toEqual(
      recovery.bytes,
    );
    expect(readAgentDeletionJournal("main", { env: state.env })).toBeUndefined();
    expect(isAgentDeletionBlocked("main", { env: state.env })).toBe(false);
    expect(
      openOpenClawAgentDatabase({ agentId: "main", path: recovery.held[0]!.path, env: state.env })
        .path,
    ).toBe(recovery.held[0]!.path);
    expect(() =>
      openOpenClawAgentDatabase({ agentId: "main", path: recovery.held[1]!.path, env: state.env }),
    ).toThrow("held after deletion journal reconstruction");
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it("restores a held custom filename only after its session store configuration selects it", async () => {
  const state = await createOpenClawTestState({ scenario: "minimal", label: "held-custom-store" });
  try {
    const config = { agents: { entries: { ops: { workspace: state.workspaceDir } } } };
    await state.writeConfig(config);
    const target = { agentId: "restored", path: state.path("custom", "history.sqlite") };
    const recovery = await prepareRecoveryHolds(state, target.agentId, [target]);
    const originalConfig = await fs.readFile(state.configPath, "utf8");
    const params = {
      name: target.agentId,
      workspace: state.path("restored-workspace"),
      agentDir: path.dirname(target.path),
    };
    expect(await createAgent(params)).toMatchObject({
      status: "error",
      reason: "already-exists",
      message: expect.stringContaining("session.store"),
    });
    expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
    await expect(
      fs.stat(path.join(params.agentDir, "openclaw-agent.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await state.writeConfig({ ...config, session: { store: target.path } });
    expect(await createAgent(params)).toMatchObject({ status: "created", agentId: target.agentId });
    expect(recovery.readHolds()).toEqual([]);
    expect(await fs.readFile(target.path)).toEqual(recovery.bytes[0]);
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it.each(["missing", "un-authored"] as const)(
  "keeps custom retained history held when onboarding finds %s config",
  async (configState) => {
    const state = await createOpenClawTestState({ scenario: "minimal", label: "held-bootstrap" });
    try {
      const config = { gateway: { mode: "local" as const } };
      await state.writeConfig(config);
      await transformConfigFileWithRetry({
        transform: (current) => ({ nextConfig: current, result: undefined }),
      });
      const target = { agentId: "main", path: state.path("custom", "history.sqlite") };
      const recovery = await prepareRecoveryHolds(state, target.agentId, [target]);
      const originalConfig = await fs.readFile(state.configPath, "utf8");
      if (configState === "missing") {
        await fs.rm(state.configPath);
      }
      const workspace = state.path("onboarding-workspace");

      await expect(ensureOnboardingAgent({ config, workspace })).rejects.toThrow("held databases");
      expect(await createAgent({ name: "main", workspace, bootstrapMain: true })).toMatchObject(
        configState === "missing"
          ? {
              status: "error",
              reason: "already-exists",
              message: expect.stringContaining("held databases"),
            }
          : { status: "existing" },
      );

      if (configState === "missing") {
        await expect(fs.stat(state.configPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
      }
      await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(state.agentDir())).rejects.toMatchObject({ code: "ENOENT" });
      expect(recovery.readHolds()).toEqual([target]);
      expect(await fs.readFile(target.path)).toEqual(recovery.bytes[0]);
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  },
);

it.each(["bootstrap", "explicit"])(
  "rechecks current %s holds after staged preparation and rolls its receipt back",
  async (mode) => {
    const state = await createOpenClawTestState({
      scenario: "minimal",
      label: "late-bootstrap-hold",
    });
    try {
      await state.writeConfig({ gateway: { mode: "local" } });
      openOpenClawStateDatabase({ env: state.env });
      const originalConfig = await fs.readFile(state.configPath, "utf8");
      const target = {
        agentId: mode === "bootstrap" ? "main" : "restored",
        path: state.path("custom", "history.sqlite"),
      };
      const stagedFile = state.path("staged-effect");
      const commit = vi.fn();
      const rollback = vi.fn(async () => await fs.rm(stagedFile));
      let recovery: Awaited<ReturnType<typeof prepareRecoveryHolds>> | undefined;
      const result = await withOpenClawStateDatabaseReadSnapshot(
        () =>
          createAgent({
            name: target.agentId,
            workspace: state.path("prepared-workspace"),
            bootstrapFirstAgent: mode === "bootstrap",
            prepareConfigCommit: async () => {
              await fs.writeFile(stagedFile, "staged before publication");
              recovery = await prepareRecoveryHolds(state, target.agentId, [target]);
              return { commit, rollback };
            },
          }),
        { env: state.env },
      );

      expect(result).toMatchObject({
        status: "error",
        reason: "already-exists",
        message: expect.stringContaining("held databases"),
      });
      expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
      expect(rollback).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      await expect(fs.stat(stagedFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(state.agentDir(target.agentId))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(recovery?.readHolds()).toEqual([target]);
      expect(await fs.readFile(target.path)).toEqual(recovery?.bytes[0]);
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  },
);

it.each([
  "missing",
  "removed before publication",
  "replaced before publication",
  "replaced after publication",
])("retains the recovery hold when the preserved database is %s", async (change) => {
  const state = await createOpenClawTestState({ scenario: "minimal", label: "changed-held-store" });
  try {
    await state.writeConfig({
      agents: { entries: { ops: { workspace: state.workspaceDir } } },
    });
    const target = { agentId: "main", path: path.join(state.agentDir(), "openclaw-agent.sqlite") };
    const recovery = await prepareRecoveryHolds(state, target.agentId, [target]);
    const originalConfig = await fs.readFile(state.configPath, "utf8");
    const moved = state.path("preserved.sqlite");
    const replaceStore = async () => {
      await fs.rename(target.path, moved);
      if (change.startsWith("replaced")) {
        await fs.copyFile(moved, target.path);
      }
    };
    if (change === "missing") {
      await replaceStore();
    }
    const rollback = vi.fn();
    const result = await createAgent({
      name: "main",
      workspace: state.path("restored-workspace"),
      prepareConfigCommit: async () => {
        if (change.endsWith("before publication")) {
          await replaceStore();
        }
        return {
          rollback,
          commit: async () => {
            if (change.endsWith("after publication")) {
              await replaceStore();
            }
          },
        };
      },
    });
    expect(result).toMatchObject({ status: "error", reason: "already-exists" });
    expect(recovery.readHolds()).toEqual([target]);
    expect(await fs.readFile(moved)).toEqual(recovery.bytes[0]);
    if (change.endsWith("after publication")) {
      expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toHaveProperty(
        "agents.entries.main",
      );
      expect(rollback).not.toHaveBeenCalled();
    } else {
      expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
    }
    if (change.endsWith("before publication")) {
      expect(rollback).toHaveBeenCalledOnce();
    }
    if (!change.startsWith("replaced")) {
      await expect(fs.stat(target.path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it("keeps a restored main agent held until its new config entry is published", async () => {
  const state = await createOpenClawTestState({
    scenario: "minimal",
    label: "held-agent-publication",
  });
  try {
    await state.writeConfig({
      agents: { entries: { ops: { workspace: state.path("ops-workspace") } } },
      gateway: { mode: "local" },
    });
    const recovery = await prepareRecoveryHolds(state, "main");
    const params = { name: "main", workspace: state.path("restored-workspace") };
    const originalConfig = await fs.readFile(state.configPath, "utf8");
    await expect(
      createAgent({
        ...params,
        prepareConfigCommit: async () => {
          throw new Error("publication failed");
        },
      }),
    ).rejects.toThrow("publication failed");
    expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
    expect(recovery.readHolds()).toEqual(recovery.held);
    const created = await createAgent({
      ...params,
      onCommitted: (result) => {
        expect(result.config.agents?.entries?.main).toBeDefined();
        expect(recovery.readHolds()).toEqual(recovery.held);
      },
    });
    expect(created).toMatchObject({ status: "created", agentId: "main" });
    expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toHaveProperty(
      "agents.entries.main",
    );
    expect(recovery.readHolds()).toEqual(recovery.held.slice(1));
    expect(await Promise.all(recovery.held.map((target) => fs.readFile(target.path)))).toEqual(
      recovery.bytes,
    );
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it("does not create an agent after delegated authority closes while awaiting the config lock", async () => {
  const state = await createOpenClawTestState({
    scenario: "minimal",
    label: "agent-create-closed-authority",
  });
  const authority = claimAgentRunDelegatedAuthority({
    instanceId: "creation-instance",
    runId: "creation-run",
  });
  const lockEntered = createDeferred();
  const releaseLock = createDeferred();
  const creationEntered = createDeferred();
  const { runtime, lines } = createSystemAgentTestRuntime();
  const workspace = state.path("delegated-workspace");
  const originalConfig = await fs.readFile(state.configPath, "utf8");
  const lock = withConfigMutationExclusive(async () => {
    lockEntered.resolve();
    await releaseLock.promise;
  });
  let creation: Promise<unknown> | undefined;
  try {
    await lockEntered.promise;
    creation = executeSystemAgentOperation(
      { kind: "create-agent", agentId: "delegated", workspace, requesterAgentId: "main" },
      runtime,
      {
        approved: true,
        beforePersistentApply: () => {
          if (!validateAgentRunDelegatedAuthority(authority)) {
            throw new Error("system-agent approval authority is no longer active");
          }
          creationEntered.resolve();
        },
      },
    );
    const outcome = creation.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await creationEntered.promise;
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    releaseLock.resolve();
    await lock;

    expect.soft(await outcome).toMatchObject({
      error: new Error("system-agent approval authority is no longer active"),
    });
    expect.soft(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
    expect.soft(await fs.stat(workspace).catch(() => null)).toBeNull();
    expect.soft(await fs.stat(state.sessionsDir("delegated")).catch(() => null)).toBeNull();
    expect.soft(readAgentProvenance("delegated", { env: state.env })).toBeUndefined();
    expect.soft(lines).not.toContain("[openclaw] done: agents.create");
  } finally {
    releaseLock.resolve();
    await lock;
    await creation?.catch(() => undefined);
    releaseAgentRunDelegatedAuthority(authority);
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it.each(["workspace", "workspace-write", "config"] as const)(
  "stops delegated creation after authority closes during %s preparation",
  async (phase) => {
    const state = await createOpenClawTestState({
      scenario: "minimal",
      label: `agent-create-${phase}-authority`,
    });
    const authority = claimAgentRunDelegatedAuthority({
      instanceId: "preparation-instance",
      runId: "preparation-run",
    });
    const entered = createDeferred();
    const resume = createDeferred();
    const workspace = state.path("prepared-workspace");
    const stagedFile = state.path("staged-effect");
    const originalConfig = await fs.readFile(state.configPath, "utf8");
    const pause = async () => {
      entered.resolve();
      await resume.promise;
    };
    const realAccess = fs.access.bind(fs);
    const access = vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
      if (phase === "workspace" && file === path.join(workspace, "AGENTS.md")) {
        await pause();
      }
      return await realAccess(file, mode);
    });
    const realWrite = fs.writeFile.bind(fs);
    const write = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      await realWrite(file, data, options);
      const filePath = nodeFilePath(file);
      if (
        phase === "workspace-write" &&
        filePath &&
        path.basename(filePath) === "AGENTS.md" &&
        path.basename(path.dirname(filePath)).startsWith("openclaw-bootstrap-")
      ) {
        await pause();
      }
    });
    const commit = vi.fn();
    const rollback = vi.fn(async () => await fs.rm(stagedFile));
    const prepareConfigCommit = vi.fn(async () => {
      await fs.writeFile(stagedFile, "staged before publication");
      await pause();
      return { commit, rollback };
    });
    const creation = createAgent({
      name: "prepared",
      workspace,
      beforePersistentApply: () => {
        if (!validateAgentRunDelegatedAuthority(authority)) {
          throw new Error("creation authority closed");
        }
      },
      prepareConfigCommit,
    });
    const outcome = creation.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await withTestTimeout(entered.promise, 10_000, "creation did not reach preparation pause");
      expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
      resume.resolve();

      expect.soft(await outcome).toMatchObject({ error: new Error("creation authority closed") });
      expect.soft(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
      expect.soft(readAgentProvenance("prepared")).toBeUndefined();
      expect.soft(rollback).toHaveBeenCalledTimes(phase === "config" ? 1 : 0);
      expect.soft(commit).not.toHaveBeenCalled();
      expect.soft(await fs.stat(stagedFile).catch(() => null)).toBeNull();
      if (phase !== "config") {
        expect.soft(await fs.readdir(workspace)).toEqual([]);
        expect.soft((await readWorkspaceStateSnapshot(workspace)).setupExists).toBe(false);
        expect.soft(prepareConfigCommit).not.toHaveBeenCalled();
        expect.soft(await fs.stat(state.sessionsDir("prepared")).catch(() => null)).toBeNull();
      } else {
        // Completed workspace/session effects are not rolled back with staged config work.
        expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).not.toBe("");
        expect((await fs.stat(state.sessionsDir("prepared"))).isDirectory()).toBe(true);
      }
    } finally {
      resume.resolve();
      await outcome;
      write.mockRestore();
      access.mockRestore();
      releaseAgentRunDelegatedAuthority(authority);
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  },
);

it("finishes creation bookkeeping when delegated authority closes after successful publication", async () => {
  const state = await createOpenClawTestState({
    scenario: "minimal",
    label: "agent-create-published",
  });
  const authority = claimAgentRunDelegatedAuthority({
    instanceId: "published",
    runId: "published",
  });
  const workspace = state.path("published-workspace");
  const deletion = beginAgentDeletionJournal({
    agentId: "published",
    operationId: randomUUID(),
    agentDir: state.agentDir("published"),
    workspaceDir: workspace,
    sessionsDir: state.sessionsDir("published"),
    deleteFiles: false,
  });
  runOpenClawStateWriteTransaction((database) =>
    completeAgentDeletionJournalInDatabase(database, deletion.agentId, deletion.operationId),
  );
  const rollback = vi.fn();
  const commit = vi.fn();
  try {
    const created = await createAgent({
      name: "published",
      workspace,
      beforePersistentApply: () => {
        if (!validateAgentRunDelegatedAuthority(authority)) {
          throw new Error("creation authority closed");
        }
      },
      prepareConfigCommit: async () => ({ commit, rollback }),
      transformConfig: async (params) => {
        const result = await transformConfigFileWithRetry(params);
        releaseAgentRunDelegatedAuthority(authority);
        return result;
      },
    });

    expect(created).toMatchObject({ status: "created", agentId: "published" });
    expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toHaveProperty(
      "agents.entries.published",
    );
    expect(readAgentDeletionJournal("published")).toBeUndefined();
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(readAgentProvenance("published")).toMatchObject({ createdVia: "operator" });
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
    closeOpenClawStateDatabaseForTest();
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
    closeOpenClawStateDatabaseForTest();
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
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it("records operator and agent creation provenance after roster commits", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "empty",
    label: "agent-creation-provenance",
  });
  try {
    await createAgent({ name: "Operator Child", workspace: state.path("operator-child") });
    await createAgent({
      name: "Agent Child",
      workspace: state.path("agent-child"),
      provenance: { createdVia: "agent", creatorAgentId: "main" },
    });

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
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

describe("agent roster persistence", () => {
  async function addWorkerToConfig(config: unknown): Promise<OpenClawConfig> {
    const state = await createOpenClawTestState({
      layout: "state-only",
      scenario: "empty",
      label: "agent-roster-write",
    });
    try {
      await state.writeConfig(config);
      const result = await createAgent({ name: "Worker", workspace: state.path("worker") });
      expect(result).toMatchObject({
        status: "created",
        agentId: "worker",
        configPath: state.configPath,
      });
      return JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
    } finally {
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  }

  it("writes injected main and a new worker as one complete keyed roster", async () => {
    const persisted = await addWorkerToConfig({ gateway: { mode: "local" } });

    expect(persisted.agents?.entries?.main).toMatchObject({ workspace: expect.any(String) });
    expect(persisted.agents?.entries?.worker).toMatchObject({ workspace: expect.any(String) });
    expect(Object.values(persisted.agents?.entries ?? {})).not.toContainEqual(
      expect.objectContaining({ default: expect.anything() }),
    );
  });

  it("replaces a legacy list with the complete keyed roster", async () => {
    const persisted = await addWorkerToConfig({
      agents: {
        list: [
          { id: "main", default: true },
          { id: "ops", workspace: "/srv/ops" },
        ],
      },
    });

    expect(persisted.agents).not.toHaveProperty("list");
    expect(persisted.agents?.entries?.main).toMatchObject({ workspace: expect.any(String) });
    expect(persisted.agents?.entries).toMatchObject({
      ops: { workspace: "/srv/ops" },
      worker: { workspace: expect.any(String) },
    });
  });

  it("preserves a legacy list byte-for-byte during a non-roster mutation", async () => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      scenario: "empty",
      label: "legacy-roster-non-roster-write",
    });
    const list = [
      { id: "main", default: true },
      { id: "ops", workspace: "/srv/ops" },
    ];
    try {
      await state.writeConfig({ agents: { list }, gateway: { port: 18789 } });
      await mutateConfigFileWithRetry({
        mutate: (config) => {
          config.gateway = { ...config.gateway, port: 19001 };
        },
      });

      const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
      expect(JSON.stringify(persisted.agents?.list)).toBe(JSON.stringify(list));
      expect(persisted.agents).not.toHaveProperty("entries");
      expect(persisted.gateway?.port).toBe(19001);
    } finally {
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  });
});

it("creates main as an ordinary fresh agent after doctor completes both ownership handoffs", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "empty",
    label: "ordinary-main-agent",
  });
  const cfg: OpenClawConfig = {
    agents: { entries: { robby: { workspace: state.path("workspace-robby") } } },
  };
  const legacyDatabasePath = path.join(state.agentDir("main"), "openclaw-agent.sqlite");
  const ownerDatabasePath = path.join(state.agentDir("robby"), "openclaw-agent.sqlite");
  const legacyKey = "agent:main:main";
  const canonicalKey = "agent:robby:main";
  const lateLegacyKey = "agent:main:late";
  const lateCanonicalKey = "agent:robby:late";

  try {
    await state.writeConfig(cfg);
    runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionEntry(
          database,
          legacyKey,
          { sessionId: "legacy-before-main-reuse", updatedAt: 100 },
          { allowStoredAliases: true, previousEntry: null },
        );
      },
      { agentId: "main", env: state.env, path: legacyDatabasePath },
    );
    await migrateLegacyMainSessionKeys({ cfg, env: state.env, mode: "doctor-fix" });
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: state.env });
    runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionEntry(
          database,
          lateLegacyKey,
          { sessionId: "late-legacy-before-main-reuse", updatedAt: 200 },
          { allowStoredAliases: true, previousEntry: null },
        );
      },
      { agentId: "main", env: state.env, path: legacyDatabasePath },
    );

    const blocked = await createAgent({ name: "main", workspace: state.path("workspace-main") });
    expect(blocked).toMatchObject({
      status: "error",
      reason: "legacy-session-migration-required",
    });
    expect(
      runOpenClawAgentWriteTransaction(
        (database) => readExactSessionEntryRowForCanonicalRepair(database, lateLegacyKey)?.entry,
        { agentId: "main", env: state.env, path: legacyDatabasePath },
      ),
    ).toMatchObject({ sessionId: "late-legacy-before-main-reuse" });

    await migrateLegacyMainSessionKeys({ cfg, env: state.env, mode: "doctor-fix" });

    const created = await createAgent({ name: "main", workspace: state.path("workspace-main") });

    expect(created).toMatchObject({ status: "created", agentId: "main" });
    if (created.status !== "created") {
      throw new Error(`expected main creation, got ${JSON.stringify(created)}`);
    }
    const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
    const mainSessionTarget = resolveSqliteTargetFromSessionStorePath(
      resolveSessionStorePathCore(persisted.session?.store, { agentId: "main", env: state.env }),
      { agentId: "main", env: state.env },
    );
    expect(mainSessionTarget).toMatchObject({ agentId: "main", path: legacyDatabasePath });
    expect(resolveAuthProfileDatabasePath(created.agentDir)).toBe(legacyDatabasePath);
    expect(resolveSharedAuthStorePath(state.env)).toBe(resolveOpenClawStateSqlitePath(state.env));
    expect(resolveAuthProfileDatabasePath(created.agentDir)).not.toBe(
      resolveSharedAuthStorePath(state.env),
    );
    expect(
      listSessionEntriesReadOnly({
        agentId: "main",
        env: state.env,
        storePath: legacyDatabasePath,
      }).filter((entry) => entry.sessionKey.startsWith("agent:main:")),
    ).toEqual([]);
    expect(
      runOpenClawAgentWriteTransaction(
        (database) => readExactSessionEntryRowForCanonicalRepair(database, canonicalKey)?.entry,
        { agentId: "robby", env: state.env, path: ownerDatabasePath },
      ),
    ).toMatchObject({ sessionId: "legacy-before-main-reuse" });
    expect(
      runOpenClawAgentWriteTransaction(
        (database) => readExactSessionEntryRowForCanonicalRepair(database, lateCanonicalKey)?.entry,
        { agentId: "robby", env: state.env, path: ownerDatabasePath },
      ),
    ).toMatchObject({ sessionId: "late-legacy-before-main-reuse" });
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});
