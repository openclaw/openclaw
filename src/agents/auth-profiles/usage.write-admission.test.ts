import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
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
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  noteCommittedSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnership,
  SHARED_AUTH_STORE_STATE_KEY,
} from "./path-resolve.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { runAuthProfileWriteTransaction } from "./sqlite.js";
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
