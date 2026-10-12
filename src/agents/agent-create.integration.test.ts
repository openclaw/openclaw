import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import { ensureOnboardingAgent } from "../commands/onboard-agent.js";
import {
  mutateConfigFileWithRetry,
  transformConfigFileWithRetry,
  withConfigMutationExclusive,
} from "../config/config.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
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
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  persistProviderAuthProfileBatch,
  stageProviderAuthProfileBatch,
} from "../plugins/provider-auth-persistence.js";
import { createRetainedAgentDatabaseMatcher } from "../state/agent-deletion-discovery.js";
import { AGENT_DELETION_RECOVERY_SOURCE_KEY } from "../state/agent-deletion-journal-recovery.kernel.js";
import {
  completeAgentDeletionJournalInDatabase,
  readAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  isOpenClawAgentDatabaseOpen,
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
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { readAgentProvenance } from "../test-utils/agent-provenance.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  installWorkspacePreparationPause,
  prepareRecoveryHolds,
} from "./agent-create.integration.test-support.js";
import { createAgent } from "./agent-create.js";
import { isAgentDeletionBlocked } from "./agent-lifecycle-registry.js";
import { resolveSharedAuthStorePath } from "./auth-profiles/path-resolve.js";
import { resolveAuthProfileDatabasePath } from "./auth-profiles/sqlite.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { readWorkspaceStateSnapshot } from "./workspace-state-store.js";

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
    ).toThrow("belongs to agent main; requested agent alias");
    const params = { name: "main", workspace: state.workspaceDir };
    const observation = observeHostDataSql();
    try {
      expect(
        await createAgent({ ...params, agentDir: path.dirname(recovery.held[1]!.path) }),
      ).toMatchObject({
        status: "error",
        reason: "already-exists",
      });
      expect(observation.queries.filter((sql) => /\bmigration_sources\b/i.test(sql))).toEqual([]);
    } finally {
      observation.restore();
    }
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
    for (const target of recovery.held.slice(0, 2)) {
      expect(openOpenClawAgentDatabase({ ...target, env: state.env }).path).toBe(target.path);
    }
    expect(recovery.readHolds()).toEqual(recovery.held.slice(1));
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it.each(["added", "removed"] as const)(
  "observes a foreign hold %s between bootstrap probes without host hold SQL",
  async (change) => {
    const state = await createOpenClawTestState({ scenario: "minimal", label: "bootstrap-probes" });
    try {
      await state.writeConfig({ agents: { entries: { main: { workspace: state.workspaceDir } } } });
      await transformConfigFileWithRetry({
        transform: (current) => ({ nextConfig: current, result: undefined }),
      });
      const target = { agentId: "main", path: state.path("custom", "history.sqlite") };
      await prepareRecoveryHolds(state, target.agentId, [target]);
      beginAgentDeletionJournal({
        agentId: target.agentId,
        operationId: randomUUID(),
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        sessionsDir: state.sessionsDir(),
        deleteFiles: false,
      });
      const originalConfig = await fs.readFile(state.configPath, "utf8");
      const foreign = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(state.env));
      try {
        const update = foreign.prepare(
          "UPDATE migration_sources SET report_json = ? WHERE source_key = ?",
        );
        const setHeld = (held: boolean) =>
          update.run(
            JSON.stringify({ description: "Synthetic recovery hold", held: held ? [target] : [] }),
            AGENT_DELETION_RECOVERY_SOURCE_KEY,
          );
        setHeld(change === "removed");
        await withOpenClawStateDatabaseReadSnapshot(
          async () => {
            const observation = observeHostDataSql();
            let changed = false;
            try {
              const result = await createAgent({
                name: "main",
                bootstrapMain: true,
                beforePersistentApply: () => {
                  if (!changed) {
                    changed = true;
                    setHeld(change === "added");
                  }
                },
              });
              expect(result).toMatchObject(
                change === "added"
                  ? { status: "existing" }
                  : { status: "error", reason: "deletion-pending" },
              );
              expect(changed).toBe(true);
              expect(
                observation.queries.filter(
                  (sql) => /^\s*select\b/i.test(sql) && /\bmigration_sources\b/i.test(sql),
                ),
              ).toEqual([]);
            } finally {
              observation.restore();
            }
          },
          { env: state.env },
        );
      } finally {
        foreign.close();
      }
      expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  },
);

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

