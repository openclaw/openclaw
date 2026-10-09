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
import * as persistedStore from "./persisted.js";
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

const reader = vi.hoisted(() => ({
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

function prepareCachedRuntimeRead() {
  const root = tempDirs.make("openclaw-auth-identity-probes-");
  const agentDir = path.join(root, "agents/worker/agent");
  fs.mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const rows = readableRows();
  reader.read.mockResolvedValue(rows);
  const runtime = createRuntime();
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
    reader.read.mockResolvedValue(
      readableRows({
        version: 1,
        profiles: { "custom:new": { type: "api_key", provider: "custom", key: "fixture-new" } },
      }),
    );
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

it.each(["during the cold read", "after a 100 ms cold read"] as const)(
  "does not reuse cached rows changed %s",
  async (timing) => {
    const { databasePath, rows, clock, load } = prepareCachedRuntimeRead();
    const write = () => fs.writeFileSync(`${databasePath}-wal`, "synthetic external write");
    reader.read.mockImplementationOnce(async () => {
      if (timing === "during the cold read") {
        write();
      } else {
        clock.mockReturnValue(100);
      }
      return rows;
    });
    await load();
    if (timing === "after a 100 ms cold read") {
      write();
    }
    await load();
    expect(reader.read).toHaveBeenCalledTimes(2);
  },
);

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
  reader.read.mockResolvedValue(readableRows());
  const runtime = createRuntime();
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
    return readableRows();
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
