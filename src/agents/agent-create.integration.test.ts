import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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
import * as workerStores from "../infra/sqlite-worker-store.js";
import {
  persistProviderAuthProfileBatch,
  stageProviderAuthProfileBatch,
} from "../plugins/provider-auth-persistence.js";
import { createRetainedAgentDatabaseMatcher } from "../state/agent-deletion-discovery.js";
import { AGENT_DELETION_RECOVERY_SOURCE_KEY } from "../state/agent-deletion-journal-recovery.kernel.js";
import { completeAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import { readAgentDeletionJournalStatusInWorker } from "../state/agent-deletion-journal.read.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  closeOpenClawAgentDatabasesForTest,
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
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../test-utils/agent-deletion-journal.js";
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

async function createState(
  label: string,
  options: Parameters<typeof createOpenClawTestState>[0] = {},
) {
  const state = await createOpenClawTestState({ scenario: "minimal", label, ...options });
  onTestFinished(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  });
  const readConfig = () => fs.readFile(state.configPath, "utf8");
  return Object.assign(state, {
    readConfig,
    readJsonConfig: async (): Promise<OpenClawConfig> => JSON.parse(await readConfig()),
  });
}

function completeDeletion(
  state: Awaited<ReturnType<typeof createState>>,
  agentId: string,
  workspaceDir: string,
) {
  const deletion = beginAgentDeletionJournal({
    agentId,
    operationId: randomUUID(),
    agentDir: state.agentDir(agentId),
    workspaceDir,
    sessionsDir: state.sessionsDir(agentId),
    deleteFiles: false,
  });
  runOpenClawStateWriteTransaction((database) =>
    completeAgentDeletionJournalInDatabase(database, deletion.agentId, deletion.operationId),
  );
}

function assertAuthority(authority: Parameters<typeof validateAgentRunDelegatedAuthority>[0]) {
  if (!validateAgentRunDelegatedAuthority(authority)) {
    throw new Error("creation authority closed");
  }
}

function authBatch(
  agentDir: string,
  profileId: string,
  key: string,
): Parameters<typeof stageProviderAuthProfileBatch>[0] {
  return {
    agentDir,
    config: {},
    profiles: [{ profileId, credential: { type: "api_key", provider: "openai", key } }],
  };
}

const expectCreation = async (params: Parameters<typeof createAgent>[0], result: object) =>
  expect(await createAgent(params)).toMatchObject(result);

async function expectMissing(...paths: string[]) {
  for (const file of paths) {
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

function claimAuthority(label: string) {
  const authority = claimAgentRunDelegatedAuthority({ instanceId: label, runId: label });
  onTestFinished(() => {
    releaseAgentRunDelegatedAuthority(authority);
  });
  return authority;
}

const legacyRoster: OpenClawConfigWithLegacyRoster = {
  agents: {
    list: [
      { id: "main", default: true },
      { id: "ops", workspace: "/srv/ops" },
    ],
  },
};

const settle = <T>(operation: Promise<T>) =>
  operation.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );

async function observeSql(run: (queries: string[]) => Promise<void>) {
  const observation = observeHostDataSql();
  try {
    await run(observation.queries);
  } finally {
    observation.restore();
  }
}

it("restores only the configured held store after explicit creation, never through bootstrap or retargeting", async () => {
  const state = await createState("held-agent-restore");

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
  await observeSql(async (queries) => {
    await expectCreation(
      { ...params, agentDir: path.dirname(recovery.held[1]!.path) },
      {
        status: "error",
        reason: "already-exists",
      },
    );
    expect(queries.filter((sql) => /\bmigration_sources\b/i.test(sql))).toEqual([]);
  });
  expect(recovery.readHolds()).toEqual(recovery.held);
  await expectCreation({ ...params, bootstrapMain: true }, { status: "existing" });
  expect(recovery.readHolds()).toEqual(recovery.held);
  await expectCreation(
    { ...params, bootstrapFirstAgent: true },
    {
      status: "error",
      reason: "already-exists",
    },
  );
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

  await expectCreation(
    { ...params, restorePaths: [] },
    { status: "error", reason: "already-exists" },
  );
  expect(recovery.readHolds()).toEqual(recovery.held);

  await expectCreation(params, { status: "existing", agentDir: state.agentDir() });
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
  expect(await readAgentDeletionJournalStatusInWorker("main", { env: state.env })).toBe("absent");
  expect(isAgentDeletionBlocked("main", { env: state.env })).toBe(false);
  for (const target of recovery.held.slice(0, 2)) {
    expect(openOpenClawAgentDatabase({ ...target, env: state.env }).path).toBe(target.path);
  }
  expect(recovery.readHolds()).toEqual(recovery.held.slice(1));
});

it.each(["added", "removed"] as const)(
  "observes a foreign hold %s between bootstrap probes without host hold SQL",
  async (change) => {
    const state = await createState("bootstrap-probes");

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
    const originalConfig = await state.readConfig();
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
          let changed = false;
          await observeSql(async (queries) => {
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
              queries.filter(
                (sql) => /^\s*select\b/i.test(sql) && /\bmigration_sources\b/i.test(sql),
              ),
            ).toEqual([]);
          });
        },
        { env: state.env },
      );
    } finally {
      foreign.close();
    }
    expect(await state.readConfig()).toBe(originalConfig);
  },
);

