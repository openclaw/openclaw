import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import * as migration from "./legacy-source-diagnostic.js";
import * as authPaths from "./path-resolve.js";
import * as persisted from "./persisted.js";
import { createAuthProfileStoreRuntimeReader } from "./runtime-read.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  clearRuntimeAuthProfileStoreSnapshotCore,
  noteRuntimeAuthProfileStorePersistedMutation,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import * as sqliteRead from "./sqlite-read.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import { createAuthProfileStoreRuntime } from "./store.js";
import type { AuthProfileStore, AuthProfileRowRead } from "./types.js";

function prepareProviderReader(
  options: {
    shared?: AuthProfileStore;
    isolated?: boolean;
    envOnly?: boolean;
    inherited?: boolean;
    unbound?: boolean;
    preparedStore?: AuthProfileStore;
  } = {},
) {
  const root = tempDirs.make("openclaw-profile-provider-read-");
  const agentDir = path.join(root, "agents/worker/agent");
  const inheritedDir = options.inherited ? path.join(root, "agents/main/agent") : agentDir;
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  reader.read.mockReset().mockResolvedValue({
    store: { status: "readable", raw: { version: 1, profiles: {} } },
    state: { status: "missing", reason: "row" },
    cacheable: false,
  });
  reader.assertCurrent.mockReset();
  reader.dispose.mockReset().mockResolvedValue(undefined);
  const overlay = vi.fn(() => {
    throw new Error("selection metadata must not compose external credentials");
  });
  const storeView = vi.fn((store: AuthProfileStore) => options.preparedStore ?? store);
  const runtime = createAuthProfileStoreRuntimeReader({
    isEnvOnlyAuthProfileRuntime: () => options.envOnly === true,
    getScopedAuthProfileEnv: () => undefined,
    getScopedSharedAuthStore: () => options.shared,
    resolveRuntimeAuthProfileAgentDir: (directory) => directory,
    resolveRuntimeAuthProfileLoadOptions: (loadOptions) =>
      options.unbound ? loadOptions : { ...loadOptions, inheritedAuthDir: inheritedDir },
    loadAuthProfileStoreForAgent: (_dir, _options, _env, rows) => {
      if (!rows) {
        throw new Error("selection metadata requires prepared rows");
      }
      return storeView(
        sqliteRead.loadPersistedAuthProfileStoreFromRows(rows, "fixture-owner") ?? {
          version: 1,
          profiles: {},
        },
      );
    },
    overlayExternalAuthProfiles: overlay,
    captureScope: () => ({ isolated: options.isolated === true, run: (_dir, _env, run) => run() }),
  });
  const synchronousRead = vi
    .spyOn(persisted, "loadPersistedAuthProfileStore")
    .mockImplementation(() => {
      throw new Error("unexpected synchronous persisted read");
    });
  return { agentDir, inheritedDir, runtime, overlay, synchronousRead, storeView };
}

function providerRows(provider: string | undefined): AuthProfileRowRead {
  return {
    store: {
      status: "readable",
      raw: {
        version: 1,
        profiles: provider ? { account: { type: "api_key", provider, key: "fixture" } } : {},
      },
    },
    state: { status: "missing", reason: "row" },
    cacheable: false,
  };
}

