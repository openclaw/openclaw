import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { writeConfigMachineState } from "../../../state/config-machine-state-write.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabases,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../../state/openclaw-agent-db.js";
import * as admission from "../../../state/openclaw-agent-write-admission.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { noteCommittedSharedAuthStoreOwnership } from "../../auth-profiles/path-resolve.js";
import { loadPersistedAuthProfileStore } from "../../auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore,
  setRuntimeAuthProfileStoreSnapshot,
} from "../../auth-profiles/runtime-snapshots.js";
import {
  SHARED_AUTH_STORE_STATE_KEY,
  SHARED_STATE_STATE_KEY,
  SHARED_STORE_STATE_KEY,
  readSharedAuthKvCell,
} from "../../auth-profiles/sqlite-json.js";
import { inspectPersistedAuthProfileStoreRaw } from "../../auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForRuntime,
  saveAuthProfileStore,
} from "../../auth-profiles/store-runtime.js";
import { withAuthProfileStoreAgentDir } from "../../auth-profiles/store.js";
import type { AuthProfileStore } from "../../auth-profiles/types.js";
import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";

type Owner = "local-agent" | "legacy-main" | "main-with-shared-base";
const provider = "fixture-provider";
const usageId = "inline-api-key:fixture-provider";
const siblingId = "fixture-provider:sibling";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
});

function observeAdmission(path: string) {
  const queued = createDeferredCore();
  const original = admission.runOpenClawAgentWriteAdmission;
  const spy = vi.spyOn(admission, "runOpenClawAgentWriteAdmission").mockImplementation(
    new Proxy(original, {
      apply(target, receiver, args: Parameters<typeof original>) {
        const result = Reflect.apply(target, receiver, args);
        if (args[0].path === path) {
          queued.resolve();
        }
        return result;
      },
    }),
  );
  return {
    async wait(operation: Promise<void>) {
      try {
        await Promise.race([
          queued.promise,
          operation.then(() => {
            throw new Error("Inline health mutation settled before agent write admission");
          }),
        ]);
      } finally {
        spy.mockRestore();
      }
    },
    restore: () => spy.mockRestore(),
  };
}

