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
    withPreparedExternalAuthProfiles: async (_params, run) => run(),
  });
}

function setup(label: string, overlay?: Parameters<typeof createRuntime>[0]) {
  const root = tempDirs.make(`openclaw-auth-${label}-`);
  const agentDir = path.join(root, "agents/worker/agent");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const runtime = createRuntime(overlay);
  const load = (
    options: Parameters<typeof runtime.loadAuthProfileStoreForRuntimeAsync>[1] = {},
    dir: string | null = agentDir,
  ) =>
    runtime.loadAuthProfileStoreForRuntimeAsync(dir ?? undefined, {
      inheritedAuthDir: dir ?? undefined,
      externalCli: { mode: "none" },
      ...options,
    });
  return { root, agentDir, env: { OPENCLAW_STATE_DIR: root }, runtime, load };
}

function customStore(id: string, key = "fixture", provider = "custom"): AuthProfileStore {
  return { version: 1, profiles: { [id]: { type: "api_key", provider, key } } };
}

function setupWorker(label: string, overlay?: Parameters<typeof createRuntime>[0]) {
  const fixture = setup(label, overlay);
  createCacheDatabase(fixture.agentDir);
  useAgentWorkerRows();
  return fixture;
}

it.each(["agent", "shared"] as const)(
  "seeds selected %s credential authority from canonical rows instead of runtime overlays",
  async (source) => {
    const profileId = "custom:account";
    const { root, agentDir, env, load } = setup("authority-rows", (store) => {
      store.profiles[profileId] = { type: "api_key", provider: "custom", key: "runtime-overlay" };
      return store;
    });
    createCacheDatabase(agentDir);
    fs.mkdirSync(path.join(root, "state"));
    using sharedDatabase = openNodeSqliteDatabase(path.join(root, "state/openclaw.sqlite"));
    sharedDatabase.exec("CREATE TABLE cache_fixture (value)");
    noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, env);
    const context = captureOpenClawStateWorkerContext({ env });
    const databasePath =
      source === "agent"
        ? path.join(agentDir, "openclaw-agent.sqlite")
        : context.admission.databasePath;
    const persisted = customStore(profileId, "persisted-fixture");
    reader.read.mockResolvedValue(readableRows(persisted));
    useAgentWorkerRows();
    vi.spyOn(sqliteRead, "readSharedAuthProfileRows").mockResolvedValue(readableRows(persisted));
    const selectedDir = source === "agent" ? agentDir : null;
    try {
      await load({}, selectedDir);
      await load({ profileId }, selectedDir);
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
    const profileId = "team:account";
    const store = (provider?: string): AuthProfileStore =>
      provider ? customStore(profileId, "fixture", provider) : { version: 1, profiles: {} };
    const overlay = vi.fn(() => store("overlay"));
    const { agentDir, runtime } = setup("provider-facts", overlay);
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
        oauthRef: { source: "openclaw-credentials", provider: "openai-codex", id: "a".repeat(32) },
        setup: { replacement: true, modelRef: "custom/model", configJson: "{}" },
      },
    },
  };
  const state = {
    order: { custom: ["custom:key", "custom:token"] },
    lastGood: { custom: "custom:key" },
    usageStats: { "custom:key": { errorCount: 1, failureCounts: { auth: 1 } } },
  };
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
  const { load } = setupWorker("cached-mutation", overlay);
  reader.read.mockResolvedValue(readableRows(persisted, { status: "readable", raw: state }));
  for (let i = 0; i < 2; i++) {
    const store = await load();
    expect({ order: store.order, lastGood: store.lastGood, usageStats: store.usageStats }).toEqual(
      state,
    );
    store.order!.custom!.push("custom:oauth");
    store.lastGood!.custom = "custom:token";
    store.usageStats!["custom:key"]!.failureCounts!.auth = 9;
    delete store.profiles["custom:token"];
  }
  expect(overlay).toHaveBeenCalledTimes(2);
  expect(reader.read).toHaveBeenCalledTimes(1);
});

it("shares canonical rows while keeping scoped read-through credentials separate", async () => {
  const { agentDir, env, load } = setupWorker("scope-cache");
  reader.read.mockResolvedValue(readableRows());
  for (const key of ["fixture-one", "fixture-two"]) {
    const sharedStore = customStore("custom:key", key);
    const store = await authProfileRuntimeMode.run(
      { kind: "agent-dir", agentDir, env, sharedStore },
      () => load(),
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

it("invalidates warm rows immediately after an owner bookkeeping write", async () => {
  const { agentDir, load } = setupWorker("identity-probes");
  prepareSharedAuthStoreOwnershipForNative();
  reader.read.mockResolvedValue(readableRows());
  await load();
  noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
    credentialsChanged: false,
    stateChanged: true,
    profileIds: [],
  });
  reader.read.mockResolvedValue(
    readableRows(undefined, {
      status: "readable",
      raw: { version: 1, lastGood: { custom: "custom:new" } },
    }),
  );
  await expect(load()).resolves.toMatchObject({ lastGood: { custom: "custom:new" } });
  expect(reader.read).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "rechecks retired files after an inherited read with populated local SQLite: %s",
  async (populated) => {
    const { root, agentDir: localDir, load } = setup("migration");
    const inheritedDir = path.join(root, "agents/main/agent");
    fs.mkdirSync(localDir, { recursive: true });
    const local = populated
      ? customStore("custom:local", "fixture-local")
      : { version: 1, profiles: {} };
    const inheritedReadStarted = createDeferredCore();
    const inheritedRows = createDeferredCore<AuthProfileRowRead>();
    reader.read.mockResolvedValueOnce(readableRows(local));
    reader.read.mockImplementationOnce(() => {
      inheritedReadStarted.resolve();
      return inheritedRows.promise;
    });
    const inherited = readableRows(customStore("custom:inherited", "fixture-inherited"));
    const loading = load({ inheritedAuthDir: inheritedDir });
    try {
      await Promise.race([
        inheritedReadStarted.promise,
        loading.then(() => {
          throw new Error("Auth read completed before the inherited read barrier");
        }),
      ]);
      fs.writeFileSync(
        path.join(localDir, "auth-profiles.json"),
        JSON.stringify(customStore("custom:legacy", "fixture-legacy")),
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
    const local = customStore("custom:local");
    const unreadable: AuthProfileRowRead = {
      store: { status: "unreadable" },
      state: { status: "missing", reason: "row" },
      cacheable: true,
    };
    reader.read
      .mockResolvedValueOnce(
        refusedOwner === "selected" ? { ...unreadable, cacheable: false } : readableRows(local),
      )
      .mockResolvedValue(unreadable);
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
