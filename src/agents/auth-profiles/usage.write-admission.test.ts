import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as configEnvVars from "../../config/config-env-vars.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import * as integrity from "../../infra/sqlite-integrity-worker.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withMockedPlatform, withRestoredMocks } from "../../test-utils/vitest-spies.js";
import {
  noteCommittedSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnership,
} from "./path-resolve.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "./sqlite-json.js";
import {
  closeAuthProfileReadPool,
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  runAuthProfileWriteTransactionAsync,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import { saveAuthProfileStore } from "./store-runtime.js";
import type { AuthProfileStore } from "./types.js";
import { markAuthProfileFailure } from "./usage.js";

const profileId = "fixture-provider:admission";
const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };

function createStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [profileId]: {
        type: "api_key",
        provider: "fixture-provider",
        key: "synthetic-auth-admission-key",
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
});

it.each(["current", "relocated", "closed"] as const)(
  "keeps cold auth health behind asynchronous integrity and its %s owner",
  async (owner) => {
    await withOpenClawTestState(
      { label: "auth-health-cold-owner", scenario: "minimal" },
      async (state) => {
        const cfg = { agents: { list: [{ id: "main", default: true }, { id: "voice" }] } };
        setRuntimeConfigSnapshot(cfg, cfg);
        const agentDir = state.agentDir("voice");
        const options = { agentId: "voice", env: state.env };
        const store = createStore();
        saveAuthProfileStore(store, agentDir, saveOptions);
        setRuntimeAuthProfileStoreSnapshot(store, agentDir);
        const pathname = openOpenClawAgentDatabase(options).path;
        closeOpenClawAgentDatabasesForTest(state.env.OPENCLAW_STATE_DIR);
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const realIntegrity = integrity.assertSqliteIntegrityInWorker;
        let checking = false;
        let joined = false;
        vi.spyOn(integrity, "assertSqliteIntegrityInWorker").mockImplementation(async (...args) => {
          if (args[0] !== pathname) {
            return realIntegrity(...args);
          }
          checking = true;
          entered.resolve();
          try {
            await realIntegrity(...args);
          } finally {
            joined = true;
          }
          await release.promise;
        });
        let settled = false;
        const update = markAuthProfileFailure({
          store,
          profileId,
          reason: "auth",
          agentDir,
        }).finally(() => {
          settled = true;
        });
        void update.catch(() => {});
        try {
          await Promise.race([entered.promise, update]);
          expect({ checking, settled, usage: store.usageStats }).toEqual({
            checking: true,
            settled: false,
            usage: undefined,
          });
          if (owner === "relocated") {
            writeConfigMachineState(
              SHARED_AUTH_STORE_STATE_KEY,
              { location: "state-db" },
              { env: state.env },
            );
            noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, state.env);
          } else if (owner === "closed") {
            closeOpenClawAgentDatabaseByPath(pathname);
          }
        } finally {
          release.resolve();
          await Promise.allSettled([update]);
        }
        expect(joined).toBe(true);
        if (owner === "current") {
          await update;
          expect(store.usageStats?.[profileId]?.errorCount).toBe(1);
          expect(loadPersistedAuthProfileStore(agentDir)?.usageStats?.[profileId]?.errorCount).toBe(
            1,
          );
        } else {
          await expect(update).rejects.toThrow(
            owner === "relocated"
              ? /shared owner changed before write admission/
              : /revoked|abort/i,
          );
          expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
          expect(loadPersistedAuthProfileStore(agentDir)?.usageStats).toBeUndefined();
          expect(store.usageStats).toBeUndefined();
        }
      },
    );
  },
);

