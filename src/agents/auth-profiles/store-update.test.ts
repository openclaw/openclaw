import { copyFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as sqliteWorkerStore from "../../infra/sqlite-worker-store.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import * as executions from "../../state/openclaw-agent-execution.js";
import * as workerPublications from "../../state/openclaw-agent-worker-store.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  connectUserModelAccount,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureGatewayOwnerProfile } from "../../state/user-profiles.js";
import { withEnv } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { noteCommittedSharedAuthStoreOwnership } from "./path-resolve.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { mergeLocalAuthProfileStoreWithInheritedStore } from "./runtime-snapshot-owner.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore,
  registerRuntimeAuthProfileStoreMutationListener,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import * as sqliteRead from "./sqlite-read.js";
import {
  runAuthProfileWriteTransaction,
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import {
  loadAuthProfileStoreForRuntime,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import * as publication from "./store-update-publication.js";
import { withEnvOnlyAuthProfileStore } from "./store.js";
import type { AuthProfileStore } from "./types.js";
import { reserveAuthProfileUsagePreparation } from "./usage-lifecycle.js";

const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
const credential = (key: string) => ({ type: "api_key" as const, provider: "fixture", key });

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
});

it.each([{ target: "agent", save: true }] as const)(
  "keeps env-only $target callbacks isolated (save=$save)",
  async ({ target, save }) => {
    await withOpenClawTestState(
      { label: "auth-env-only-update", scenario: "minimal" },
      async (state) => {
        const localDir = state.agentDir("child");
        const shared = { version: 1, profiles: { shared: credential("synthetic-hidden-shared") } };
        const local = { version: 1, profiles: { local: credential("synthetic-hidden-local") } };
        const empty = { version: 1, profiles: {} };
        const explicit = { version: 1, profiles: { added: credential("synthetic-explicit") } };
        saveAuthProfileStore(shared, undefined, saveOptions);
        saveAuthProfileStore(local, localDir, saveOptions);
        const updater = vi.fn<Parameters<typeof updateAuthProfileStoreWithLock>[0]["updater"]>(
          (store, _owner, inherited) => {
            expect(store).toEqual(empty);
            expect(inherited).toBeNull();
            if (save) {
              store.profiles.added = explicit.profiles.added;
            }
            return save;
          },
        );

        const result = await withEnvOnlyAuthProfileStore(() =>
          updateAuthProfileStoreWithLock({
            agentDir: target === "agent" ? localDir : undefined,
            saveOptions,
            updater,
          }),
        );
        expect(updater).toHaveBeenCalledOnce();
        expect(result).toEqual(save ? explicit : empty);
        expect(loadPersistedAuthProfileStore()).toEqual(shared);
        expect(loadPersistedAuthProfileStore(localDir)).toEqual(save ? explicit : local);
      },
    );
  },
);

it("rejects a native auth owner before initializing its state directory", async () => {
  await withOpenClawTestState(
    { label: "auth-native-owner", scenario: "minimal" },
    async (state) => {
      const refusedRoot = path.join(state.stateDir, "refused");
      expect(() =>
        runAuthProfileWriteTransaction(undefined, () => undefined, {
          stateDir: refusedRoot,
          sharedStoreWrite: true,
          assertEnvironment(env) {
            expect(env.OPENCLAW_STATE_DIR).toBe(refusedRoot);
            throw new Error("synthetic native owner revoked");
          },
        }),
      ).toThrow("synthetic native owner revoked");
      expect(existsSync(refusedRoot)).toBe(false);
    },
  );
});

it.for(["local", "legacy-shared"] as const)(
  "retains the %s physical store before waiting for auth FIFO preparation",
  async (kind) => {
    await withOpenClawTestState(
      { label: "auth-queued-file-identity", scenario: "minimal" },
      async (state) => {
        const agentDir = state.agentDir(kind === "local" ? "child" : "main");
        noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" }, state.env);
        runAuthProfileWriteTransaction(
          agentDir,
          (database) => {
            writePersistedAuthProfileStoreRaw(
              { version: 1, profiles: { selected: credential("synthetic-before") } },
              agentDir,
              database,
            );
          },
          { env: state.env },
        );
        await closeOpenClawAgentDatabasesAsync();
        const databasePath = resolveAuthProfileDatabasePath(agentDir);
        const reservation = reserveAuthProfileUsagePreparation([
          resolveOpenClawStateSqlitePath(state.env),
        ]);
        const updater = vi.fn(() => false);
        const updating = updateAuthProfileStoreWithLock({
          agentDir: kind === "local" ? agentDir : undefined,
          saveOptions,
          updater,
        });
        void updating.catch(() => {});
        try {
          const original = `${databasePath}.original`;
          renameSync(databasePath, original);
          copyFileSync(original, databasePath);
          reservation.release();
          await expect(updating).rejects.toThrow(/identity|physical|observed target/i);
          expect(updater).not.toHaveBeenCalled();
        } finally {
          reservation.release();
          await Promise.allSettled([updating]);
        }
      },
    );
  },
);

it.each(["stale", "newer-write", "rebound-owner"])(
  "invalidates an unacknowledged commit after release with a %s view",
  async (scenario) => {
    await withOpenClawTestState(
      { label: "auth-unknown-commit", scenario: "minimal" },
      async (state) => {
        const agentDir = state.agentDir("child");
        const initial = { version: 1, profiles: { selected: credential("synthetic-before") } };
        saveAuthProfileStore(initial, agentDir, saveOptions);
        setRuntimeAuthProfileStoreSnapshot(initial, agentDir);
        const capture = executions.captureOpenClawAgentDatabaseExecution;
        let execution: ReturnType<typeof capture> | undefined;
        vi.spyOn(executions, "captureOpenClawAgentDatabaseExecution").mockImplementation(
          (...args) => {
            execution = capture(...args);
            return execution;
          },
        );
        const publish = workerPublications.executeOpenClawAgentWorkerPublication;
        vi.spyOn(workerPublications, "executeOpenClawAgentWorkerPublication").mockImplementation(
          async (...args) => {
            await publish(...args);
            if (scenario === "newer-write") {
              saveAuthProfileStore(
                { version: 1, profiles: { selected: credential("synthetic-newer") } },
                agentDir,
                saveOptions,
              );
            }
            if (scenario === "rebound-owner") {
              withEnv({ OPENCLAW_STATE_DIR: path.join(state.stateDir, "rebound") }, () =>
                setRuntimeAuthProfileStoreSnapshot(
                  { version: 1, profiles: { selected: credential("synthetic-rebound") } },
                  agentDir,
                ),
              );
            }
            if (!execution) {
              throw new Error("Missing real auth execution");
            }
            // Release revokes the real borrow synchronously; its pending operation must settle first.
            void execution.release().catch(() => {});
            throw new SqliteWorkerError("Synthetic lost commit acknowledgment", "outcome-unknown");
          },
        );
        await expect(
          updateAuthProfileStoreWithLock({
            agentDir,
            saveOptions,
            updater(store) {
              store.profiles.selected = credential("synthetic-committed");
              return true;
            },
          }),
        ).rejects.toThrow();
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles.selected).toEqual(
          credential(scenario === "newer-write" ? "synthetic-newer" : "synthetic-committed"),
        );
        if (scenario === "newer-write") {
          expect(
            loadAuthProfileStoreForRuntime(agentDir, { syncExternalCli: false }).profiles.selected,
          ).toEqual(credential("synthetic-newer"));
        } else if (scenario === "rebound-owner") {
          expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles.selected).toEqual(
            credential("synthetic-rebound"),
          );
        } else {
          expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
        }
      },
    );
  },
);