const reader = vi.hoisted(() => ({
  read: vi.fn(),
  assertCurrent: vi.fn(),
  dispose: vi.fn(async () => {}),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead").mockReturnValue(reader);
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  migration.clearAuthProfileMigrationDiagnostics();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("prepares published provider metadata without opening persisted readers", async () => {
  const { agentDir, runtime, synchronousRead } = prepareProviderReader();
  setRuntimeAuthProfileStoreSnapshot(
    {
      version: 1,
      profiles: {
        account: { type: "api_key", provider: "published", key: "fixture" },
      },
    },
    agentDir,
  );
  await expect(
    runtime.prepareAuthProfileProviderForSelection({ agentDir, profileId: "account" }),
  ).resolves.toEqual({ profileId: "account", provider: "published" });
  expect(sqliteRead.prepareAgentAuthProfileRowsRead).not.toHaveBeenCalled();
  expect(reader.read).not.toHaveBeenCalled();
  expect(synchronousRead).not.toHaveBeenCalled();
});

it("uses a published shared provider before unreadable persisted rows", async () => {
  const { runtime, synchronousRead } = prepareProviderReader();
  setRuntimeAuthProfileStoreSnapshot({
    version: 1,
    profiles: { account: { type: "api_key", provider: "published", key: "fixture" } },
  });
  const failure = new Error("fixture persisted rows are unreadable");
  reader.read.mockRejectedValue(failure);
  const sharedRead = vi.spyOn(sqliteRead, "readSharedAuthProfileRows").mockRejectedValue(failure);
  await expect(
    runtime.prepareAuthProfileProviderForSelection({ profileId: "account" }),
  ).resolves.toEqual({
    profileId: "account",
    provider: "published",
  });
  expect(sqliteRead.prepareAgentAuthProfileRowsRead).not.toHaveBeenCalled();
  expect(reader.read).not.toHaveBeenCalled();
  expect(sharedRead).not.toHaveBeenCalled();
  expect(synchronousRead).not.toHaveBeenCalled();
});

it.each([
  { local: "local", inherited: "shared", expected: "local" },
  { local: undefined, inherited: "shared", expected: "shared" },
  { local: undefined, inherited: undefined, expected: undefined },
])(
  "prepares raw local=$local/inherited=$inherited metadata with explicit absence",
  async ({ local, inherited, expected }) => {
    const { agentDir, runtime, overlay, synchronousRead } = prepareProviderReader({
      inherited: true,
    });
    reader.read
      .mockResolvedValueOnce(providerRows(local))
      .mockResolvedValueOnce(providerRows(inherited));
    await expect(
      runtime.prepareAuthProfileProviderForSelection({ agentDir, profileId: "account" }),
    ).resolves.toEqual({ profileId: "account", provider: expected });
    expect(reader.read).toHaveBeenCalledTimes(local ? 1 : 2);
    expect(reader.dispose).toHaveBeenCalledTimes(2);
    expect(overlay).not.toHaveBeenCalled();
    expect(synchronousRead).not.toHaveBeenCalled();
  },
);

it("uses selected raw provider metadata before unrelated shared-owner refusal", async () => {
  const { agentDir, runtime, synchronousRead } = prepareProviderReader({ unbound: true });
  reader.read.mockResolvedValueOnce(providerRows("selected"));
  const sharedOwner = vi
    .spyOn(authPaths, "resolveSharedAuthStoreOwnershipAsync")
    .mockRejectedValue(new Error("fixture unrelated shared-owner refusal"));
  await expect(
    runtime.prepareAuthProfileProviderForSelection({ agentDir, profileId: "account" }),
  ).resolves.toEqual({ profileId: "account", provider: "selected" });
  expect(sharedOwner).not.toHaveBeenCalled();
  expect(reader.read).toHaveBeenCalledTimes(1);
  expect(reader.dispose).toHaveBeenCalledTimes(2);
  expect(synchronousRead).not.toHaveBeenCalled();
});

it("projects the raw selected credential before a transformed host store", async () => {
  const { agentDir, runtime, storeView, overlay } = prepareProviderReader({
    preparedStore: {
      version: 1,
      profiles: { replacement: { type: "api_key", provider: "transformed", key: "fixture" } },
    },
  });
  reader.read.mockResolvedValueOnce(providerRows("raw-selected"));
  await expect(
    runtime.prepareAuthProfileProviderForSelection({ agentDir, profileId: "account" }),
  ).resolves.toEqual({ profileId: "account", provider: "raw-selected" });
  expect(storeView).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    profiles: { account: { type: "api_key", provider: "raw-selected", key: "fixture" } },
  });
  expect(overlay).not.toHaveBeenCalled();
  expect(reader.dispose).toHaveBeenCalledTimes(1);
});

it("uses captured shared facts and excludes the ambient runtime snapshot", async () => {
  const shared: AuthProfileStore = {
    version: 1,
    profiles: {
      account: { type: "token", provider: "portable", token: "fixture" },
    },
  };
  const { agentDir, runtime } = prepareProviderReader({ shared, isolated: true });
  setRuntimeAuthProfileStoreSnapshot(
    {
      version: 1,
      profiles: {
        account: { type: "api_key", provider: "ambient", key: "fixture" },
        private: { type: "api_key", provider: "ambient", key: "fixture" },
      },
    },
    agentDir,
  );
  await expect(
    runtime.prepareAuthProfileProviderForSelection({ agentDir, profileId: "account" }),
  ).resolves.toEqual({ profileId: "account", provider: "portable" });
  await expect(
    runtime.prepareAuthProfileProviderForSelection({ agentDir, profileId: "private" }),
  ).resolves.toEqual({ profileId: "private", provider: undefined });
});

it.each([{ envOnly: true }, { isolated: true }])(
  "does not read a personal account in an isolated scope: %j",
  async (scope) => {
    const { agentDir, runtime } = prepareProviderReader(scope);
    const personalRead = vi.spyOn(sqliteRead, "readUserModelAuthProfileAsync");
    const profileId =
      "personal:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
    await expect(
      runtime.prepareAuthProfileProviderForSelection({ agentDir, profileId }),
    ).resolves.toEqual({ profileId, provider: undefined });
    expect(personalRead).not.toHaveBeenCalled();
    expect(sqliteRead.prepareAgentAuthProfileRowsRead).not.toHaveBeenCalled();
  },
);

it.each(["selected", "shared"] as const)(
  "prepares the %s personal account without unrelated shared-auth ownership",
  async (scope) => {
    const { agentDir, runtime } = prepareProviderReader();
    const unrelatedOwner = vi
      .spyOn(authPaths, "resolveSharedAuthStoreOwnershipAsync")
      .mockRejectedValue(new Error("INVALID_SHARED_AUTH_STORE_OWNERSHIP"));
    const personalRead = vi.spyOn(sqliteRead, "readUserModelAuthProfileAsync").mockResolvedValue({
      credential: { type: "token", provider: "personal-provider", token: "fixture" },
    });
    const profileId =
      "personal:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
    await expect(
      runtime.prepareAuthProfileProviderForSelection({
        agentDir: scope === "selected" ? agentDir : undefined,
        profileId,
      }),
    ).resolves.toEqual({ profileId, provider: "personal-provider" });
    expect(personalRead).toHaveBeenCalledExactlyOnceWith(profileId, expect.anything());
    expect(unrelatedOwner).not.toHaveBeenCalled();
    expect(sqliteRead.prepareAgentAuthProfileRowsRead).not.toHaveBeenCalled();
  },
);

it.each(["selected", "inherited", "invalidated", "cleanup"] as const)(
  "retains the actual %s failure and joins provider readers",
  async (failure) => {
    const { agentDir, runtime } = prepareProviderReader({ inherited: true });
    const error = new Error(`fixture ${failure} refusal`);
    if (failure === "selected") {
      reader.read.mockRejectedValueOnce(error);
    }
    if (failure === "inherited") {
      reader.read.mockResolvedValueOnce(providerRows(undefined)).mockRejectedValueOnce(error);
    }
    if (failure === "invalidated") {
      reader.assertCurrent.mockImplementation(() => {
        throw error;
      });
    }
    if (failure === "cleanup") {
      reader.dispose.mockRejectedValueOnce(error);
    }
    await expect(
      runtime.prepareAuthProfileProviderForSelection({ agentDir, profileId: "account" }),
    ).rejects.toBe(error);
    expect(reader.dispose).toHaveBeenCalledTimes(2);
  },
);

it("keeps cached credentials and selection state separate from mutable runtime views", async () => {
  const root = tempDirs.make("openclaw-auth-cached-mutation-");
  const localDir = path.join(root, "agents/worker/agent");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const persistedStore: AuthProfileStore = {
    version: 1,
    profiles: {
      "custom:key": {
        type: "api_key",
        provider: "custom",
        keyRef: { source: "env", provider: "default", id: "CUSTOM_KEY" },
        metadata: { account: "original" },
      },
      "custom:token": {
        type: "token",
        provider: "custom",
        tokenRef: { source: "env", provider: "default", id: "CUSTOM_TOKEN" },
      },
      "custom:oauth": {
        type: "oauth",
        provider: "custom",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: 4_102_444_800_000,
        oauthRef: {
          source: "openclaw-credentials",
          provider: "openai-codex",
          id: "a".repeat(32),
        },
        setup: { replacement: true, modelRef: "custom/model", configJson: "{}" },
      },
    },
  };
  const state = {
    order: { custom: ["custom:key", "custom:token"] },
    lastGood: { custom: "custom:key" },
    usageStats: { "custom:key": { errorCount: 1, failureCounts: { auth: 1 } } },
  };
  reader.assertCurrent.mockReset();
  reader.read.mockReset().mockResolvedValue({
    store: { status: "readable", raw: persistedStore },
    state: { status: "readable", raw: state },
    cacheable: true,
  });
  const overlay = vi.fn((store: AuthProfileStore) => {
    expect(store.profiles).toEqual(persistedStore.profiles);
    const key = store.profiles["custom:key"];
    const token = store.profiles["custom:token"];
    const oauth = store.profiles["custom:oauth"];
    if (key?.type !== "api_key" || token?.type !== "token" || oauth?.type !== "oauth") {
      throw new Error("fixture credential types changed");
    }
    key.keyRef!.id = "OVERLAY_KEY";
    key.metadata!.account = "overlay";
    token.tokenRef!.id = "OVERLAY_TOKEN";
    oauth.oauthRef!.id = "b".repeat(32);
    oauth.setup!.modelRef = "custom/overlay";
    return store;
  });
  const runtime = createAuthProfileStoreRuntime({
    listRuntimeExternalAuthProfiles: () => [],
    overlayExternalAuthProfiles: overlay,
  });
  for (let i = 0; i < 2; i++) {
    const store = await runtime.loadAuthProfileStoreForRuntimeAsync(localDir, {
      inheritedAuthDir: localDir,
      externalCli: { mode: "none" },
    });
    expect(store.order).toEqual(state.order);
    expect(store.lastGood).toEqual(state.lastGood);
    expect(store.usageStats).toEqual(state.usageStats);
    store.order!.custom!.push("custom:oauth");
    store.lastGood!.custom = "custom:token";
    store.usageStats!["custom:key"]!.failureCounts!.auth = 9;
    delete store.profiles["custom:token"];
  }
  expect(overlay).toHaveBeenCalledTimes(2);
  expect(reader.read).toHaveBeenCalledTimes(1);
});

function prepareCachedRuntimeRead() {
  const root = tempDirs.make("openclaw-auth-identity-probes-");
  const agentDir = path.join(root, "agents/worker/agent");
  fs.mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  reader.assertCurrent.mockReset();
  const rows: AuthProfileRowRead = {
    store: { status: "readable", raw: { version: 1, profiles: {} } },
    state: { status: "missing", reason: "row" },
    cacheable: true,
  };
  reader.read.mockReset().mockResolvedValue(rows);
  const runtime = createAuthProfileStoreRuntime({
    listRuntimeExternalAuthProfiles: () => [],
    overlayExternalAuthProfiles: (store) => store,
  });
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  return {
    agentDir,
    databasePath: path.join(agentDir, "openclaw-agent.sqlite"),
    rows,
    clock,
    load: () =>
      runtime.loadAuthProfileStoreForRuntimeAsync(agentDir, {
        inheritedAuthDir: agentDir,
        externalCli: { mode: "none" },
      }),
  };
}

it.each(["", "-wal", "-journal"])(
  "coalesces warm identity probes and detects external %s changes after 100 ms",
  async (suffix) => {
    const { databasePath, clock, load } = prepareCachedRuntimeRead();
    await load();
    const stat = vi.spyOn(fs, "statSync");
    for (const elapsed of [1, 50, 99]) {
      clock.mockReturnValue(elapsed);
      await expect(load()).resolves.toMatchObject({ profiles: {} });
    }
    expect(stat).not.toHaveBeenCalled();
    expect(reader.read).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(100);
    await load();
    expect(stat.mock.calls.map(([file]) => file)).toEqual([
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-journal`,
    ]);
    expect(reader.read).toHaveBeenCalledTimes(1);

    fs.writeFileSync(databasePath + suffix, "synthetic external write");
    reader.read.mockResolvedValue({
      store: {
        status: "readable",
        raw: {
          version: 1,
          profiles: { "custom:new": { type: "api_key", provider: "custom", key: "fixture-new" } },
        },
      },
      state: { status: "missing", reason: "row" },
      cacheable: true,
    });
    clock.mockReturnValue(199);
    await expect(load()).resolves.toMatchObject({ profiles: {} });
    clock.mockReturnValue(200);
    expect((await load()).profiles["custom:new"]).toMatchObject({ key: "fixture-new" });
    expect(reader.read).toHaveBeenCalledTimes(2);
  },
);

it("invalidates warm rows immediately after an owner bookkeeping write", async () => {
  const { agentDir, rows, load } = prepareCachedRuntimeRead();
  await load();
  noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
    credentialsChanged: false,
    stateChanged: true,
    profileIds: [],
  });
  reader.read.mockResolvedValue({
    ...rows,
    state: { status: "readable", raw: { version: 1, lastGood: { custom: "custom:new" } } },
  });
  await expect(load()).resolves.toMatchObject({ lastGood: { custom: "custom:new" } });
  expect(reader.read).toHaveBeenCalledTimes(2);
});

it("does not retain rows when identity changes during a cold read", async () => {
  const { databasePath, rows, load } = prepareCachedRuntimeRead();
  reader.read.mockImplementationOnce(async () => {
    fs.writeFileSync(`${databasePath}-wal`, "synthetic pending write");
    return rows;
  });
  await load();
  await load();
  expect(reader.read).toHaveBeenCalledTimes(2);
});

it("does not extend the probe interval by time spent awaiting a cold read", async () => {
  const { databasePath, rows, clock, load } = prepareCachedRuntimeRead();
  reader.read.mockImplementationOnce(async () => {
    clock.mockReturnValue(100);
    return rows;
  });
  await load();
  fs.writeFileSync(`${databasePath}-wal`, "synthetic external write");
  await load();
  expect(reader.read).toHaveBeenCalledTimes(2);
});

it.each([
  "rotation",
  "all-clear",
  "owner-clear",
  "all-clear-and-publish",
  "owner-clear-and-publish",
] as const)("rejects cached rows after %s during inherited preparation", async (change) => {
  const root = tempDirs.make("openclaw-auth-cached-rotation-");
  const localDir = path.join(root, "agents/worker/agent");
  const inheritedDir = path.join(root, "agents/main/agent");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  reader.assertCurrent.mockReset();
  reader.read.mockReset().mockResolvedValue({
    store: { status: "readable", raw: { version: 1, profiles: {} } },
    state: { status: "missing", reason: "row" },
    cacheable: true,
  });
  const runtime = createAuthProfileStoreRuntime({
    listRuntimeExternalAuthProfiles: () => [],
    overlayExternalAuthProfiles: (store) => store,
  });
  await runtime.loadAuthProfileStoreForRuntimeAsync(localDir, {
    inheritedAuthDir: localDir,
    externalCli: { mode: "none" },
  });
  reader.read.mockImplementationOnce(async () => {
    if (change === "all-clear" || change === "all-clear-and-publish") {
      clearRuntimeAuthProfileStoreSnapshots();
    } else if (change === "owner-clear" || change === "owner-clear-and-publish") {
      clearRuntimeAuthProfileStoreSnapshotCore(localDir);
    } else {
      noteRuntimeAuthProfileStorePersistedMutation(localDir, {
        credentialsChanged: true,
        stateChanged: false,
        profileIds: ["custom:local"],
      });
    }
    if (change.endsWith("-and-publish")) {
      setRuntimeAuthProfileStoreSnapshot({ version: 1, profiles: {} }, localDir);
    }
    return {
      store: { status: "readable", raw: { version: 1, profiles: {} } },
      state: { status: "missing", reason: "row" },
      cacheable: true,
    };
  });
  await expect(
    runtime.loadAuthProfileStoreForRuntimeAsync(localDir, {
      inheritedAuthDir: inheritedDir,
      externalCli: { mode: "none" },
    }),
  ).rejects.toThrow("Auth profile store changed during its runtime read");
  expect(reader.read).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "rechecks retired files after an inherited read with populated local SQLite: %s",
  async (populated) => {
    const root = tempDirs.make("openclaw-async-auth-migration-");
    const localDir = path.join(root, "agents/worker/agent");
    const inheritedDir = path.join(root, "agents/main/agent");
    fs.mkdirSync(localDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const local: AuthProfileStore = {
      version: 1,
      profiles: populated
        ? { "custom:local": { type: "api_key", provider: "custom", key: "fixture-local" } }
        : {},
    };
    const inheritedReadStarted = createDeferredCore();
    const inheritedRows = createDeferredCore<AuthProfileRowRead>();
    reader.assertCurrent.mockReset();
    reader.read.mockReset();
    reader.read.mockResolvedValueOnce({
      store: { status: "readable", raw: local },
      state: { status: "missing", reason: "row" },
      cacheable: true,
    });
    reader.read.mockImplementationOnce(() => {
      inheritedReadStarted.resolve();
      return inheritedRows.promise;
    });
    const runtime = createAuthProfileStoreRuntime({
      listRuntimeExternalAuthProfiles: () => [],
      overlayExternalAuthProfiles: (store) => store,
    });
    const inherited: AuthProfileRowRead = {
      store: {
        status: "readable",
        raw: {
          version: 1,
          profiles: {
            "custom:inherited": { type: "api_key", provider: "custom", key: "fixture-inherited" },
          },
        },
      },
      state: { status: "missing", reason: "row" },
      cacheable: true,
    };
    const loading = runtime.loadAuthProfileStoreForRuntimeAsync(localDir, {
      inheritedAuthDir: inheritedDir,
      externalCli: { mode: "none" },
    });
    try {
      await Promise.race([
        inheritedReadStarted.promise,
        loading.then(() => {
          throw new Error("Auth read completed before the inherited read barrier");
        }),
      ]);
      fs.writeFileSync(
        path.join(localDir, "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: {
            "custom:legacy": { type: "api_key", provider: "custom", key: "fixture-legacy" },
          },
        }),
      );
      inheritedRows.resolve(inherited);
      if (populated) {
        await expect(loading).resolves.toMatchObject({ profiles: local.profiles });
      } else {
        await expect(loading).rejects.toMatchObject({ code: "AUTH_PROFILE_MIGRATION_REQUIRED" });
      }
      expect(reader.read).toHaveBeenCalledTimes(2);
    } finally {
      inheritedRows.resolve(inherited);
      await Promise.allSettled([inheritedRows.promise, loading]);
    }
  },
);

it("rejects a revoked read before publishing host migration facts", async () => {
  const revoked = new Error("read owner revoked before host continuation");
  let active = true;
  reader.read.mockImplementation(async () => {
    active = false;
    return {
      store: { status: "readable", raw: { version: 1, profiles: {} } },
      state: { status: "missing", reason: "row" },
      cacheable: true,
    };
  });
  reader.assertCurrent.mockImplementation(() => {
    if (!active) {
      throw revoked;
    }
  });
  const migrationCandidates = vi
    .spyOn(migration, "assertAuthProfileMigrationCandidates")
    .mockImplementation(() => {});
  const overlayExternalAuthProfiles = vi.fn((store: AuthProfileStore) => store);
  const runtime = createAuthProfileStoreRuntime({
    listRuntimeExternalAuthProfiles: () => [],
    overlayExternalAuthProfiles,
  });

  await expect(
    runtime.loadAuthProfileStoreForRuntimeAsync("/fixture/agent", {
      inheritedAuthDir: "/fixture/agent",
      readOnly: true,
    }),
  ).rejects.toBe(revoked);

  expect(migrationCandidates).not.toHaveBeenCalled();
  expect(overlayExternalAuthProfiles).not.toHaveBeenCalled();
});

it.each(["matching inherited", "unrelated inherited", "selected"] as const)(
  "retains local auth only for a recorded %s database refusal",
  async (refusedOwner) => {
    const root = "/fixture/async-auth-inheritance";
    const localDir = `${root}/agents/worker/agent`;
    const inheritedDir = `${root}/agents/main/agent`;
    const inheritedPath = `${inheritedDir}/openclaw-agent.sqlite`;
    const env = { OPENCLAW_STATE_DIR: root };
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const local: AuthProfileStore = {
      version: 1,
      profiles: { "custom:local": { type: "api_key", provider: "custom", key: "fixture" } },
    };
    reader.assertCurrent.mockReset();
    reader.read.mockReset();
    reader.read.mockResolvedValueOnce(
      refusedOwner === "selected"
        ? {
            store: { status: "unreadable" },
            state: { status: "missing", reason: "row" },
            cacheable: false,
          }
        : {
            store: { status: "readable", raw: local },
            state: { status: "missing", reason: "row" },
            cacheable: true,
          },
    );
    reader.read.mockResolvedValue({
      store: { status: "unreadable" },
      state: { status: "missing", reason: "row" },
      cacheable: true,
    });
    recordAgentDatabaseAdmissions(
      [
        createAgentDatabaseInspectionRefusal({
          agentId: refusedOwner === "selected" ? "worker" : "main",
          paths: [
            refusedOwner === "selected"
              ? `${localDir}/openclaw-agent.sqlite`
              : refusedOwner === "matching inherited"
                ? inheritedPath
                : `${root}/unrelated.sqlite`,
          ],
          reason: "Synthetic admission refusal.",
        }),
      ],
      { env, source: "startup" },
    );
    const runtime = createAuthProfileStoreRuntime({
      listRuntimeExternalAuthProfiles: () => [],
      overlayExternalAuthProfiles: (store) => store,
    });
    try {
      const result = runtime.loadAuthProfileStoreForRuntimeAsync(localDir, {
        inheritedAuthDir: inheritedDir,
        readOnly: true,
        externalCli: { mode: "none" },
      });
      if (refusedOwner === "matching inherited") {
        expect((await result).profiles).toEqual(local.profiles);
      } else {
        await expect(result).rejects.toBeInstanceOf(AuthProfileStoreUnreadableError);
      }
    } finally {
      recordAgentDatabaseAdmissions([], { env, source: "startup" });
    }
  },
);