it.for(["workspace", "workspace-write", "config"] as const)(
  "stops delegated creation after authority closes during %s preparation",
  async (phase, { signal }) => {
    const state = await createOpenClawTestState({
      scenario: "minimal",
      label: `agent-create-${phase}-authority`,
    });
    const authority = claimAgentRunDelegatedAuthority({
      instanceId: "preparation-instance",
      runId: "preparation-run",
    });
    const entered = createDeferred<typeof phase>();
    const resume = createDeferred();
    const workspace = state.path("prepared-workspace");
    const stagedFile = state.path("staged-effect");
    const originalConfig = await fs.readFile(state.configPath, "utf8");
    const pause = async (pausedPhase: typeof phase) => {
      entered.resolve(pausedPhase);
      await resume.promise;
    };
    const restoreWorkspacePreparation = installWorkspacePreparationPause(workspace, phase, pause);
    const commit = vi.fn();
    const rollback = vi.fn(async () => await fs.rm(stagedFile));
    const prepareConfigCommit = vi.fn(async () => {
      await fs.writeFile(stagedFile, "staged before publication");
      await pause("config");
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
      // The finally block restores process-wide spies and env; a stalled wait must still reach it.
      expect(
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            creation,
            "creation settled before its preparation pause",
          ),
          signal,
        ),
      ).toBe(phase);
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
      restoreWorkspacePreparation();
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

it.each(["commit", "rollback", "close-failure"] as const)(
  "stores staged auth for a recreated id inside the creation claim (%s)",
  async (phase) => {
    const state = await createOpenClawTestState({
      scenario: "minimal",
      label: `agent-create-recreated-auth-${phase}`,
    });
    const workspace = state.path("work-workspace");
    const agentDir = state.agentDir("work");
    const deletion = beginAgentDeletionJournal({
      agentId: "work",
      operationId: randomUUID(),
      agentDir,
      workspaceDir: workspace,
      sessionsDir: state.sessionsDir("work"),
      deleteFiles: false,
    });
    runOpenClawStateWriteTransaction((database) =>
      completeAgentDeletionJournalInDatabase(database, deletion.agentId, deletion.operationId),
    );
    const originalConfig = await fs.readFile(state.configPath, "utf8");
    const readProfiles = () =>
      ensureAuthProfileStore(agentDir, { readOnly: true, syncExternalCli: false }).profiles;
    let staged = false;
    let retainedCreation: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
    let restoreNativeClose: (() => void) | undefined;
    const settlement: string[] = [];
    // An ordinary writer outside the creation lifecycle, through the same wizard path.
    const writeOutsideCreation = () =>
      persistProviderAuthProfileBatch({
        profiles: [
          {
            profileId: "openai:after",
            credential: { type: "api_key", provider: "openai", key: "sk-test-after" },
          },
        ],
        config: {},
        agentDir,
      });
    const isWorkDatabaseOpen = () =>
      isOpenClawAgentDatabaseOpen(resolveAuthProfileDatabasePath(agentDir));
    try {
      const creation = createAgent({
        name: "work",
        workspace,
        beforePersistentApply: () => {
          if (phase === "rollback" && staged) {
            throw new Error("creation authority closed");
          }
        },
        prepareConfigCommit: async () => {
          // The guided wizard's staged auth write opens the recreated agent's own database.
          const receipt = await stageProviderAuthProfileBatch({
            profiles: [
              {
                profileId: "openai:default",
                credential: { type: "api_key", provider: "openai", key: "sk-test-recreated" },
              },
            ],
            config: {},
            agentDir,
          });
          staged = true;
          retainedCreation = AsyncLocalStorage.snapshot();
          if (phase === "close-failure") {
            const database = getOpenClawAgentDatabaseIfOpen({
              agentId: "work",
              path: resolveAuthProfileDatabasePath(agentDir),
            });
            if (!database) {
              throw new Error("Staged auth did not retain its database");
            }
            const close = database.db.close.bind(database.db);
            let failed = false;
            const closeSpy = vi.spyOn(database.db, "close").mockImplementation(() => {
              if (!failed) {
                failed = true;
                settlement.push("close-failed");
                throw new Error("injected native close failure");
              }
              close();
              settlement.push("close-retried");
            });
            restoreNativeClose = () => closeSpy.mockRestore();
            return {
              ...receipt,
              rollback: async () => {
                settlement.push("rollback");
                await receipt.rollback();
              },
            };
          }
          return receipt;
        },
      });
      if (phase === "commit") {
        expect(await creation).toMatchObject({ status: "created", agentId: "work" });
        expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toHaveProperty(
          "agents.entries.work",
        );
        expect(readAgentDeletionJournal("work")).toBeUndefined();
        expect(readProfiles()["openai:default"]).toMatchObject({
          type: "api_key",
          provider: "openai",
        });
        // Creation owned its handles only until publication; ordinary writers reopen freely.
        expect(isWorkDatabaseOpen()).toBe(false);
        await writeOutsideCreation();
        expect(readProfiles()["openai:after"]).toMatchObject({ type: "api_key" });
      } else {
        const error = await creation.then(
          () => undefined,
          (cause: unknown) => cause,
        );
        expect(String(error)).toContain(
          phase === "close-failure" ? "injected native close failure" : "creation authority closed",
        );
        expect(String(error)).not.toContain("staged config rollback failed");
        if (phase === "close-failure") {
          expect(settlement).toEqual(["close-failed", "close-retried", "rollback"]);
        }
        expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
        expect(readAgentDeletionJournal("work")).toMatchObject({ cleanupCompleted: true });
        expect(readProfiles()["openai:default"]).toBeUndefined();
        // The retained tombstone must fence the same process: no warm handle survives
        // the failed creation, and a cold open is refused until creation claims the record.
        await expect(writeOutsideCreation()).rejects.toThrow("agent work is deleted");
        if (!retainedCreation) {
          throw new Error("Auth staging did not capture its creation context");
        }
        await expect(retainedCreation(writeOutsideCreation)).rejects.toThrow(
          "Agent creation claim is no longer active",
        );
        expect(isWorkDatabaseOpen()).toBe(false);
        expect(readProfiles()["openai:after"]).toBeUndefined();
        expect(readAgentDeletionJournal("work")).toMatchObject({ cleanupCompleted: true });
      }
    } finally {
      restoreNativeClose?.();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  },
);

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

  it("extends the complete keyed roster after Doctor migrates a legacy list", async () => {
    const legacy: OpenClawConfigWithLegacyRoster = {
      agents: {
        list: [
          { id: "main", default: true },
          { id: "ops", workspace: "/srv/ops" },
        ],
      },
    };
    const migrated = migrateLegacyConfig(legacy, { sourceConfigBeforeMigrations: legacy });
    expect(migrated.config).not.toBeNull();
    if (!migrated.config) {
      throw new Error("Doctor did not migrate the legacy roster");
    }
    const persisted = await addWorkerToConfig(migrated.config);

    expect(persisted.agents).not.toHaveProperty("list");
    expect(persisted.agents?.entries?.main).toMatchObject({ workspace: expect.any(String) });
    expect(persisted.agents?.entries).toMatchObject({
      ops: { workspace: "/srv/ops" },
      worker: { workspace: expect.any(String) },
    });
  });

  it("refuses a non-roster mutation without changing an unmigrated legacy list", async () => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      scenario: "empty",
      label: "legacy-roster-non-roster-write",
    });
    const list = [
      { id: "main", default: true },
      { id: "ops", workspace: "/srv/ops" },
    ];
    const legacy: OpenClawConfigWithLegacyRoster = {
      agents: { list },
      gateway: { port: 18789 },
    };
    try {
      await state.writeConfig(legacy);
      const original = await fs.readFile(state.configPath, "utf8");
      await expect(
        mutateConfigFileWithRetry({
          mutate: (config) => {
            config.gateway = { ...config.gateway, port: 19001 };
          },
        }),
      ).rejects.toThrow("doctor --fix");

      expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
      const persisted: OpenClawConfigWithLegacyRoster = JSON.parse(
        await fs.readFile(state.configPath, "utf8"),
      );
      expect(persisted.agents).toEqual({ list });
      expect(persisted.agents).not.toHaveProperty("entries");
      expect(persisted.gateway).toEqual({ port: 18789 });
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
