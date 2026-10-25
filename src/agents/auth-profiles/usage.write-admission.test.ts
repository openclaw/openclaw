import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import * as configEnvVars from "../../config/config-env-vars.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
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
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withMockedPlatform, withRestoredMocks } from "../../test-utils/vitest-spies.js";
import {
  noteCommittedSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnership,
} from "./path-resolve.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { authProfileRuntimeMode } from "./runtime-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "./sqlite-json.js";
import * as sqliteRead from "./sqlite-read.js";
import {
  closeAuthProfileReadPool,
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store-runtime.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import { withAuthProfileUsage } from "./usage-write.js";
import { markAuthProfileFailure } from "./usage.js";

const profileId = "fixture-provider:admission";
const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };

function createStore(key = "synthetic-auth-admission-key"): AuthProfileStore & {
  profiles: Record<typeof profileId, AuthProfileCredential>;
} {
  return {
    version: 1,
    profiles: {
      [profileId]: {
        type: "api_key",
        provider: "fixture-provider",
        key,
      },
    },
  };
}

function createPersistedSnapshot(agentDir?: string) {
  const store = createStore();
  saveAuthProfileStore(store, agentDir, saveOptions);
  setRuntimeAuthProfileStoreSnapshot(store, agentDir);
  return store;
}

function withAuthState(label: string, run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ label, scenario: "minimal" }, (state) => {
    const cfg = { agents: { entries: { main: {}, voice: {} } } };
    setRuntimeConfigSnapshot(cfg, cfg);
    return run(state);
  });
}

function holdWriter(target: Parameters<typeof runOpenClawAgentWorkerWrite>[0]) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const reservation = runOpenClawAgentWorkerWrite(target, async () => {
    entered.resolve();
    await release.promise;
  });
  return { entered, release, reservation };
}

function expectUsage(store: AuthProfileStore, agentDir: string, expected: unknown) {
  for (const current of [
    loadPersistedAuthProfileStore(agentDir),
    getRuntimeAuthProfileStoreSnapshotCore(agentDir),
    store,
  ]) {
    expect(current?.usageStats?.[profileId]).toEqual(expected);
  }
}

const failure = (store: AuthProfileStore) => ({
  kind: "failure" as const,
  expectedProfile: store.profiles[profileId],
  observedAt: Date.now(),
  reason: "auth" as const,
  whamResult: null,
  probeEligible: false,
});

function relocateSharedOwner(env: NodeJS.ProcessEnv) {
  const owner = { location: "state-db" as const };
  writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, owner, { env });
  noteCommittedSharedAuthStoreOwnership(owner, env);
}

type ReadRows = ReturnType<typeof sqliteRead.prepareAgentAuthProfileRowsRead>["read"];
function interceptRead(databasePath: string, read: (original: ReadRows) => ReturnType<ReadRows>) {
  const prepare = sqliteRead.prepareAgentAuthProfileRowsRead;
  return vi.spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead").mockImplementation((target) => {
    const reader = prepare(target);
    return target.databasePath === databasePath
      ? { ...reader, read: () => read(() => reader.read()) }
      : reader;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
});

it.each(["current", "relocated", "closed"] as const)(
  "keeps cold auth health behind asynchronous preparation and its %s owner",
  async (owner) => {
    await withAuthState("auth-health-cold-owner", async (state) => {
      const agentDir = state.agentDir("voice");
      const options = { agentId: "voice", env: state.env };
      const store = createPersistedSnapshot(agentDir);
      const pathname = openOpenClawAgentDatabase(options).path;
      closeOpenClawAgentDatabasesForTest(state.env.OPENCLAW_STATE_DIR);
      revokeSqliteDatabaseAdmissionsForPath(pathname);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      interceptRead(pathname, async (read) => {
        const rows = await read();
        entered.resolve();
        await release.promise;
        return rows;
      });
      const update = markAuthProfileFailure({ store, profileId, reason: "auth", agentDir });
      void update.catch(() => {});
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          update,
          "Auth health did not read its owner",
        );
        expect(store.usageStats).toBeUndefined();
        await runOpenClawAgentWriteAdmission(options, () => {});
        if (owner === "relocated") {
          relocateSharedOwner(state.env);
        } else if (owner === "closed") {
          closeOpenClawAgentDatabaseByPath(pathname);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([update]);
      }
      if (owner === "current") {
        await update;
        expect(store.usageStats?.[profileId]?.errorCount).toBe(1);
        expect(loadPersistedAuthProfileStore(agentDir)?.usageStats?.[profileId]?.errorCount).toBe(
          1,
        );
      } else {
        await expect(update).rejects.toThrow(
          owner === "relocated" ? /shared owner changed before write admission/ : /revoked|abort/i,
        );
        expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
        expect(loadPersistedAuthProfileStore(agentDir)?.usageStats).toBeUndefined();
        expect(store.usageStats).toBeUndefined();
      }
    });
  },
);