it("restores a held custom filename only after its session store configuration selects it", async () => {
  const state = await createState("held-custom-store");

  const config = { agents: { entries: { ops: { workspace: state.workspaceDir } } } };
  await state.writeConfig(config);
  const target = { agentId: "restored", path: state.path("custom", "history.sqlite") };
  const recovery = await prepareRecoveryHolds(state, target.agentId, [target]);
  const originalConfig = await state.readConfig();
  const params = {
    name: target.agentId,
    workspace: state.path("restored-workspace"),
    agentDir: path.dirname(target.path),
  };
  await expectCreation(params, {
    status: "error",
    reason: "already-exists",
    message: expect.stringContaining("session.store"),
  });
  expect(await state.readConfig()).toBe(originalConfig);
  await expectMissing(path.join(params.agentDir, "openclaw-agent.sqlite"));
  await state.writeConfig({ ...config, session: { store: target.path } });
  await expectCreation(params, { status: "created", agentId: target.agentId });
  expect(recovery.readHolds()).toEqual([]);
  expect(await fs.readFile(target.path)).toEqual(recovery.bytes[0]);
});

it.each(["missing", "un-authored"] as const)(
  "keeps custom retained history held when onboarding finds %s config",
  async (configState) => {
    const state = await createState("held-bootstrap");

    const config = { gateway: { mode: "local" as const } };
    await state.writeConfig(config);
    await transformConfigFileWithRetry({
      transform: (current) => ({ nextConfig: current, result: undefined }),
    });
    const target = { agentId: "main", path: state.path("custom", "history.sqlite") };
    const recovery = await prepareRecoveryHolds(state, target.agentId, [target]);
    const originalConfig = await state.readConfig();
    if (configState === "missing") {
      await fs.rm(state.configPath);
    }
    const workspace = state.path("onboarding-workspace");

    await expect(ensureOnboardingAgent({ config, workspace })).rejects.toThrow("held databases");
    await expectCreation(
      { name: "main", workspace, bootstrapMain: true },
      configState === "missing"
        ? {
            status: "error",
            reason: "already-exists",
            message: expect.stringContaining("held databases"),
          }
        : { status: "existing" },
    );

    if (configState === "missing") {
      await expectMissing(state.configPath);
    } else {
      expect(await state.readConfig()).toBe(originalConfig);
    }
    await expectMissing(workspace, state.agentDir());
    expect(recovery.readHolds()).toEqual([target]);
    expect(await fs.readFile(target.path)).toEqual(recovery.bytes[0]);
  },
);

it.each(["bootstrap", "explicit"])(
  "rechecks current %s holds after staged preparation and rolls its receipt back",
  async (mode) => {
    const state = await createState("late-bootstrap-hold");

    await state.writeConfig({ gateway: { mode: "local" } });
    openOpenClawStateDatabase({ env: state.env });
    const originalConfig = await state.readConfig();
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
    expect(await state.readConfig()).toBe(originalConfig);
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    await expectMissing(stagedFile, state.agentDir(target.agentId));
    expect(recovery?.readHolds()).toEqual([target]);
    expect(await fs.readFile(target.path)).toEqual(recovery?.bytes[0]);
  },
);