it("drops incomplete incremental views after an acknowledged shared publication fails", async () => {
  await withOpenClawTestState(
    { label: "auth-failed-publication", scenario: "minimal" },
    async (state) => {
      const shared = {
        version: 1,
        profiles: {
          selected: credential("synthetic-before"),
          other: credential("synthetic-other"),
        },
      };
      const empty = { version: 1, profiles: {} };
      const agentDir = state.agentDir("child");
      saveAuthProfileStore(shared, undefined, saveOptions);
      saveAuthProfileStore(empty, agentDir, saveOptions);
      setRuntimeAuthProfileStoreSnapshot(shared);
      setRuntimeAuthProfileStoreSnapshot(
        mergeLocalAuthProfileStoreWithInheritedStore(empty, shared),
        agentDir,
      );
      let unregister = () => {};
      vi.spyOn(publication, "publishAuthProfileStoreUpdate").mockImplementation(async () => {
        const newer = loadPersistedAuthProfileStore()!;
        newer.profiles.other = credential("synthetic-native");
        saveAuthProfileStore(newer, undefined, saveOptions);
        unregister = registerRuntimeAuthProfileStoreMutationListener(() => {
          throw new Error("synthetic invalidation observer failure");
        });
        throw new Error("synthetic publication interruption");
      });
      try {
        await updateAuthProfileStoreWithLock({
          sharedStoreWrite: true,
          saveOptions,
          updater(store) {
            store.profiles.selected = credential("synthetic-committed");
            return true;
          },
        });
      } finally {
        unregister();
      }
      const expected = {
        selected: credential("synthetic-committed"),
        other: credential("synthetic-native"),
      };
      expect(loadPersistedAuthProfileStore()?.profiles).toEqual(expected);
      expect(loadAuthProfileStoreForRuntime(agentDir, { syncExternalCli: false }).profiles).toEqual(
        expected,
      );
    },
  );
});

