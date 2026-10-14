import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as sqliteWorker from "../../infra/sqlite-readonly-worker.js";
import { inspectDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { revokeAgentDatabaseResources } from "../../state/openclaw-agent-db-resources.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { captureAuthProfileCredentialAuthority } from "../../state/user-model-account-authority.js";
import { refreshAuthProfileFileState } from "./file-state.js";
import * as migration from "./legacy-source-diagnostic.js";
import { noteCommittedSharedAuthStoreOwnership } from "./path-resolve.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
import * as persistedStore from "./persisted.js";
import { authProfileRuntimeMode } from "./runtime-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  noteRuntimeAuthProfileStorePersistedMutation,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import * as sqliteRead from "./sqlite-read.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import { createAuthProfileStoreRuntime } from "./store.js";
import type { AuthProfileStore, AuthProfileRowRead } from "./types.js";

const reader = vi.hoisted(() => ({
  identity: undefined,
  signal: new AbortController().signal,
  captureCredentialAuthority: () => undefined,
  read: vi.fn(),
  assertCurrent: vi.fn(),
  dispose: vi.fn(async () => {}),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  reader.assertCurrent.mockReset();
  reader.read.mockReset();
  vi.spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead").mockReturnValue(reader);
});

function useAgentWorkerRows() {
  vi.mocked(sqliteRead.prepareAgentAuthProfileRowsRead).mockRestore();
  vi.spyOn(sqliteWorker, "runSqliteReadOnlyWorker").mockImplementation(reader.read);
}

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  migration.clearAuthProfileMigrationDiagnostics();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function readableRows(
  store: AuthProfileStore = { version: 1, profiles: {} },
  state: AuthProfileRowRead["state"] = { status: "missing", reason: "row" },
): AuthProfileRowRead {
  return { store: { status: "readable", raw: store }, state, cacheable: true };
}

function createRuntime(overlayExternalAuthProfiles = (store: AuthProfileStore) => store) {
  return createAuthProfileStoreRuntime({
    listRuntimeExternalAuthProfiles: () => [],
    overlayExternalAuthProfiles,
  });
}

it.each(["agent", "shared"] as const)(
  "seeds selected %s credential authority from canonical rows instead of runtime overlays",
  async (source) => {
    const root = tempDirs.make("openclaw-auth-authority-rows-");
    const agentDir = path.join(root, "agents/worker/agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    createCacheDatabase(agentDir);
    fs.mkdirSync(path.join(root, "state"));
    using sharedDatabase = openNodeSqliteDatabase(path.join(root, "state/openclaw.sqlite"));
    sharedDatabase.exec("CREATE TABLE cache_fixture (value)");
    const env = { OPENCLAW_STATE_DIR: root };
    noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, env);
    const context = captureOpenClawStateWorkerContext({ env });
    const databasePath =
      source === "agent"
        ? path.join(agentDir, "openclaw-agent.sqlite")
        : context.admission.databasePath;
    const profileId = "custom:account";
    const persisted: AuthProfileStore = {
      version: 1,
      profiles: { [profileId]: { type: "api_key", provider: "custom", key: "persisted-fixture" } },
    };
    reader.read.mockResolvedValue(readableRows(persisted));
    useAgentWorkerRows();
    vi.spyOn(sqliteRead, "readSharedAuthProfileRows").mockResolvedValue(readableRows(persisted));
    const runtime = createRuntime((store) => {
      store.profiles[profileId] = { type: "api_key", provider: "custom", key: "runtime-overlay" };
      return store;
    });
    const selectedDir = source === "agent" ? agentDir : undefined;
    const options = {
      inheritedAuthDir: selectedDir,
      externalCli: { mode: "none" as const },
    };
    try {
      await runtime.loadAuthProfileStoreForRuntimeAsync(selectedDir, options);
      await runtime.loadAuthProfileStoreForRuntimeAsync(selectedDir, { ...options, profileId });
      const identity = inspectDatabasePathIdentitySync(databasePath);
      if (!identity) {
        throw new Error("Missing fixture database identity");
      }
      const authority = captureAuthProfileCredentialAuthority(
        context,
        { identity: `${identity.key}:${identity.birthtime ?? ""}`, databasePath },
        profileId,
      );
      expect(authority.readCurrentCredential()).toEqual(persisted.profiles[profileId]);
      if (source === "agent") {
        expect(reader.read).toHaveBeenCalledOnce();
      }
    } finally {
      await Promise.all(revokeAgentDatabaseResources({ rootPath: root }));
    }
  },
);

it.each(["snapshot", "requested", "shared", "absent"] as const)(
  "prepares the %s provider from recorded facts without synchronous persisted reads",
  async (source) => {
    const root = tempDirs.make("openclaw-auth-provider-facts-");
    const agentDir = path.join(root, "agents/worker/agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const profileId = "team:account";
    const store = (provider?: string): AuthProfileStore => ({
      version: 1,
      profiles: provider ? { [profileId]: { type: "api_key", provider, key: "fixture" } } : {},
    });
    reader.read.mockResolvedValueOnce(
      readableRows(store(source === "requested" ? "requested" : undefined)),
    );
    reader.read.mockResolvedValue(readableRows(store(source === "absent" ? undefined : "shared")));
    vi.spyOn(sqliteRead, "readSharedAuthProfileRows").mockResolvedValue(
      readableRows(store(source === "absent" ? undefined : "shared")),
    );
    if (source === "snapshot") {
      prepareSharedAuthStoreOwnershipForNative();
      setRuntimeAuthProfileStoreSnapshot(store("snapshot"), agentDir);
    }
    const syncRead = vi
      .spyOn(persistedStore, "loadPersistedAuthProfileStore")
      .mockImplementation(() => {
        throw new Error("synchronous persisted read");
      });
    const overlay = vi.fn(() => store("overlay"));
    const runtime = createRuntime(overlay);
    await expect(runtime.prepareAuthProfileProvider({ agentDir, profileId })).resolves.toEqual({
      provider: source === "absent" ? undefined : source,
    });
    expect(syncRead).not.toHaveBeenCalled();
    expect(overlay).not.toHaveBeenCalled();
    if (source === "snapshot") {
      expect(reader.read).not.toHaveBeenCalled();
    }
  },
);

it("keeps cached credentials and selection state separate from mutable runtime views", async () => {
  const root = tempDirs.make("openclaw-auth-cached-mutation-");
  const localDir = path.join(root, "agents/worker/agent");
  createCacheDatabase(localDir);
  useAgentWorkerRows();
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const persisted: AuthProfileStore = {
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
  reader.read.mockResolvedValue(readableRows(persisted, { status: "readable", raw: state }));
  const overlay = vi.fn((store: AuthProfileStore) => {
    expect(store.profiles).toEqual(persisted.profiles);
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
  const runtime = createRuntime(overlay);
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

it("shares canonical rows while keeping scoped read-through credentials separate", async () => {
  const root = tempDirs.make("openclaw-auth-scope-cache-");
  const agentDir = path.join(root, "agents/worker/agent");
  createCacheDatabase(agentDir);
  useAgentWorkerRows();
  const env = { OPENCLAW_STATE_DIR: root };
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  reader.read.mockResolvedValue(readableRows());
  const runtime = createRuntime();
  for (const key of ["fixture-one", "fixture-two"]) {
    const sharedStore: AuthProfileStore = {
      version: 1,
      profiles: { "custom:key": { type: "api_key", provider: "custom", key } },
    };
    const store = await authProfileRuntimeMode.run(
      { kind: "agent-dir", agentDir, env, sharedStore },
      () =>
        runtime.loadAuthProfileStoreForRuntimeAsync(agentDir, {
          inheritedAuthDir: agentDir,
          externalCli: { mode: "none" },
        }),
    );
    expect(store.profiles["custom:key"]).toEqual(sharedStore.profiles["custom:key"]);
  }
  expect(reader.read).toHaveBeenCalledOnce();
});

function createCacheDatabase(agentDir: string): void {
  fs.mkdirSync(agentDir, { recursive: true });
  using database = openNodeSqliteDatabase(path.join(agentDir, "openclaw-agent.sqlite"));
  database.exec("CREATE TABLE cache_fixture (value)");
}

function prepareCachedRuntimeRead() {
  const root = tempDirs.make("openclaw-auth-identity-probes-");
  const agentDir = path.join(root, "agents/worker/agent");
  fs.mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  createCacheDatabase(agentDir);
  useAgentWorkerRows();
  prepareSharedAuthStoreOwnershipForNative();
  const rows = readableRows();
  reader.read.mockResolvedValue(rows);
  const runtime = createRuntime();
  return {
    agentDir,
    databasePath: path.join(agentDir, "openclaw-agent.sqlite"),
    rows,
    load: () =>
      runtime.loadAuthProfileStoreForRuntimeAsync(agentDir, {
        inheritedAuthDir: agentDir,
        externalCli: { mode: "none" },
      }),
  };
}

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
    reader.read.mockResolvedValueOnce(readableRows(local));
    reader.read.mockImplementationOnce(() => {
      inheritedReadStarted.resolve();
      return inheritedRows.promise;
    });
    const runtime = createRuntime();
    const inherited = readableRows({
      version: 1,
      profiles: {
        "custom:inherited": { type: "api_key", provider: "custom", key: "fixture-inherited" },
      },
    });
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
      await refreshAuthProfileFileState();
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
    return readableRows();
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
  const runtime = createRuntime(overlayExternalAuthProfiles);

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
    reader.read.mockResolvedValueOnce(
      refusedOwner === "selected"
        ? {
            store: { status: "unreadable" },
            state: { status: "missing", reason: "row" },
            cacheable: false,
          }
        : readableRows(local),
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
    const runtime = createRuntime();
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