it.each([
  "missing",
  "removed before publication",
  "replaced before publication",
  "replaced after publication",
])("retains the recovery hold when the preserved database is %s", async (change) => {
  const state = await createState("changed-held-store");

  await state.writeConfig({
    agents: { entries: { ops: { workspace: state.workspaceDir } } },
  });
  const target = { agentId: "main", path: path.join(state.agentDir(), "openclaw-agent.sqlite") };
  const recovery = await prepareRecoveryHolds(state, target.agentId, [target]);
  const originalConfig = await state.readConfig();
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
    expect(await state.readJsonConfig()).toHaveProperty("agents.entries.main");
    expect(rollback).not.toHaveBeenCalled();
  } else {
    expect(await state.readConfig()).toBe(originalConfig);
  }
  if (change.endsWith("before publication")) {
    expect(rollback).toHaveBeenCalledOnce();
  }
  if (!change.startsWith("replaced")) {
    await expectMissing(target.path);
  }
});

it("keeps a restored main agent held until its new config entry is published", async () => {
  const state = await createState("held-agent-publication");

  await state.writeConfig({
    agents: { entries: { ops: { workspace: state.path("ops-workspace") } } },
    gateway: { mode: "local" },
  });
  const recovery = await prepareRecoveryHolds(state, "main");
  const params = { name: "main", workspace: state.path("restored-workspace") };
  const originalConfig = await state.readConfig();
  await expect(
    createAgent({
      ...params,
      prepareConfigCommit: async () => {
        throw new Error("publication failed");
      },
    }),
  ).rejects.toThrow("publication failed");
  expect(await state.readConfig()).toBe(originalConfig);
  expect(recovery.readHolds()).toEqual(recovery.held);
  const created = await createAgent({
    ...params,
    onCommitted: (result) => {
      expect(result.config.agents?.entries?.main).toBeDefined();
      expect(recovery.readHolds()).toEqual(recovery.held);
    },
  });
  expect(created).toMatchObject({ status: "created", agentId: "main" });
  expect(await state.readJsonConfig()).toHaveProperty("agents.entries.main");
  expect(recovery.readHolds()).toEqual(recovery.held.slice(1));
  expect(await Promise.all(recovery.held.map((target) => fs.readFile(target.path)))).toEqual(
    recovery.bytes,
  );
});

it("does not create an agent after delegated authority closes while awaiting the config lock", async () => {
  const state = await createState("agent-create-closed-authority");
  const authority = claimAuthority("creation");
  const lockEntered = createDeferred();
  const releaseLock = createDeferred();
  const creationEntered = createDeferred();
  const { runtime, lines } = createSystemAgentTestRuntime();
  const workspace = state.path("delegated-workspace");
  const originalConfig = await state.readConfig();
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
    const outcome = settle(creation);
    await creationEntered.promise;
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    releaseLock.resolve();
    await lock;

    expect.soft(await outcome).toMatchObject({
      error: new Error("system-agent approval authority is no longer active"),
    });
    expect.soft(await state.readConfig()).toBe(originalConfig);
    expect.soft(await fs.stat(workspace).catch(() => null)).toBeNull();
    expect.soft(await fs.stat(state.sessionsDir("delegated")).catch(() => null)).toBeNull();
    expect.soft(readAgentProvenance("delegated", { env: state.env })).toBeUndefined();
    expect.soft(lines).not.toContain("[openclaw] done: agents.create");
  } finally {
    releaseLock.resolve();
    await lock;
    await creation?.catch(() => undefined);
  }
});

it.for(["workspace", "workspace-write", "config"] as const)(
  "stops delegated creation after authority closes during %s preparation",
  async (phase, { signal }) => {
    const state = await createState(`agent-create-${phase}-authority`);
    const authority = claimAuthority("preparation");
    const entered = createDeferred<typeof phase>();
    const resume = createDeferred();
    const workspace = state.path("prepared-workspace");
    const stagedFile = state.path("staged-effect");
    const originalConfig = await state.readConfig();
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
      beforePersistentApply: () => assertAuthority(authority),
      prepareConfigCommit,
    });
    const outcome = settle(creation);
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
      expect.soft(await state.readConfig()).toBe(originalConfig);
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
    }
  },
);

