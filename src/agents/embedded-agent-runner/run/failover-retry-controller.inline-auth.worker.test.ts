import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useSqliteWorkerFault } from "../../../../test/helpers/sqlite-worker-fault.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { runInDetachedAsyncContext } from "../../../shared/detached-async-context.js";
import { writeConfigMachineState } from "../../../state/config-machine-state-write.js";
import { closeOpenClawAgentDatabases } from "../../../state/openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
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
import { prepareSharedAuthStoreOwnershipForNative } from "../../auth-profiles/path-resolve.native.js";
import { loadPersistedAuthProfileStore } from "../../auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore,
  setRuntimeAuthProfileStoreSnapshot,
} from "../../auth-profiles/runtime-snapshots.js";
import {
  SHARED_AUTH_STORE_STATE_KEY,
  readAuthProfileJsonCellText,
} from "../../auth-profiles/sqlite-json.js";
import { inspectPersistedAuthProfileStoreRaw } from "../../auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForRuntime,
  saveAuthProfileStore,
} from "../../auth-profiles/store-runtime.js";
import { withAuthProfileStoreAgentDir } from "../../auth-profiles/store.js";
import type { AuthProfileStore } from "../../auth-profiles/types.js";
import { createRetryController } from "./failover-retry-controller.test-support.js";

const saveStore = (store: AuthProfileStore, agentDir?: string) =>
  saveAuthProfileStore(store, agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
const apiKeyProfile = (provider: string, key: string) => ({
  type: "api_key" as const,
  provider,
  key,
});
const health = (count: number) => ({ errorCount: count, failureCounts: { auth: count } });
const withHealth = (store: AuthProfileStore, count: number): AuthProfileStore => ({
  ...store,
  usageStats: {
    ...store.usageStats,
    [usageId]: { ...store.usageStats?.[usageId], ...health(count) },
  },
});
const healthState = (agentDir: string, caller: AuthProfileStore) => ({
  durable: loadPersistedAuthProfileStore(agentDir),
  caller,
  runtime: getRuntimeAuthProfileStoreSnapshotCore(agentDir),
});
function expectHealthCount(store: AuthProfileStore | null | undefined, count: number) {
  expect(store?.usageStats?.[usageId]).toMatchObject(health(count));
}
const credentials = (store: AuthProfileStore | null | undefined) => [
  store?.profiles,
  store?.order,
  store?.lastGood,
];
function expectPublished(agentDir: string, store: AuthProfileStore) {
  const persisted = loadPersistedAuthProfileStore(agentDir);
  expect([store.usageStats, getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.usageStats]).toEqual([
    persisted?.usageStats,
    persisted?.usageStats,
  ]);
  return persisted;
}
function sharedOwnership(state: OpenClawTestState) {
  const ownership = { location: "state-db" } as const;
  writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, ownership, { env: state.env });
  noteCommittedSharedAuthStoreOwnership(ownership, state.env);
}
async function withoutHostSql(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  run: () => Promise<void>,
) {
  const sql = observeHostDataSql();
  try {
    database.db.prepare("SELECT 1").get();
    expect(sql.calls.some((call) => call.mock.calls.length > 0)).toBe(true);
    sql.calls.forEach((call) => call.mockClear());
    await run();
    expect(sql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  } finally {
    sql.restore();
  }
}
async function withQueuedFailure(
  f: Fixture,
  run: (pending: Promise<void>, release: () => void) => Promise<void>,
  earlier = () => {},
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const queued = createDeferredCore();
  const held = admission.runOpenClawAgentWriteAdmission(
    { agentId: "voice", path: f.database.path, env: f.state.env },
    async () => {
      entered.resolve();
      await release.promise;
      earlier();
    },
  );
  await entered.promise;
  const original = admission.runOpenClawAgentWriteAdmission;
  const spy = vi
    .spyOn(admission, "runOpenClawAgentWriteAdmission")
    .mockImplementation((...args) => {
      const result = original(...args);
      if (args[0].path === f.database.path) {
        queued.resolve();
      }
      return result;
    });
  let settled = false;
  const pending = f.fail().finally(() => {
    settled = true;
  });
  void pending.catch(() => {});
  try {
    await awaitGateBeforeSettlement(
      queued.promise,
      pending,
      "Inline health settled before admission",
    );
    spy.mockRestore();
    expect(settled).toBe(false);
    await run(pending, release.resolve);
  } finally {
    spy.mockRestore();
    release.resolve();
    await Promise.allSettled([held, pending]);
  }
}

type Owner = "local-agent" | "legacy-main" | "main-with-shared-base";
const provider = "fixture-provider";
const usageId = "inline-api-key:fixture-provider";
const siblingId = "fixture-provider:sibling";

const fault = useSqliteWorkerFault([
  {
    name: "reject_inline_health_update",
    match: /^(?:insert into|update) auth_profile_state\b/u,
    sql: `CREATE TEMP TRIGGER reject_inline_health_update BEFORE UPDATE ON main.auth_profile_state
      BEGIN SELECT RAISE(ABORT, 'synthetic inline-health write refused'); END;`,
  },
]);

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
});