it.each([
  { target: "shared", changed: "selected", rollback: false },
  { target: "shared", changed: "other", rollback: false },
  { target: "agent", changed: "selected", rollback: false },
  { target: "shared", changed: "selected", rollback: true },
])(
  "reconciles an overtaking $target native save of $changed (rollback=$rollback)",
  async ({ target, changed, rollback }) => {
    await withOpenClawTestState(
      { label: "auth-native-overtake", scenario: "minimal" },
      async (state) => {
        const agentDir = target === "agent" ? state.agentDir("child") : undefined;
        const initial: AuthProfileStore = {
          version: 1,
          profiles: {
            selected: credential("synthetic-before"),
            other: credential("synthetic-other"),
          },
        };
        saveAuthProfileStore(initial, agentDir, saveOptions);
        setRuntimeAuthProfileStoreSnapshot(initial, agentDir);
        const derivedDir = state.agentDir("derived");
        if (target === "shared") {
          const empty = { version: 1, profiles: {} };
          saveAuthProfileStore(empty, derivedDir, saveOptions);
          setRuntimeAuthProfileStoreSnapshot(
            mergeLocalAuthProfileStoreWithInheritedStore(empty, initial),
            derivedDir,
          );
        }
        const publish = publication.publishAuthProfileStoreUpdate;
        vi.spyOn(publication, "publishAuthProfileStoreUpdate").mockImplementation(
          async (...args) => {
            const newer = loadPersistedAuthProfileStore(agentDir)!;
            newer.profiles[changed] = credential("synthetic-native");
            if (rollback) {
              expect(() =>
                runAuthProfileWriteTransaction(agentDir, () => {
                  saveAuthProfileStore(newer, agentDir, saveOptions);
                  throw new Error("synthetic rollback");
                }),
              ).toThrow("synthetic rollback");
            } else {
              saveAuthProfileStore(newer, agentDir, saveOptions);
            }
            return publish(...args);
          },
        );
        await updateAuthProfileStoreWithLock({
          agentDir,
          saveOptions,
          updater(store) {
            store.profiles.selected = credential("synthetic-worker");
            return true;
          },
        });
        const expected: AuthProfileStore["profiles"] = {
          ...initial.profiles,
          selected: credential("synthetic-worker"),
        };
        if (!rollback) {
          expected[changed] = credential("synthetic-native");
        }
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles).toEqual(expected);
        expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles).toEqual(expected);
        if (target === "shared") {
          expect(getRuntimeAuthProfileStoreSnapshotCore(derivedDir)?.profiles).toEqual(expected);
        }
      },
    );
  },
);

it.each(["selected"])(
  "does not retain old inherited order when a native rotation of %s overtakes state publication",
  async (profileId) => {
    await withOpenClawTestState(
      { label: "auth-state-overtake", scenario: "minimal" },
      async (state) => {
        const shared: AuthProfileStore = {
          version: 1,
          profiles: {
            selected: credential("synthetic-shared"),
            other: credential("synthetic-other"),
            third: credential("synthetic-third"),
          },
          order: { fixture: ["selected", "other", "third"] },
        };
        const local: AuthProfileStore = {
          version: 1,
          profiles: { selected: credential("synthetic-local") },
        };
        const agentDir = state.agentDir("child");
        saveAuthProfileStore(shared, undefined, saveOptions);
        saveAuthProfileStore(local, agentDir, saveOptions);
        setRuntimeAuthProfileStoreSnapshot(shared);
        setRuntimeAuthProfileStoreSnapshot(
          mergeLocalAuthProfileStoreWithInheritedStore(local, shared),
          agentDir,
        );
        const prepare = sqliteRead.prepareAgentAuthProfileRowsRead;
        let rotated = false;
        vi.spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead").mockImplementation((options) => {
          const reader = prepare(options);
          return {
            ...reader,
            async read() {
              const rows = await reader.read();
              if (!rotated) {
                rotated = true;
                const newer = loadPersistedAuthProfileStore()!;
                newer.profiles[profileId] = credential("synthetic-rotated");
                saveAuthProfileStore(newer, undefined, saveOptions);
              }
              return rows;
            },
          };
        });
        await updateAuthProfileStoreWithLock({
          sharedStoreWrite: true,
          saveOptions,
          updater(store) {
            store.order = { fixture: ["selected", "third", "other"] };
            return true;
          },
        });
        expect(rotated).toBe(true);
        const published = loadAuthProfileStoreForRuntime(agentDir, { syncExternalCli: false });
        expect(published.order).toEqual({ fixture: ["selected", "third", "other"] });
        expect(published.profiles.selected).toEqual(local.profiles.selected);
      },
    );
  },
);