async function fixture(state: OpenClawTestState, owner: Owner, empty = false) {
  const config = {
    agents: { list: [{ id: "main", default: true }, { id: "voice" }] },
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://example.invalid/v1",
          api: "openai-completions",
          apiKey: "synthetic-inline-key",
          models: [],
        },
      },
    },
  } satisfies OpenClawConfig;
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config, config);
  let sharedBefore: AuthProfileStore | undefined;
  if (owner === "main-with-shared-base") {
    writeConfigMachineState(
      SHARED_AUTH_STORE_STATE_KEY,
      { location: "state-db" },
      { env: state.env },
    );
    noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, state.env);
    sharedBefore = {
      version: 1,
      profiles: {
        "shared-provider:account": {
          type: "api_key",
          provider: "shared-provider",
          key: "synthetic-shared-key",
        },
      },
      order: { "shared-provider": ["shared-provider:account"] },
      lastGood: { "shared-provider": "shared-provider:account" },
    };
    saveAuthProfileStore(sharedBefore, undefined, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    expect(loadPersistedAuthProfileStore()).toEqual(sharedBefore);
  }
  const agentId = owner === "local-agent" ? "voice" : "main";
  const agentDir = state.agentDir(agentId);
  const initial: AuthProfileStore = {
    version: 1,
    profiles: {
      [siblingId]: { type: "api_key", provider, key: "synthetic-sibling-key" },
    },
    order: { [provider]: [siblingId] },
    lastGood: { [provider]: siblingId },
    usageStats: {
      [siblingId]: { lastUsed: 17 },
      [usageId]: {
        errorCount: 2,
        failureCounts: { auth: 2 },
        lastFailureAt: Date.now(),
        cooldownReason: "auth",
        cooldownUntil: Date.now() + 60 * 60 * 1000,
      },
    },
  };
  const resolvedId = "shared-provider:resolved";
  if (owner === "legacy-main") {
    initial.profiles[resolvedId] = {
      type: "api_key",
      provider: "shared-provider",
      keyRef: { source: "env", provider: "default", id: "SYNTHETIC_INLINE_FANOUT_KEY" },
    };
  }
  if (empty) {
    initial.profiles = {};
    delete initial.order;
    delete initial.lastGood;
    delete initial.usageStats;
  } else {
    saveAuthProfileStore(initial, agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
  }
  setRuntimeAuthProfileStoreSnapshot(initial, agentDir);
  const store = structuredClone(initial);
  // A turn's stale observation must not overwrite the durable failure count.
  if (!empty) {
    store.usageStats = { ...store.usageStats, [usageId]: { errorCount: 99 } };
  }
  const database = openOpenClawAgentDatabase({ agentId, env: state.env });
  let derived:
    | { agentDir: string; durable: AuthProfileStore; profiles: AuthProfileStore["profiles"] }
    | undefined;
  if (owner === "legacy-main") {
    const childDir = state.agentDir("voice");
    const child: AuthProfileStore = {
      version: 1,
      profiles: { [siblingId]: { type: "api_key", provider, key: "synthetic-child-override" } },
      usageStats: { [siblingId]: { lastUsed: 29 } },
    };
    saveAuthProfileStore(child, childDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    const runtime = loadAuthProfileStoreForRuntime(childDir, {
      readOnly: true,
      allowKeychainPrompt: false,
      externalCli: { mode: "none" },
    });
    const resolved = runtime.profiles[resolvedId];
    if (resolved?.type !== "api_key") {
      throw new Error("Expected inherited reference-backed fixture credential");
    }
    resolved.key = "synthetic-materialized-key";
    runtime.profiles["external-provider:runtime"] = {
      type: "oauth",
      provider: "external-provider",
      access: "synthetic-external-access",
      refresh: "synthetic-external-refresh",
      expires: Date.now() + 60 * 60 * 1000,
    };
    runtime.runtimeExternalProfileIds = ["external-provider:runtime"];
    setRuntimeAuthProfileStoreSnapshot(runtime, childDir);
    derived = { agentDir: childDir, durable: child, profiles: structuredClone(runtime.profiles) };
  }
  const controller = createEmbeddedRunFailoverRetryController({
    runParams: {
      runId: "inline-auth-failure-run",
      sessionId: "inline-auth-failure-session",
      sessionFile: state.path("synthetic-session.jsonl"),
      workspaceDir: state.workspaceDir,
      prompt: "synthetic inline-key failure",
      timeoutMs: 60_000,
      config,
    },
    provider,
    modelId: "synthetic-model",
    globalLane: "inline-auth-failure-test",
    agentDir,
    fallbackConfigured: false,
    profileFailureStore: store,
    getLastProfileId: () => undefined,
    getSessionId: () => "inline-auth-failure-session",
    harnessOwnsTransport: () => false,
    getRuntimeAuthOwnerId: () => "embedded",
    getApiKeyInfo: () => ({
      apiKey: "synthetic-inline-key",
      mode: "api-key",
      source: "models.json",
    }),
    advanceAuthProfile: async () => false,
  });
  return { agentDir, initial, store, database, controller, sharedBefore, derived };
}

it.each(["local-agent", "legacy-main", "main-with-shared-base"] as const)(
  "persists %s inline-key failure through the real retry controller without host data SQL",
  async (owner) => {
    await withOpenClawTestState(
      { label: "inline-auth-worker", scenario: "minimal" },
      async (state) => {
        const { agentDir, initial, store, database, controller, sharedBefore, derived } =
          await fixture(state, owner);
        const sql = observeHostDataSql();
        let counts: number[];
        try {
          database.db.prepare("SELECT 1").get();
          expect(sql.calls.some((call) => call.mock.calls.length > 0)).toBe(true);
          sql.calls.forEach((call) => call.mockClear());
          await controller.maybeMarkAuthProfileFailure({ reason: "auth" });
          counts = sql.calls.map((call) => call.mock.calls.length);
        } finally {
          sql.restore();
        }
        const persisted = loadPersistedAuthProfileStore(agentDir);
        expect(persisted?.usageStats?.[usageId]).toMatchObject({
          errorCount: 3,
          failureCounts: { auth: 3 },
          cooldownReason: "auth",
          cooldownUntil: initial.usageStats?.[usageId]?.cooldownUntil,
        });
        expect(store.usageStats).toEqual(persisted?.usageStats);
        expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.usageStats).toEqual(
          persisted?.usageStats,
        );
        expect(persisted?.profiles).toEqual(initial.profiles);
        expect(persisted?.order).toEqual(initial.order);
        expect(persisted?.lastGood).toEqual(initial.lastGood);
        expect(persisted?.usageStats?.[siblingId]).toEqual(initial.usageStats?.[siblingId]);
        if (sharedBefore) {
          expect(loadPersistedAuthProfileStore()).toEqual(sharedBefore);
        }
        if (derived) {
          const child = getRuntimeAuthProfileStoreSnapshotCore(derived.agentDir);
          expect(child?.usageStats?.[usageId]).toEqual(persisted?.usageStats?.[usageId]);
          expect(child?.usageStats?.[siblingId]).toEqual(derived.durable.usageStats?.[siblingId]);
          expect(child?.profiles).toEqual(derived.profiles);
          expect(loadPersistedAuthProfileStore(derived.agentDir)).toEqual(derived.durable);
        }
        expect(counts).toEqual([0, 0, 0, 0, 0, 0]);
      },
    );
  },
);