async function fixture(state: OpenClawTestState, owner: Owner = "local-agent", empty = false) {
  const config = {
    agents: { entries: { main: {}, voice: {} } },
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
  prepareSharedAuthStoreOwnershipForNative(state.env);
  let sharedBefore: AuthProfileStore | undefined;
  if (owner === "main-with-shared-base") {
    sharedOwnership(state);
    sharedBefore = {
      version: 1,
      profiles: {
        "shared-provider:account": apiKeyProfile("shared-provider", "synthetic-shared-key"),
      },
      order: { "shared-provider": ["shared-provider:account"] },
      lastGood: { "shared-provider": "shared-provider:account" },
    };
    saveStore(sharedBefore, undefined);
    expect(loadPersistedAuthProfileStore()).toEqual(sharedBefore);
  }
  const agentId = owner === "local-agent" ? "voice" : "main";
  const agentDir = state.agentDir(agentId);
  const initial: AuthProfileStore = {
    version: 1,
    profiles: { [siblingId]: apiKeyProfile(provider, "synthetic-sibling-key") },
    order: { [provider]: [siblingId] },
    lastGood: { [provider]: siblingId },
    usageStats: {
      [siblingId]: { lastUsed: 17 },
      [usageId]: {
        ...health(2),
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
    saveStore(initial, agentDir);
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
      profiles: { [siblingId]: apiKeyProfile(provider, "synthetic-child-override") },
      usageStats: { [siblingId]: { lastUsed: 29 } },
    };
    saveStore(child, childDir);
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
  const controller = createRetryController({
    agentDir,
    runParams: { workspaceDir: state.workspaceDir, config },
    runtime: {
      provider,
      modelId: "synthetic-model",
      profileFailureStore: store,
      snapshot: () => ({
        pluginHarnessOwnsTransport: false,
        agentHarness: { id: "embedded" },
      }),
      getApiKeyInfo: () => ({
        apiKey: "synthetic-inline-key",
        mode: "api-key",
        source: "models.json",
      }),
    },
  });
  const fail = (reason: "auth" | "timeout" = "auth") =>
    controller.maybeMarkAuthProfileFailure({ reason });
  return { agentDir, initial, store, database, fail, sharedBefore, derived };
}

type Fixture = Awaited<ReturnType<typeof fixture>> & { state: OpenClawTestState };
function withFixture(run: (fixture: Fixture) => Promise<void>, owner?: Owner, empty?: boolean) {
  return withOpenClawTestState({ label: "inline-auth", scenario: "minimal" }, async (state) =>
    run({ ...(await fixture(state, owner, empty)), state }),
  );
}

it.each<[Owner, boolean]>([
  ["local-agent", false],
  ["legacy-main", false],
  ["main-with-shared-base", false],
  ["local-agent", true],
])("persists %s inline-key failure without host data SQL (empty credentials: %s)", (owner, empty) =>
  withFixture(
    async ({ agentDir, initial, store, database, fail, sharedBefore, derived }) => {
      if (empty) {
        expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("missing");
      }
      await withoutHostSql(database, fail);
      const persisted = expectPublished(agentDir, store);
      if (empty) {
        expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("readable");
      }
      expect(persisted?.usageStats?.[usageId]).toMatchObject({
        ...health(empty ? 1 : 3),
        ...(!empty
          ? {
              cooldownReason: "auth",
              cooldownUntil: initial.usageStats?.[usageId]?.cooldownUntil,
            }
          : {}),
      });
      expect(credentials(persisted)).toEqual(credentials(initial));
      expect(persisted?.usageStats?.[siblingId]).toEqual(initial.usageStats?.[siblingId]);
      if (sharedBefore) {
        expect(loadPersistedAuthProfileStore()).toEqual(sharedBefore);
      }
      if (derived) {
        const child = getRuntimeAuthProfileStoreSnapshotCore(derived.agentDir);
        expect([
          child?.usageStats?.[usageId],
          child?.usageStats?.[siblingId],
          child?.profiles,
        ]).toEqual([
          persisted?.usageStats?.[usageId],
          derived.durable.usageStats?.[siblingId],
          derived.profiles,
        ]);
        expect(loadPersistedAuthProfileStore(derived.agentDir)).toEqual(derived.durable);
      }
    },
    owner,
    empty,
  ),
);

it("rejects a real inline-health write failure without publishing caller or runtime state", () =>
  withFixture(async ({ agentDir, store, fail }) => {
    await fail();
    const before = healthState(agentDir, structuredClone(store));
    fault.enable();
    await expect(fail()).rejects.toThrow("synthetic inline-health write refused");
    expect(healthState(agentDir, store)).toEqual(before);
    fault.disable();
    // This is a new caller request after repair, not an automatic retry of the refused write.
    await fail();
    expectHealthCount(expectPublished(agentDir, store), 4);
  }));

it("rereads durable inline health in FIFO order and publishes before the next admitted reader", () =>
  withFixture(async (f) => {
    const { state, agentDir, initial, store, database } = f;
    const options = { agentId: "voice", path: database.path, env: state.env };
    await withQueuedFailure(
      f,
      async (update, release) => {
        expect(loadPersistedAuthProfileStore(agentDir)?.usageStats?.[usageId]?.errorCount).toBe(2);
        expect(store.usageStats?.[usageId]?.errorCount).toBe(99);
        const following = admission.runOpenClawAgentWriteAdmission(options, () => ({
          durable: loadPersistedAuthProfileStore(agentDir)?.usageStats,
          runtime: getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.usageStats,
        }));
        release();
        try {
          await update;
          const persisted = loadPersistedAuthProfileStore(agentDir);
          expectHealthCount(persisted, 8);
          expect(store.usageStats).toEqual(persisted?.usageStats);
          await expect(following).resolves.toEqual({
            durable: persisted?.usageStats,
            runtime: persisted?.usageStats,
          });
          expect(credentials(persisted)).toEqual(credentials(initial));
          expect(persisted?.usageStats?.[siblingId]).toEqual(initial.usageStats?.[siblingId]);
        } finally {
          await Promise.allSettled([following]);
        }
      },
      () => saveStore(withHealth(initial, 7), agentDir),
    );
  }));

it.each(["agent", "root"] as const)(
  "rejects inline health when its exact %s owner closes while admission is queued",
  (scope) =>
    withFixture(async (f) => {
      const { state, agentDir, store, database } = f;
      const before = healthState(agentDir, structuredClone(store));
      await withQueuedFailure(f, async (update, release) => {
        if (scope === "agent") {
          closeOpenClawAgentDatabaseByPath(database.path, "voice");
        } else {
          closeOpenClawAgentDatabases(state.stateDir);
        }
        release();
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
        expect(
          getOpenClawAgentDatabaseIfOpen({ agentId: "voice", path: database.path, env: state.env }),
        ).toBeUndefined();
        expect(store).toEqual(before.caller);
        const retainedRuntime = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
        if (retainedRuntime) {
          expect(retainedRuntime).toEqual(before.runtime);
        }
        expect(loadPersistedAuthProfileStore(agentDir)).toEqual(before.durable);
      });
    }),
);

it.each(["local", "inherited"] as const)(
  "preserves captured shared usage while the scoped controller updates its %s inline counter",
  (counterOwner) =>
    withFixture(async ({ state, agentDir, initial, store, fail }) => {
      const callerBefore = loadPersistedAuthProfileStore(agentDir);
      const scopedAgentDir = state.agentDir("main");
      const inheritedId = "shared-provider:inherited";
      sharedOwnership(state);
      const shared = withHealth(
        {
          version: 1,
          profiles: {
            [inheritedId]: apiKeyProfile("shared-provider", "synthetic-shared"),
            [siblingId]: apiKeyProfile(provider, "synthetic-shadowed-shared"),
          },
          usageStats: {
            ...initial.usageStats,
            [inheritedId]: { lastUsed: 42 },
            [siblingId]: { lastUsed: 91 },
          },
        },
        7,
      );
      saveStore(shared, undefined);
      if (counterOwner === "inherited") {
        delete initial.usageStats?.[usageId];
        delete initial.usageStats?.[siblingId];
      }
      saveStore(initial, scopedAgentDir);
      setRuntimeAuthProfileStoreSnapshot(initial, scopedAgentDir);
      const sharedDatabase = openOpenClawStateDatabase({ env: state.env });
      const sharedRows = () => ({
        credentials: readAuthProfileJsonCellText(sharedDatabase.db, "store", "shared-state"),
        state: readAuthProfileJsonCellText(sharedDatabase.db, "state", "shared-state"),
      });
      const beforeShared = sharedRows();
      await withAuthProfileStoreAgentDir(scopedAgentDir, state.stateDir, async () => {
        Object.assign(store, loadAuthProfileStoreWithoutExternalProfiles(agentDir));
        expect(store.profiles[inheritedId]).toEqual(shared.profiles[inheritedId]);
        expect(store.profiles[siblingId]).toEqual(initial.profiles[siblingId]);
        await fail();
        const expectedCount = counterOwner === "local" ? 3 : 8;
        const persisted = loadPersistedAuthProfileStore(scopedAgentDir);
        expectHealthCount(persisted, expectedCount);
        expect(store.usageStats?.[usageId]).toEqual(persisted?.usageStats?.[usageId]);
        expect(store.usageStats?.[inheritedId]).toEqual(shared.usageStats?.[inheritedId]);
        const expectedSiblingUsage =
          initial.usageStats?.[siblingId] ?? shared.usageStats?.[siblingId];
        expect(store.usageStats?.[siblingId]).toEqual(expectedSiblingUsage);
        expect(credentials(persisted)).toEqual(credentials(initial));
        expect(persisted?.usageStats?.[inheritedId]).toBeUndefined();
        expect(persisted?.usageStats?.[siblingId]).toEqual(expectedSiblingUsage);
      });
      expect(sharedRows()).toEqual(beforeShared);
      expect(loadPersistedAuthProfileStore(agentDir)).toEqual(callerBefore);
    }),
);

it.each(["local-agent", "legacy-main"] as const)(
  "keeps a confirmed %s inline-health commit after owner close and a throwing invalidation observer",
  (owner) =>
    withFixture(async ({ agentDir, store, database, fail, derived }) => {
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
          const revision = original(...args);
          if (args[2]?.databasePath === database.path && args[1].stateChanged) {
            commits++;
            closing ??= runInDetachedAsyncContext(() =>
              closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId),
            );
            void closing.catch(() => {});
          }
          return revision;
        });
      try {
        await expect(fail()).resolves.toBeUndefined();
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
      expectHealthCount(committed, 3);
      expect(store.usageStats).toEqual(committed?.usageStats);
      if (derived) {
        expect(getRuntimeAuthProfileStoreSnapshotCore(derived.agentDir)).toBeUndefined();
        expect(loadPersistedAuthProfileStore(derived.agentDir)).toEqual(derived.durable);
      }
      await fail();
      const recovered = loadPersistedAuthProfileStore(agentDir);
      expectHealthCount(recovered, 4);
      expect(store.usageStats).toEqual(recovered?.usageStats);
    }, owner),
);

it("leaves inline-key health unchanged after a controller timeout without host data SQL", () =>
  withFixture(async ({ agentDir, store, database, fail }) => {
    const before = healthState(agentDir, structuredClone(store));
    await withoutHostSql(database, () => fail("timeout"));
    expect(healthState(agentDir, store)).toEqual(before);
  }));