it.each(["local", "legacy-shared"] as const)(
  "keeps %s auth health behind its actual agent writer reservation",
  async (owner) => {
    await withOpenClawTestState(
      { label: "auth-health-admission", scenario: "minimal" },
      async (state) => {
        const cfg = { agents: { list: [{ id: "main", default: true }, { id: "voice" }] } };
        setRuntimeConfigSnapshot(cfg, cfg);
        const agentId = owner === "local" ? "voice" : "main";
        const agentDir = state.agentDir(agentId);
        const store = createStore();
        saveAuthProfileStore(store, agentDir, saveOptions);
        setRuntimeAuthProfileStoreSnapshot(store, agentDir);
        const database = openOpenClawAgentDatabase({ agentId });
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const reservation = runOpenClawAgentWorkerWrite(
          { agentId, path: database.path },
          async () => {
            entered.resolve();
            await release.promise;
          },
        );
        await entered.promise;
        let settled = false;
        const update = markAuthProfileFailure({
          store,
          profileId,
          reason: "auth",
          agentDir: state.agentDir("voice"),
        }).then(() => {
          settled = true;
        });
        void update.catch(() => {});
        const nextWriter = runOpenClawAgentWriteAdmission(
          { agentId, path: database.path },
          () =>
            getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.usageStats?.[profileId]?.errorCount,
        );
        try {
          await nextTurn();
          expect({
            settled,
            durable: loadPersistedAuthProfileStore(agentDir)?.usageStats?.[profileId],
            runtime: getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.usageStats?.[profileId],
            caller: store.usageStats?.[profileId],
          }).toEqual({ settled: false, durable: undefined, runtime: undefined, caller: undefined });
        } finally {
          release.resolve();
          await Promise.allSettled([reservation, update, nextWriter]);
        }
        await reservation;
        await update;
        await expect(nextWriter).resolves.toBe(1);
        for (const current of [
          loadPersistedAuthProfileStore(agentDir),
          getRuntimeAuthProfileStoreSnapshotCore(agentDir),
          store,
        ]) {
          expect(current?.usageStats?.[profileId]).toMatchObject({
            errorCount: 1,
            cooldownReason: "auth",
          });
        }
      },
    );
  },
);

it.each(["warm", "cold"] as const)(
  "refuses a changed shared owner before a queued %s health update",
  async (temperature) => {
    await withOpenClawTestState(
      { label: "auth-health-relocation", scenario: "minimal" },
      async (state) => {
        const cfg = { agents: { list: [{ id: "main", default: true }, { id: "voice" }] } };
        setRuntimeConfigSnapshot(cfg, cfg);
        const agentDir = state.agentDir("voice");
        const store = createStore();
        saveAuthProfileStore(store, agentDir, saveOptions);
        setRuntimeAuthProfileStoreSnapshot(store, agentDir);
        expect(resolveSharedAuthStoreOwnership(state.env).location).toBe("legacy-main");
        const database = openOpenClawAgentDatabase({ agentId: "voice" });
        if (temperature === "cold") {
          closeOpenClawAgentDatabasesForTest(state.env.OPENCLAW_STATE_DIR);
        }
        const release = createDeferredCore();
        const reservation = runOpenClawAgentWorkerWrite(
          { agentId: "voice", path: database.path },
          async () => release.promise,
        );
        const update = markAuthProfileFailure({ store, profileId, reason: "auth", agentDir });
        const rejected = expect(update).rejects.toThrow(
          "shared owner changed before write admission",
        );
        try {
          // Publish the synthetic relocation through the same durable row and cache used by Doctor.
          writeConfigMachineState(
            SHARED_AUTH_STORE_STATE_KEY,
            { location: "state-db" },
            { env: state.env },
          );
          noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, state.env);
        } finally {
          release.resolve();
          await Promise.allSettled([reservation, rejected]);
        }
        await reservation;
        await rejected;
        expect(getOpenClawAgentDatabaseIfOpen({ agentId: "voice", env: state.env })).toBe(
          temperature === "cold" ? undefined : database,
        );
        expect(loadPersistedAuthProfileStore(agentDir)?.usageStats).toBeUndefined();
        expect(store.usageStats).toBeUndefined();
      },
    );
  },
);