it("keeps a shared rotation that commits while a local save awaits publication", async () => {
  await withOpenClawTestState(
    { label: "auth-shared-rotation", scenario: "minimal" },
    async (state) => {
      const shared: AuthProfileStore = {
        version: 1,
        profiles: { shared: credential("synthetic-shared-before") },
      };
      const local: AuthProfileStore = {
        version: 1,
        profiles: { local: credential("synthetic-local-before") },
      };
      const agentDir = state.agentDir("child");
      saveAuthProfileStore(shared, undefined, saveOptions);
      saveAuthProfileStore(local, agentDir, saveOptions);
      setRuntimeAuthProfileStoreSnapshot(shared);
      setRuntimeAuthProfileStoreSnapshot(
        mergeLocalAuthProfileStoreWithInheritedStore(local, shared),
        agentDir,
      );
      const publish = publication.publishAuthProfileStoreUpdate;
      let rotated = false;
      vi.spyOn(publication, "publishAuthProfileStoreUpdate").mockImplementation(
        async (owner, committed, assertCurrent, nativeCommits, committedIsCurrent) => {
          if (!rotated && owner.databasePath !== owner.sharedDatabasePath) {
            rotated = true;
            await updateAuthProfileStoreWithLock({
              sharedStoreWrite: true,
              saveOptions,
              updater(store) {
                store.profiles.shared = credential("synthetic-shared-after");
                return true;
              },
            });
          }
          return publish(owner, committed, assertCurrent, nativeCommits, committedIsCurrent);
        },
      );
      await updateAuthProfileStoreWithLock({
        agentDir,
        saveOptions,
        updater(store) {
          store.profiles.local = credential("synthetic-local-after");
          return true;
        },
      });
      expect(rotated).toBe(true);
      expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles).toEqual({
        local: credential("synthetic-local-after"),
        shared: credential("synthetic-shared-after"),
      });
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles).toEqual({
        local: credential("synthetic-local-after"),
      });
    },
  );
});

it.each(["before-callback", "in-callback", "commit"] as const)(
  "refuses personal-account update authority revoked at %s",
  async (phase) => {
    await withOpenClawTestState(
      { label: "auth-personal-authority", scenario: "minimal" },
      async () => {
        const original = {
          type: "token" as const,
          provider: "anthropic",
          token: "synthetic-personal-before",
        };
        const { authProfileId } = connectUserModelAccount({
          ownerProfileId: ensureGatewayOwnerProfile("Synthetic owner").id,
          credential: original,
          assertCurrent() {},
        });
        let revoked = phase === "before-callback";
        if (phase === "commit") {
          const createAdmission = sqliteWorkerStore.createSqliteWorkerWriteAdmission;
          vi.spyOn(sqliteWorkerStore, "createSqliteWorkerWriteAdmission").mockImplementation(
            (assertCurrent, nativeLocations, attachment) =>
              createAdmission(
                (request) => {
                  if (request.stage === "commit") {
                    revoked = true;
                  }
                  assertCurrent(request);
                },
                nativeLocations,
                attachment,
              ),
          );
        }
        const updater = vi.fn((store: AuthProfileStore) => {
          store.profiles[authProfileId] = { ...original, token: "synthetic-personal-after" };
          revoked = phase === "in-callback";
          return true;
        });
        await expect(
          updateAuthProfileStoreWithLock({
            profileId: authProfileId,
            updater,
            assertCurrent() {
              if (revoked) {
                throw new Error("synthetic personal authority revoked");
              }
            },
          }),
        ).rejects.toThrow("synthetic personal authority revoked");
        expect(updater).toHaveBeenCalledTimes(phase === "before-callback" ? 0 : 1);
        expect(readUserModelAuthProfile(authProfileId)?.credential).toEqual(original);
      },
    );
  },
);