it("rejects a real inline-health write failure without publishing caller or runtime state", async () => {
  await withOpenClawTestState(
    { label: "inline-auth-rejection", scenario: "minimal" },
    async (state) => {
      const { agentDir, store, database, controller } = await fixture(state, "local-agent");
      // Open the canonical actor before injecting a DML refusal into its validated schema.
      await controller.maybeMarkAuthProfileFailure({ reason: "auth" });
      const before = {
        persisted: loadPersistedAuthProfileStore(agentDir),
        caller: structuredClone(store),
        runtime: getRuntimeAuthProfileStoreSnapshotCore(agentDir),
      };
      database.db.exec(`
        CREATE TRIGGER reject_inline_health_update
        BEFORE UPDATE ON auth_profile_state
        BEGIN
          SELECT RAISE(ABORT, 'synthetic inline-health write refused');
        END;
      `);
      await expect(controller.maybeMarkAuthProfileFailure({ reason: "auth" })).rejects.toThrow(
        "synthetic inline-health write refused",
      );
      expect({
        persisted: loadPersistedAuthProfileStore(agentDir),
        caller: store,
        runtime: getRuntimeAuthProfileStoreSnapshotCore(agentDir),
      }).toEqual(before);
      database.db.exec("DROP TRIGGER reject_inline_health_update");
      // This is a new caller request after repair, not an automatic retry of the refused write.
      await controller.maybeMarkAuthProfileFailure({ reason: "auth" });
      const persisted = loadPersistedAuthProfileStore(agentDir);
      expect(persisted?.usageStats?.[usageId]).toMatchObject({
        errorCount: 4,
        failureCounts: { auth: 4 },
      });
      expect(store.usageStats).toEqual(persisted?.usageStats);
      expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.usageStats).toEqual(
        persisted?.usageStats,
      );
    },
  );
});