it.each(["shared", "other-agent"] as const)(
  "persists %s health without waiting for an unrelated agent reservation",
  async (owner) => {
    await withOpenClawTestState(
      { label: "auth-health-owner", scenario: "minimal" },
      async (state) => {
        const cfg = {
          agents: { list: [{ id: "main", default: true }, { id: "voice" }, { id: "other" }] },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        const ownerDir = owner === "shared" ? undefined : state.agentDir("other");
        const store = createStore();
        saveAuthProfileStore(store, ownerDir, saveOptions);
        setRuntimeAuthProfileStoreSnapshot(store, ownerDir);
        const database = openOpenClawAgentDatabase({ agentId: "voice" });
        const release = createDeferredCore();
        const reservation = runOpenClawAgentWorkerWrite(
          { agentId: "voice", path: database.path },
          async () => release.promise,
        );
        let settled = false;
        const update = markAuthProfileFailure({
          store,
          profileId,
          reason: "auth",
          agentDir: ownerDir ?? state.agentDir("voice"),
        }).then(() => {
          settled = true;
        });
        void update.catch(() => {});
        try {
          await nextTurn();
          expect(settled).toBe(true);
          expect(loadPersistedAuthProfileStore(ownerDir)?.usageStats?.[profileId]?.errorCount).toBe(
            1,
          );
          expect(store.usageStats?.[profileId]?.errorCount).toBe(1);
          expect(
            loadPersistedAuthProfileStore(state.agentDir("voice"))?.usageStats,
          ).toBeUndefined();
        } finally {
          release.resolve();
          await Promise.allSettled([reservation, update]);
        }
        await reservation;
        await update;
      },
    );
  },
);

it("does not recreate health after an earlier admitted writer removes the profile", async () => {
  await withOpenClawTestState(
    { label: "auth-health-removal", scenario: "minimal" },
    async (state) => {
      const cfg = { agents: { list: [{ id: "main", default: true }, { id: "voice" }] } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const agentDir = state.agentDir("voice");
      const store = createStore();
      saveAuthProfileStore(store, agentDir, saveOptions);
      setRuntimeAuthProfileStoreSnapshot(store, agentDir);
      const database = openOpenClawAgentDatabase({ agentId: "voice" });
      const release = createDeferredCore();
      const removal = runOpenClawAgentWriteAdmission(
        { agentId: "voice", path: database.path },
        async () => {
          await release.promise;
          saveAuthProfileStore({ version: 1, profiles: {} }, agentDir, saveOptions);
        },
      );
      const update = markAuthProfileFailure({ store, profileId, reason: "auth", agentDir });
      void update.catch(() => {});
      release.resolve();
      await Promise.all([removal, update]);
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles).toEqual({});
      for (const current of [
        loadPersistedAuthProfileStore(agentDir),
        getRuntimeAuthProfileStoreSnapshotCore(agentDir),
        store,
      ]) {
        expect(current?.usageStats?.[profileId]).toBeUndefined();
      }
    },
  );
});

it.each(["supplied-first", "ordinary-first"] as const)(
  "keeps %s shared auth snapshots in outer commit order",
  async (order) => {
    await withOpenClawTestState(
      { label: "auth-health-publication", scenario: "minimal" },
      async (state) => {
        const store = createStore();
        saveAuthProfileStore(store, undefined, saveOptions);
        setRuntimeAuthProfileStoreSnapshot(store);
        const updated = { ...store, usageStats: { [profileId]: { errorCount: 1 } } };
        const later = { ...store, usageStats: { [profileId]: { errorCount: 2 } } };
        const rollback = new Error("synthetic outer rollback");
        const writeSupplied = (value: AuthProfileStore) =>
          runAuthProfileWriteTransaction(undefined, (database) => {
            saveAuthProfileStore(value, undefined, saveOptions, database);
          });
        const write = () => {
          if (order === "supplied-first") {
            writeSupplied(updated);
            saveAuthProfileStore(later, undefined, saveOptions);
          } else {
            saveAuthProfileStore(updated, undefined, saveOptions);
            writeSupplied(later);
          }
        };
        expect(() =>
          runOpenClawStateWriteTransaction(
            () => {
              write();
              expect(getRuntimeAuthProfileStoreSnapshotCore()?.usageStats).toBeUndefined();
              throw rollback;
            },
            { env: state.env },
          ),
        ).toThrow(rollback);
        expect(loadPersistedAuthProfileStore()?.usageStats).toBeUndefined();
        expect(getRuntimeAuthProfileStoreSnapshotCore()?.usageStats).toBeUndefined();
        runOpenClawStateWriteTransaction(
          () => {
            write();
            expect(getRuntimeAuthProfileStoreSnapshotCore()?.usageStats).toBeUndefined();
          },
          { env: state.env },
        );
        expect({
          durable: loadPersistedAuthProfileStore()?.usageStats?.[profileId]?.errorCount,
          runtime: getRuntimeAuthProfileStoreSnapshotCore()?.usageStats?.[profileId]?.errorCount,
        }).toEqual({ durable: 2, runtime: 2 });
      },
    );
  },
);

it.each(["raw", "precloned"] as const)(
  "keeps queued auth writes on their captured Windows owners (%s)",
  async (input) => {
    await withOpenClawTestState(
      { label: "auth-windows-owner", scenario: "minimal" },
      async (state) => {
        const cfg = {
          agents: {
            list: [{ id: "main", default: true }, { id: "voice" }, { id: "shared-auth" }],
          },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        const agentDir = state.agentDir("voice");
        const sharedAgentDir = state.agentDir("shared-auth");
        const store = createStore();
        saveAuthProfileStore(store, agentDir, saveOptions);
        runAuthProfileWriteTransaction(
          sharedAgentDir,
          (database) => writePersistedAuthProfileStoreRaw(store, sharedAgentDir, database),
          { env: { ...state.env, OPENCLAW_AGENT_DIR: sharedAgentDir } },
        );
        expect(resolveSharedAuthStoreOwnership(state.env).location).toBe("legacy-main");
        expect(loadPersistedAuthProfileStore(sharedAgentDir)).toEqual(store);
        const database = openOpenClawAgentDatabase({ agentId: "voice", env: state.env });
        const fallbackHome = state.statePath("fallback-home");
        const fallbackRoot = path.join(fallbackHome, ".openclaw");
        const replacementRoot = state.statePath("replacement-state");
        const ignoredRoot = state.statePath("ignored-state");
        const replacementAgentDir = path.join(replacementRoot, "agents", "main", "agent");
        const hostPlatform = process.platform;
        const cloneEnvironment = configEnvVars.cloneEnvWithPlatformSemantics;
        // Only the synchronous clone sees Windows; all native work keeps the host platform.
        const windowsCapture = vi
          .spyOn(configEnvVars, "cloneEnvWithPlatformSemantics")
          .mockImplementation((env) => {
            const captured = withMockedPlatform("win32", () => cloneEnvironment(env));
            expect(process.platform).toBe(hostPlatform);
            return captured;
          });
        try {
          await withRestoredMocks([windowsCapture], async () => {
            const rawEnv = {
              OPENCLAW_HOME: fallbackHome,
              OpenClaw_State_Dir: state.stateDir,
              OpenClaw_Agent_Dir: sharedAgentDir,
            };
            const inputEnv =
              input === "precloned" ? configEnvVars.cloneEnvWithPlatformSemantics(rawEnv) : rawEnv;
            const originalEntries = Object.entries(inputEnv);
            const options = { env: inputEnv, stateDir: ignoredRoot };
            const entered = createDeferredCore();
            const release = createDeferredCore();
            const reservation = runOpenClawAgentWorkerWrite(
              { agentId: "voice", path: database.path },
              async () => {
                entered.resolve();
                await release.promise;
              },
            );
            void reservation.catch(() => {});
            let writing: Promise<void> | undefined;
            let enteredWriter = false;
            let settled = false;
            const updated: AuthProfileStore = {
              version: store.version,
              profiles: {
                [profileId]: {
                  type: "api_key",
                  provider: "fixture-provider",
                  key: "synthetic-captured-auth-key",
                },
              },
            };
            try {
              await Promise.race([
                entered.promise,
                reservation.then(() => {
                  throw new Error("Auth writer reservation settled before it was held");
                }),
              ]);
              writing = runAuthProfileWriteTransactionAsync(
                agentDir,
                (transaction, owner) => {
                  enteredWriter = true;
                  expect(process.platform).toBe(hostPlatform);
                  expect({
                    databasePath: transaction.path,
                    stateDir: owner.env.OPENCLAW_STATE_DIR,
                    sharedDatabasePath: owner.sharedDatabasePath,
                    sharedAgentDir: owner.env.OPENCLAW_AGENT_DIR,
                    location: owner.location,
                  }).toEqual({
                    databasePath: database.path,
                    stateDir: state.stateDir,
                    sharedDatabasePath: resolveAuthProfileDatabasePath(sharedAgentDir),
                    sharedAgentDir,
                    location: "legacy-main",
                  });
                  writePersistedAuthProfileStoreRaw(updated, agentDir, transaction);
                },
                options,
              ).finally(() => {
                settled = true;
              });
              void writing.catch(() => {});
              await nextTurn();
              if (settled) {
                await writing;
              }
              expect({ enteredWriter, settled }).toEqual({ enteredWriter: false, settled: false });
              expect(loadPersistedAuthProfileStore(agentDir)).toEqual(store);
              expect(Object.entries(inputEnv)).toEqual(originalEntries);
              inputEnv.OpenClaw_State_Dir = replacementRoot;
              inputEnv.OpenClaw_Agent_Dir = replacementAgentDir;
              options.env = {
                OPENCLAW_STATE_DIR: replacementRoot,
                OPENCLAW_AGENT_DIR: replacementAgentDir,
              };
              release.resolve();
              await writing;
              expect(loadPersistedAuthProfileStore(agentDir)).toEqual(updated);
              expect(loadPersistedAuthProfileStore(sharedAgentDir)).toEqual(store);
              for (const root of [fallbackRoot, replacementRoot, ignoredRoot]) {
                expect(fs.existsSync(root)).toBe(false);
              }
            } finally {
              release.resolve();
              await Promise.allSettled([reservation, writing]);
            }
            await reservation;
          });
        } finally {
          // Counterfactual broken captures can open one of these fixture-owned roots.
          for (const stateDir of [fallbackRoot, replacementRoot, ignoredRoot]) {
            closeAuthProfileReadPool({ kind: "root", rootPath: stateDir });
            await cleanupSessionStateForTest({ stateDir });
          }
        }
      },
    );
  },
);

it("keeps the explicit auth stateDir override ahead of ambient owner paths", async () => {
  await withOpenClawTestState(
    { label: "auth-state-dir-precedence", scenario: "minimal" },
    async (state) => {
      const agentDir = state.agentDir("voice");
      const ambientRoot = state.statePath("ambient-state");
      const ambientAgentDir = path.join(ambientRoot, "agents", "main", "agent");
      const store = createStore();
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: ambientRoot, OPENCLAW_AGENT_DIR: ambientAgentDir },
        async () => {
          runAuthProfileWriteTransaction(
            agentDir,
            (database, owner) => {
              expect({
                stateDir: owner.env.OPENCLAW_STATE_DIR,
                sharedAgentDir: owner.env.OPENCLAW_AGENT_DIR,
                sharedDatabasePath: owner.sharedDatabasePath,
              }).toEqual({
                stateDir: state.stateDir,
                sharedAgentDir: undefined,
                sharedDatabasePath: resolveAuthProfileDatabasePath(state.agentDir("main")),
              });
              writePersistedAuthProfileStoreRaw(store, agentDir, database);
            },
            { stateDir: state.stateDir },
          );
          expect(process.env.OPENCLAW_STATE_DIR).toBe(ambientRoot);
          expect(process.env.OPENCLAW_AGENT_DIR).toBe(ambientAgentDir);
        },
      );
      expect(loadPersistedAuthProfileStore(agentDir)).toEqual(store);
      expect(fs.existsSync(ambientRoot)).toBe(false);
    },
  );
});