it.each(["local", "legacy-shared"] as const)(
  "keeps %s auth health behind its actual agent writer reservation",
  async (owner) => {
    await withAuthState("auth-health-admission", async (state) => {
      const agentId = owner === "local" ? "voice" : "main";
      const agentDir = state.agentDir(agentId);
      const store = createPersistedSnapshot(agentDir);
      const database = openOpenClawAgentDatabase({ agentId });
      const { entered, release, reservation } = holdWriter({ agentId, path: database.path });
      await entered.promise;
      let settled = false;
      const ready = createDeferredCore();
      const update = withAuthProfileUsage(
        store,
        profileId,
        state.agentDir("voice"),
        ({ record }) => {
          const writing = record(failure(store));
          ready.resolve();
          return writing;
        },
      ).then(() => {
        settled = true;
      });
      void update.catch(() => {});
      await awaitGateBeforeSettlement(ready.promise, update, "Auth health did not reach recording");
      const nextWriter = runOpenClawAgentWriteAdmission(
        { agentId, path: database.path },
        () => getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.usageStats?.[profileId]?.errorCount,
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
      expectUsage(
        store,
        agentDir,
        expect.objectContaining({
          errorCount: 1,
          cooldownReason: "auth",
        }),
      );
    });
  },
);

it.each(["warm", "cold"] as const)(
  "refuses a changed shared owner before a queued %s health update",
  async (temperature) => {
    await withAuthState("auth-health-relocation", async (state) => {
      const agentDir = state.agentDir("voice");
      const store = createPersistedSnapshot(agentDir);
      expect(resolveSharedAuthStoreOwnership(state.env).location).toBe("legacy-main");
      const database = openOpenClawAgentDatabase({ agentId: "voice" });
      if (temperature === "cold") {
        closeOpenClawAgentDatabasesForTest(state.env.OPENCLAW_STATE_DIR);
      }
      const { release, reservation } = holdWriter({ agentId: "voice", path: database.path });
      const update = markAuthProfileFailure({ store, profileId, reason: "auth", agentDir });
      const rejected = expect(update).rejects.toThrow(
        "shared owner changed before write admission",
      );
      try {
        // Publish the synthetic relocation through the same durable row and cache used by Doctor.
        relocateSharedOwner(state.env);
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
    });
  },
);

it.each(["shared", "other-agent"] as const)(
  "persists %s health without waiting for an unrelated agent reservation",
  async (owner) => {
    await withOpenClawTestState(
      { label: "auth-health-owner", scenario: "minimal" },
      async (state) => {
        const cfg = {
          agents: { entries: { main: {}, voice: {}, other: {} } },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        const ownerDir = owner === "shared" ? undefined : state.agentDir("other");
        const store = createPersistedSnapshot(ownerDir);
        const database = openOpenClawAgentDatabase({ agentId: "voice" });
        const { release, reservation } = holdWriter({ agentId: "voice", path: database.path });
        const update = markAuthProfileFailure({
          store,
          profileId,
          reason: "auth",
          agentDir: ownerDir ?? state.agentDir("voice"),
        });
        void update.catch(() => {});
        try {
          await update;
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

it.each(["before-read", "after-read"] as const)(
  "does not recreate health after an earlier admitted writer removes the profile (%s)",
  async (order) => {
    await withAuthState("auth-health-removal", async (state) => {
      const agentDir = state.agentDir("voice");
      const store = createPersistedSnapshot(agentDir);
      const database = openOpenClawAgentDatabase({ agentId: "voice" });
      const release = createDeferredCore();
      const observed = createDeferredCore();
      const removal = runOpenClawAgentWriteAdmission(
        { agentId: "voice", path: database.path },
        async () => {
          await release.promise;
          saveAuthProfileStore({ version: 1, profiles: {} }, agentDir, saveOptions);
        },
      );
      const read = interceptRead(database.path, async (original) => {
        if (order === "before-read") {
          await removal;
        }
        const rows = await original();
        observed.resolve();
        return rows;
      });
      const update = markAuthProfileFailure({ store, profileId, reason: "auth", agentDir });
      void update.catch(() => {});
      try {
        if (order === "after-read") {
          await awaitGateBeforeSettlement(
            observed.promise,
            update,
            "Auth usage settled before reading the profile being removed",
          );
        }
        release.resolve();
        await Promise.all([removal, update]);
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles).toEqual({});
        expectUsage(store, agentDir, undefined);
      } finally {
        release.resolve();
        await Promise.allSettled([removal, update]);
        read.mockRestore();
      }
    });
  },
);

it.each(["supplied-first", "ordinary-first"] as const)(
  "keeps %s shared auth snapshots in outer commit order",
  async (order) => {
    await withOpenClawTestState(
      { label: "auth-health-publication", scenario: "minimal" },
      async (state) => {
        const store = createPersistedSnapshot();
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
            entries: { main: {}, voice: {}, "shared-auth": {} },
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
            const scope = { kind: "agent-dir" as const, agentDir, env: inputEnv };
            const { entered, release, reservation } = holdWriter({
              agentId: "voice",
              path: database.path,
            });
            void reservation.catch(() => {});
            let writing: Promise<AuthProfileStore | null> | undefined;
            let enteredWriter = false;
            let settled = false;
            const updated = createStore("synthetic-captured-auth-key");
            try {
              await Promise.race([
                entered.promise,
                reservation.then(() => {
                  throw new Error("Auth writer reservation settled before it was held");
                }),
              ]);
              writing = authProfileRuntimeMode
                .run(scope, () =>
                  updateAuthProfileStoreWithLock({
                    agentDir,
                    saveOptions,
                    updater(current, owner) {
                      enteredWriter = true;
                      expect(process.platform).toBe(hostPlatform);
                      expect(current).toMatchObject(store);
                      if (!owner) {
                        throw new Error("Auth updater lost its captured owner");
                      }
                      expect({
                        databasePath: owner.databasePath,
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
                      current.profiles = updated.profiles;
                      return true;
                    },
                  }),
                )
                .finally(() => {
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
              scope.env = {
                OPENCLAW_STATE_DIR: replacementRoot,
                OPENCLAW_AGENT_DIR: replacementAgentDir,
              };
              release.resolve();
              await writing;
              expect(loadPersistedAuthProfileStore(agentDir)).toEqual(updated);
              expect(loadPersistedAuthProfileStore(sharedAgentDir)).toEqual(store);
              for (const root of [fallbackRoot, replacementRoot]) {
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
          for (const stateDir of [fallbackRoot, replacementRoot]) {
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

it("leaves the writer free while the host decides auth usage admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {}, voice: {} } } };
    setRuntimeConfigSnapshot(cfg, cfg);
    relocateSharedOwner(state.env);
    const store = createPersistedSnapshot();
    using contention = probe.writerLock(resolveOpenClawStateSqlitePath());
    probe.admission(operationAdmission, (request, grant, admit) => {
      contention.observe(request.stage);
      admit(request, grant);
    });
    await withAuthProfileUsage(store, profileId, undefined, ({ record }) => record(failure(store)));
    expect(contention.observed).toEqual(["transaction:free", "commit:held"]);
    expect(loadPersistedAuthProfileStore()?.usageStats?.[profileId]?.errorCount).toBe(1);
    expect(store.usageStats?.[profileId]?.errorCount).toBe(1);
  });
});