it("rereads durable inline health in FIFO order and publishes before the next admitted reader", async () => {
  await withOpenClawTestState({ label: "inline-auth-fifo", scenario: "minimal" }, async (state) => {
    const { agentDir, initial, store, database, controller } = await fixture(state, "local-agent");
    const options = { agentId: "voice", path: database.path, env: state.env };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const earlier = admission.runOpenClawAgentWriteAdmission(options, async () => {
      entered.resolve();
      await release.promise;
      saveAuthProfileStore(
        {
          ...initial,
          usageStats: {
            ...initial.usageStats,
            [usageId]: {
              ...initial.usageStats?.[usageId],
              errorCount: 7,
              failureCounts: { auth: 7 },
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );
    });
    await entered.promise;
    const observation = observeAdmission(database.path);
    let settled = false;
    const update = controller.maybeMarkAuthProfileFailure({ reason: "auth" }).finally(() => {
      settled = true;
    });
    void update.catch(() => {});
    let following: Promise<unknown> | undefined;
    try {
      await observation.wait(update);
      expect(settled).toBe(false);
      expect(loadPersistedAuthProfileStore(agentDir)?.usageStats?.[usageId]?.errorCount).toBe(2);
      expect(store.usageStats?.[usageId]?.errorCount).toBe(99);
      following = admission.runOpenClawAgentWriteAdmission(options, () => ({
        durable: loadPersistedAuthProfileStore(agentDir)?.usageStats,
        runtime: getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.usageStats,
      }));
      release.resolve();
      await earlier;
      await update;
      const persisted = loadPersistedAuthProfileStore(agentDir);
      expect(persisted?.usageStats?.[usageId]).toMatchObject({
        errorCount: 8,
        failureCounts: { auth: 8 },
      });
      expect(store.usageStats).toEqual(persisted?.usageStats);
      await expect(following).resolves.toEqual({
        durable: persisted?.usageStats,
        runtime: persisted?.usageStats,
      });
      expect(persisted?.profiles).toEqual(initial.profiles);
      expect(persisted?.order).toEqual(initial.order);
      expect(persisted?.lastGood).toEqual(initial.lastGood);
      expect(persisted?.usageStats?.[siblingId]).toEqual(initial.usageStats?.[siblingId]);
    } finally {
      observation.restore();
      release.resolve();
      await Promise.allSettled([earlier, update, following]);
    }
  });
});

it.each(["agent", "root"] as const)(
  "rejects inline health when its exact %s owner closes while admission is queued",
  async (scope) => {
    await withOpenClawTestState(
      { label: "inline-auth-revocation", scenario: "minimal" },
      async (state) => {
        const { agentDir, store, database, controller } = await fixture(state, "local-agent");
        const options = { agentId: "voice", path: database.path, env: state.env };
        const before = {
          durable: loadPersistedAuthProfileStore(agentDir),
          caller: structuredClone(store),
          runtime: getRuntimeAuthProfileStoreSnapshotCore(agentDir),
        };
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const held = admission.runOpenClawAgentWriteAdmission(options, async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        const observation = observeAdmission(database.path);
        const update = controller.maybeMarkAuthProfileFailure({ reason: "auth" });
        void update.catch(() => {});
        try {
          await observation.wait(update);
          if (scope === "agent") {
            closeOpenClawAgentDatabaseByPath(database.path, "voice");
          } else {
            closeOpenClawAgentDatabases(state.stateDir);
          }
          release.resolve();
          const error: unknown = await update.then(
            () => undefined,
            (failure: unknown) => failure,
          );
          expect(error).toBeInstanceOf(Error);
          expect(
            collectNestedErrorCandidates(error).some(
              (candidate) =>
                candidate instanceof Error &&
                candidate.message === "Agent database execution admission is closed",
            ),
          ).toBe(true);
          expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
          expect(store).toEqual(before.caller);
          const retainedRuntime = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
          if (retainedRuntime) {
            expect(retainedRuntime).toEqual(before.runtime);
          }
          expect(loadPersistedAuthProfileStore(agentDir)).toEqual(before.durable);
        } finally {
          observation.restore();
          release.resolve();
          await Promise.allSettled([held, update]);
        }
      },
    );
  },
);

it.each(["local", "inherited"] as const)(
  "preserves captured shared usage while the scoped controller updates its %s inline counter",
  async (counterOwner) => {
    await withOpenClawTestState(
      { label: "inline-auth-scope", scenario: "minimal" },
      async (state) => {
        const { agentDir, initial, store, controller } = await fixture(state, "local-agent");
        const callerBefore = loadPersistedAuthProfileStore(agentDir);
        const scopedAgentDir = state.agentDir("main");
        const inheritedId = "shared-provider:inherited";
        writeConfigMachineState(
          SHARED_AUTH_STORE_STATE_KEY,
          { location: "state-db" },
          { env: state.env },
        );
        noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, state.env);
        const shared: AuthProfileStore = {
          version: 1,
          profiles: {
            [inheritedId]: {
              type: "api_key",
              provider: "shared-provider",
              key: "synthetic-shared",
            },
            [siblingId]: { type: "api_key", provider, key: "synthetic-shadowed-shared" },
          },
          usageStats: {
            [inheritedId]: { lastUsed: 42 },
            [siblingId]: { lastUsed: 91 },
            [usageId]: {
              ...initial.usageStats?.[usageId],
              errorCount: 7,
              failureCounts: { auth: 7 },
            },
          },
        };
        saveAuthProfileStore(shared, undefined, {
          filterExternalAuthProfiles: false,
          syncExternalCli: false,
        });
        if (counterOwner === "inherited") {
          delete initial.usageStats?.[usageId];
          delete initial.usageStats?.[siblingId];
        }
        saveAuthProfileStore(initial, scopedAgentDir, {
          filterExternalAuthProfiles: false,
          syncExternalCli: false,
        });
        setRuntimeAuthProfileStoreSnapshot(initial, scopedAgentDir);
        const sharedDatabase = openOpenClawStateDatabase({ env: state.env });
        const sharedRows = () => ({
          credentials: readSharedAuthKvCell(sharedDatabase.db, SHARED_STORE_STATE_KEY),
          state: readSharedAuthKvCell(sharedDatabase.db, SHARED_STATE_STATE_KEY),
        });
        const beforeShared = sharedRows();
        await withAuthProfileStoreAgentDir(scopedAgentDir, state.stateDir, async () => {
          Object.assign(store, loadAuthProfileStoreWithoutExternalProfiles(agentDir));
          expect(store.profiles[inheritedId]).toEqual(shared.profiles[inheritedId]);
          expect(store.profiles[siblingId]).toEqual(initial.profiles[siblingId]);
          await controller.maybeMarkAuthProfileFailure({ reason: "auth" });
          const expectedCount = counterOwner === "local" ? 3 : 8;
          const persisted = loadPersistedAuthProfileStore(scopedAgentDir);
          expect(persisted?.usageStats?.[usageId]).toMatchObject({
            errorCount: expectedCount,
            failureCounts: { auth: expectedCount },
          });
          expect(store.usageStats?.[usageId]).toEqual(persisted?.usageStats?.[usageId]);
          expect(store.usageStats?.[inheritedId]).toEqual(shared.usageStats?.[inheritedId]);
          const expectedSiblingUsage =
            initial.usageStats?.[siblingId] ?? shared.usageStats?.[siblingId];
          expect(store.usageStats?.[siblingId]).toEqual(expectedSiblingUsage);
          expect(persisted?.profiles).toEqual(initial.profiles);
          expect(persisted?.usageStats?.[inheritedId]).toBeUndefined();
          expect(persisted?.usageStats?.[siblingId]).toEqual(expectedSiblingUsage);
          expect(persisted?.order).toEqual(initial.order);
          expect(persisted?.lastGood).toEqual(initial.lastGood);
        });
        expect(sharedRows()).toEqual(beforeShared);
        expect(loadPersistedAuthProfileStore(agentDir)).toEqual(callerBefore);
      },
    );
  },
);

it("creates an empty credential anchor when a fresh agent records an inline-key failure", async () => {
  await withOpenClawTestState(
    { label: "inline-auth-empty", scenario: "minimal" },
    async (state) => {
      const { agentDir, store, controller } = await fixture(state, "local-agent", true);
      expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("missing");
      await controller.maybeMarkAuthProfileFailure({ reason: "auth" });
      expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("readable");
      const persisted = loadPersistedAuthProfileStore(agentDir);
      expect(persisted?.profiles).toEqual({});
      expect(persisted?.usageStats?.[usageId]).toMatchObject({
        errorCount: 1,
        failureCounts: { auth: 1 },
      });
      expect(store.usageStats).toEqual(persisted?.usageStats);
      expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.usageStats).toEqual(
        persisted?.usageStats,
      );
    },
  );
});

it.each(["local-agent", "legacy-main"] as const)(
  "keeps a confirmed %s inline-health commit after owner close and a throwing invalidation observer",
  async (owner) => {
    await withOpenClawTestState(
      { label: "inline-auth-committed", scenario: "minimal" },
      async (state) => {
        const { agentDir, store, database, controller, derived } = await fixture(state, owner);
        const snapshots = await import("../../auth-profiles/runtime-snapshots.js");
        const original = snapshots.noteRuntimeAuthProfileStorePersistedMutation;
        let closing: Promise<boolean> | undefined;
        let commits = 0;
        let invalidations = 0;
        const unregister = snapshots.registerRuntimeAuthProfileStoreMutationListener((event) => {
          if (event.agentDir === agentDir) {
            invalidations++;
            throw new Error("synthetic snapshot observer failure");
          }
        });
        const publication = vi
          .spyOn(snapshots, "noteRuntimeAuthProfileStorePersistedMutation")
          .mockImplementation((...args) => {
            original(...args);
            if (args[2]?.databasePath === database.path && args[1].stateChanged) {
              commits++;
              closing ??= closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
              void closing.catch(() => {});
            }
          });
        try {
          await expect(
            controller.maybeMarkAuthProfileFailure({ reason: "auth" }),
          ).resolves.toBeUndefined();
          expect(closing).toBeDefined();
          await closing;
        } finally {
          publication.mockRestore();
          unregister();
          await closing;
        }
        expect(commits).toBe(1);
        expect(invalidations).toBeGreaterThan(0);
        expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
        const committed = loadPersistedAuthProfileStore(agentDir);
        expect(committed?.usageStats?.[usageId]).toMatchObject({
          errorCount: 3,
          failureCounts: { auth: 3 },
        });
        expect(store.usageStats).toEqual(committed?.usageStats);
        if (derived) {
          expect(getRuntimeAuthProfileStoreSnapshotCore(derived.agentDir)).toBeUndefined();
          expect(loadPersistedAuthProfileStore(derived.agentDir)).toEqual(derived.durable);
        }
        await controller.maybeMarkAuthProfileFailure({ reason: "auth" });
        const recovered = loadPersistedAuthProfileStore(agentDir);
        expect(recovered?.usageStats?.[usageId]).toMatchObject({
          errorCount: 4,
          failureCounts: { auth: 4 },
        });
        expect(store.usageStats).toEqual(recovered?.usageStats);
      },
    );
  },
);

it("leaves inline-key health unchanged after a controller timeout without host data SQL", async () => {
  await withOpenClawTestState(
    { label: "inline-auth-timeout", scenario: "minimal" },
    async (state) => {
      const { agentDir, store, database, controller } = await fixture(state, "local-agent");
      const before = {
        durable: loadPersistedAuthProfileStore(agentDir),
        caller: structuredClone(store),
        runtime: getRuntimeAuthProfileStoreSnapshotCore(agentDir),
      };
      const sql = observeHostDataSql();
      try {
        database.db.prepare("SELECT 1").get();
        expect(sql.calls.some((call) => call.mock.calls.length > 0)).toBe(true);
        sql.calls.forEach((call) => call.mockClear());
        await controller.maybeMarkAuthProfileFailure({ reason: "timeout" });
        expect(sql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
      } finally {
        sql.restore();
      }
      expect({
        durable: loadPersistedAuthProfileStore(agentDir),
        caller: store,
        runtime: getRuntimeAuthProfileStoreSnapshotCore(agentDir),
      }).toEqual(before);
    },
  );
});