it("finishes creation bookkeeping when delegated authority closes after successful publication", async () => {
  const state = await createState("agent-create-published");
  const authority = claimAuthority("published");
  const workspace = state.path("published-workspace");
  completeDeletion(state, "published", workspace);
  const rollback = vi.fn();
  const commit = vi.fn();
  const created = await createAgent({
    name: "published",
    workspace,
    beforePersistentApply: () => assertAuthority(authority),
    prepareConfigCommit: async () => ({ commit, rollback }),
    transformConfig: async (params) => {
      const result = await transformConfigFileWithRetry(params);
      releaseAgentRunDelegatedAuthority(authority);
      return result;
    },
  });

  expect(created).toMatchObject({ status: "created", agentId: "published" });
  expect(await state.readJsonConfig()).toHaveProperty("agents.entries.published");
  expect(readAgentDeletionJournal("published")).toBeUndefined();
  expect(commit).toHaveBeenCalledOnce();
  expect(rollback).not.toHaveBeenCalled();
  expect(readAgentProvenance("published")).toMatchObject({ createdVia: "operator" });
});

it.each(["commit", "rollback", "close-failure"] as const)(
  "stores staged auth for a recreated id inside the creation claim (%s)",
  async (phase) => {
    const state = await createState(`agent-create-recreated-auth-${phase}`);
    const workspace = state.path("work-workspace");
    const agentDir = state.agentDir("work");
    completeDeletion(state, "work", workspace);
    const originalConfig = await state.readConfig();
    const readProfiles = () =>
      ensureAuthProfileStore(agentDir, { readOnly: true, syncExternalCli: false }).profiles;
    let staged = false;
    let retainedCreation: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
    let restoreNativeClose: (() => void) | undefined;
    let nativeStore: { close(): Promise<void> } | undefined;
    const openNative = workerStores.openAgentDatabaseSqliteWorkerStore;
    const observeNativeOpen =
      phase === "close-failure"
        ? vi
            .spyOn(workerStores, "openAgentDatabaseSqliteWorkerStore")
            .mockImplementation(async (...args) => {
              const store = await openNative(...args);
              if (args[0].databasePath === resolveAuthProfileDatabasePath(agentDir)) {
                nativeStore = store;
              }
              return store;
            })
        : undefined;
    const settlement: string[] = [];
    // An ordinary writer outside the creation lifecycle, through the same wizard path.
    const writeOutsideCreation = () =>
      persistProviderAuthProfileBatch(authBatch(agentDir, "openai:after", "sk-test-after"));
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
          const receipt = await stageProviderAuthProfileBatch(
            authBatch(agentDir, "openai:default", "sk-test-recreated"),
          );
          staged = true;
          retainedCreation = AsyncLocalStorage.snapshot();
          if (phase === "close-failure") {
            if (!nativeStore) {
              throw new Error("Staged auth did not retain its worker store");
            }
            const close = nativeStore.close.bind(nativeStore);
            let failed = false;
            const closeSpy = vi.spyOn(nativeStore, "close").mockImplementation(async () => {
              if (!failed) {
                failed = true;
                settlement.push("close-failed");
                throw new Error("injected native close failure");
              }
              await close();
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
        expect(await state.readJsonConfig()).toHaveProperty("agents.entries.work");
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
        expect(await state.readConfig()).toBe(originalConfig);
        expect(readAgentDeletionJournal("work")).toMatchObject({ cleanupCompleted: true });
        expect(readProfiles()["openai:default"]).toBeUndefined();
        // The retained tombstone must fence the same process: no warm handle survives
        // the failed creation, and a cold open is refused until creation claims the record.
        await expect(writeOutsideCreation()).rejects.toThrow("agent work is deleted");
        if (!retainedCreation) {
          throw new Error("Auth staging did not capture its creation context");
        }
        await expect(retainedCreation(writeOutsideCreation)).rejects.toThrow(
          "agent work is deleted",
        );
        expect(isWorkDatabaseOpen()).toBe(false);
        expect(readProfiles()["openai:after"]).toBeUndefined();
        expect(readAgentDeletionJournal("work")).toMatchObject({ cleanupCompleted: true });
      }
    } finally {
      restoreNativeClose?.();
      observeNativeOpen?.mockRestore();
    }
  },
);

describe("agent roster persistence", () => {
  it.each([false, true])(
    "persists a complete keyed roster (Doctor migration=%s)",
    async (migrate) => {
      const state = await createState("agent-roster-write", {
        layout: "state-only",
        scenario: "empty",
      });
      let config: OpenClawConfig = { gateway: { mode: "local" } };
      if (migrate) {
        config = expectDefined(
          migrateLegacyConfig(legacyRoster, { sourceConfigBeforeMigrations: legacyRoster }).config,
          "Doctor migrated roster",
        );
      }
      await state.writeConfig(config);
      await expectCreation(
        { name: "Worker", workspace: state.path("worker") },
        {
          status: "created",
          agentId: "worker",
          configPath: state.configPath,
        },
      );
      const persisted = await state.readJsonConfig();
      expect(persisted.agents?.entries).toMatchObject({
        main: { workspace: expect.any(String) },
        worker: { workspace: expect.any(String) },
      });
      if (migrate) {
        expect(persisted.agents).not.toHaveProperty("list");
        expect(persisted.agents?.entries?.ops).toMatchObject({ workspace: "/srv/ops" });
      } else {
        expect(Object.values(persisted.agents?.entries ?? {})).not.toContainEqual(
          expect.objectContaining({ default: expect.anything() }),
        );
      }
    },
  );

  it("refuses a non-roster mutation without changing an unmigrated legacy list", async () => {
    const state = await createState("legacy-roster-non-roster-write", {
      layout: "state-only",
      scenario: "empty",
    });
    await state.writeConfig({ ...legacyRoster, gateway: { port: 18789 } });
    const original = await state.readConfig();
    await expect(
      mutateConfigFileWithRetry({
        mutate: (config) => {
          config.gateway = { ...config.gateway, port: 19001 };
        },
      }),
    ).rejects.toThrow("doctor --fix");

    expect(await state.readConfig()).toBe(original);
  });
});

it("creates main as an ordinary fresh agent after doctor completes both ownership handoffs", async () => {
  const state = await createState("ordinary-main-agent", {
    layout: "state-only",
    scenario: "empty",
  });
  const cfg: OpenClawConfig = {
    agents: { entries: { robby: { workspace: state.path("workspace-robby") } } },
  };
  const legacyDatabasePath = path.join(state.agentDir("main"), "openclaw-agent.sqlite");
  const ownerDatabasePath = path.join(state.agentDir("robby"), "openclaw-agent.sqlite");
  const legacyTarget = { agentId: "main", env: state.env, path: legacyDatabasePath };
  const writeLegacy = (key: string, sessionId: string, updatedAt: number) =>
    runOpenClawAgentWriteTransaction(
      (database) =>
        writeSessionEntry(
          database,
          key,
          { sessionId, updatedAt },
          { allowStoredAliases: true, previousEntry: null },
        ),
      legacyTarget,
    );
  const readSession = (key: string, agentId = "robby", databasePath = ownerDatabasePath) =>
    runOpenClawAgentWriteTransaction(
      (database) => readExactSessionEntryRowForCanonicalRepair(database, key)?.entry,
      { agentId, env: state.env, path: databasePath },
    );

  await state.writeConfig(cfg);
  writeLegacy("agent:main:main", "legacy-before-main-reuse", 100);
  await migrateLegacyMainSessionKeys({ cfg, env: state.env, mode: "doctor-fix" });
  writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: state.env });
  writeLegacy("agent:main:late", "late-legacy-before-main-reuse", 200);

  const blocked = await createAgent({ name: "main", workspace: state.path("workspace-main") });
  expect(blocked).toMatchObject({
    status: "error",
    reason: "legacy-session-migration-required",
  });
  expect(readSession("agent:main:late", "main", legacyDatabasePath)).toMatchObject({
    sessionId: "late-legacy-before-main-reuse",
  });

  await migrateLegacyMainSessionKeys({ cfg, env: state.env, mode: "doctor-fix" });

  const created = await createAgent({ name: "main", workspace: state.path("workspace-main") });

  expect(created).toMatchObject({ status: "created", agentId: "main" });
  if (created.status !== "created") {
    throw new Error(`expected main creation, got ${JSON.stringify(created)}`);
  }
  const persisted = await state.readJsonConfig();
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
  expect(readSession("agent:robby:main")).toMatchObject({ sessionId: "legacy-before-main-reuse" });
  expect(readSession("agent:robby:late")).toMatchObject({
    sessionId: "late-legacy-before-main-reuse",
  });
});
