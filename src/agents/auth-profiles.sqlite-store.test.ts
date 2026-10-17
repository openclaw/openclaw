import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it as baseIt, vi } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as databaseIdentity from "../infra/sqlite-worker-identity.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import {
  detectSharedAuthStoreMigration,
  migrateSharedAuthStore,
} from "../infra/state-migrations.shared-auth-store.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { resolveAgentDir } from "./agent-scope.js";
import { refreshAuthProfileFileState } from "./auth-profiles/file-state.js";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";
import { loadPersistedAuthProfileStore } from "./auth-profiles/persisted.js";
import { upsertAuthProfileAsync } from "./auth-profiles/profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/runtime-snapshots.js";
import {
  inspectPersistedAuthProfileStoreRaw as inspectStore,
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStoreRaw,
} from "./auth-profiles/sqlite.js";
import {
  apiKeyCredential,
  apiKeyStore,
  withAgentDirEnv,
} from "./auth-profiles/sqlite.test-support.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreAsync,
  ensureAuthProfileStoreForLocalUpdateAsync as ensureUpdateAsync,
  ensureAuthProfileStoreWithoutExternalProfiles as ensureLocal,
  ensureAuthProfileStoreWithoutExternalProfilesAsync as ensureLocalAsync,
  findPersistedAuthProfileCredentialAsync as findCredentialAsync,
  loadAuthProfileStoreWithoutExternalProfilesAsync as loadLocalAsync,
  loadAuthProfileStoreForRuntime as loadRuntime,
  saveAuthProfileStore,
} from "./auth-profiles/store-runtime.js";
import type { OAuthCredential } from "./auth-profiles/types.js";
import {
  persistAuthProfileBatch,
  upsertAuthProfileWithLockOrThrow,
} from "./auth-profiles/upsert-with-lock.js";

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  listExternalCliSyncProviderIds: () => [],
  resolveExternalCliAuthProfiles: () => [],
}));

// mock-isolation: Persistence and migration fixtures own profile rows; external discovery must not import ambient credentials.
vi.mock("../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
    withPreparedExternalAuthProfiles: async <T>(_params: unknown, run: () => Promise<T>) => run(),
  }),
}));

function sharedValue(database: DatabaseSync, key: string) {
  return database
    .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
    .get(key)?.value_json;
}

function updateShared(database: DatabaseSync, key: string, value: unknown) {
  database
    .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
    .run(JSON.stringify(value), key);
}

const noExternal = { syncExternalCli: false };

function upsert(agentDir: string, key: string, profileId = "openai:default") {
  return upsertAuthProfileWithLockOrThrow({
    agentDir,
    profileId,
    credential: apiKeyCredential(key),
  });
}

function seedAsync(agentDir: string, profileId: string, key: string) {
  return upsertAuthProfileAsync({
    agentDir,
    profileId,
    credential: { type: "api_key", provider: "test", key },
  });
}

const it = baseIt.extend<{ auth: { agentDir: string; stateDir: string } }>({
  auth: async ({ task }, use) =>
    withAgentDirEnv(`openclaw-auth-${task.id}-`, (agentDir, stateDir) =>
      use({ agentDir, stateDir }),
    ),
});

describe("auth profile sqlite store", () => {
  beforeEach(clearRuntimeAuthProfileStoreSnapshots);
  afterEach(clearRuntimeAuthProfileStoreSnapshots);

  it("refreshes async auth reads after concurrent profile writes without losing neighbors", async ({
    auth: { agentDir },
  }) => {
    await seedAsync(agentDir, "test:original", "original-key");
    const options = { allowKeychainPrompt: false, externalCli: { mode: "none" as const } };
    expect((await ensureAuthProfileStoreAsync(agentDir, options)).profiles).toHaveProperty(
      "test:original",
    );
    expect((await loadLocalAsync(agentDir, options)).profiles).toHaveProperty("test:original");
    await Promise.all([
      seedAsync(agentDir, "test:original", "replacement-key"),
      seedAsync(agentDir, "test:neighbor", "neighbor-key"),
    ]);
    const expected = {
      "test:original": { type: "api_key", provider: "test", key: "replacement-key" },
      "test:neighbor": { type: "api_key", provider: "test", key: "neighbor-key" },
    };
    expect((await ensureAuthProfileStoreAsync(agentDir, options)).profiles).toEqual(expected);
    expect((await loadLocalAsync(agentDir, options)).profiles).toEqual(expected);
    expect((await ensureLocalAsync(agentDir, options)).profiles).toEqual(expected);
    expect((await ensureUpdateAsync(agentDir)).profiles).toEqual(expected);
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: {
          version: 1,
          profiles: {
            "test:original": { type: "api_key", provider: "shadow", key: "shadow-key" },
          },
        },
      },
    ]);
    expect((await loadLocalAsync(agentDir, options)).profiles).toEqual(expected);
    await expect(findCredentialAsync({ agentDir, profileId: "test:original" })).resolves.toEqual(
      expected["test:original"],
    );
  });

  it.for([true, false])(
    "selects shared OAuth according to replacement state %s",
    async (replacement, { auth: { agentDir: mainAgentDir, stateDir } }) => {
      const expectedProfileId = replacement ? "openai:default" : "openai:setup-replacement";
      const expectedAccess = replacement ? "working-access" : "newer-access";
      const localAgentDir = path.join(stateDir, "agents", "worker", "agent");
      const working: OAuthCredential = {
        type: "oauth",
        provider: "openai",
        access: "working-access",
        refresh: "working-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "same-account",
        email: "same@example.test",
      };
      await persistAuthProfileBatch({
        agentDir: mainAgentDir,
        profiles: [
          {
            profileId: "openai:setup-replacement",
            credential: {
              ...working,
              access: "newer-access",
              refresh: "newer-refresh",
              expires: working.expires + 3_600_000,
              setup: { replacement, modelRef: "openai/test-model", configJson: "{}" },
            },
          },
        ],
      });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: { "openai:default": working },
          order: { openai: ["openai:default"] },
          lastGood: { openai: "openai:default" },
        },
        localAgentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );
      clearRuntimeAuthProfileStoreSnapshots();

      const runtimeStore = loadRuntime(localAgentDir, {
        readOnly: true,
        syncExternalCli: false,
      });
      expect(resolveAuthProfileOrder({ store: runtimeStore, provider: "openai" })).toEqual([
        expectedProfileId,
      ]);
      expect(runtimeStore.profiles[expectedProfileId]).toMatchObject({
        access: expectedAccess,
      });
      expect(runtimeStore.lastGood?.openai).toBe(expectedProfileId);
      expect(loadPersistedAuthProfileStore(localAgentDir)?.profiles["openai:default"]).toEqual(
        working,
      );
    },
  );

  it("persists fresh shared auth through the shared-state adapter", async ({
    auth: { agentDir },
  }) => {
    await persistAuthProfileBatch({
      agentDir,
      profiles: [{ profileId: "openai:default", credential: apiKeyCredential("sk-shared") }],
      order: { openai: ["openai:default"] },
    });

    expect(ensureAuthProfileStore(undefined, noExternal)).toMatchObject({
      profiles: { "openai:default": { key: "sk-shared" } },
      order: { openai: ["openai:default"] },
    });
    using database = new DatabaseSync(resolveOpenClawStateSqlitePath());
    expect(sharedValue(database, "authProfiles.store")).toEqual(expect.any(String));
    expect(sharedValue(database, "authProfiles.state")).toEqual(expect.any(String));
    expect(sharedValue(database, "auth.sharedStore")).toBe(
      JSON.stringify({ location: "state-db" }),
    );
    for (const [key, lastUsed] of [
      ["synthetic-shared-first", 789],
      ["synthetic-shared-second", 790],
    ] as const) {
      updateShared(database, "authProfiles.store", apiKeyStore(key));
      updateShared(database, "authProfiles.state", {
        version: 1,
        usageStats: { "openai:default": { lastUsed } },
      });
      const loaded = loadRuntime(undefined, { readOnly: true });
      expect(loaded).toMatchObject({
        ...apiKeyStore(key),
        usageStats: { "openai:default": { lastUsed } },
      });
      expect(loaded.order).toBeUndefined();
    }
    expect(fs.existsSync(resolveAuthProfileDatabasePath(agentDir))).toBe(false);
  });

  it("memoizes legacy inspection and follows Doctor's ownership flip", async ({
    auth: { agentDir, stateDir },
  }) => {
    writePersistedAuthProfileStoreRaw(apiKeyStore("sk-legacy"), agentDir);
    let sourceInspections = 0;
    const inspection = probe.command(stateWorker, (command, executeOptions, scope) => {
      if (command.type === "authProfiles.bootstrap") {
        sourceInspections += 1;
      }
      return scope.execute(command, executeOptions);
    });

    try {
      for (const key of ["sk-first", "sk-second"]) {
        await upsert(agentDir, key);
      }
      expect(sourceInspections).toBe(1);

      const detected = detectSharedAuthStoreMigration({
        stateDir,
        doctorOnlyStateMigrations: true,
      });
      await migrateSharedAuthStore({ detected, stateDir });
      const inspectionsAfterDoctor = sourceInspections;

      await upsert(agentDir, "sk-after-doctor");

      expect(sourceInspections).toBe(inspectionsAfterDoctor);
      expect(ensureAuthProfileStore(undefined, noExternal)).toMatchObject({
        profiles: { "openai:default": { key: "sk-after-doctor" } },
      });
      expect(inspectStore(agentDir).status).toBe("missing");
    } finally {
      inspection.mockRestore();
    }
  });

  it("keeps legacy ownership while shared-auth cleanup is pending", async ({
    auth: { agentDir },
  }) => {
    const sourcePath = resolveAuthProfileDatabasePath(agentDir);
    writeConfigMachineState("test.seed", true);
    const sharedDatabase = new DatabaseSync(resolveOpenClawStateSqlitePath());
    sharedDatabase
      .prepare(
        `INSERT INTO migration_runs (id, started_at, finished_at, status, report_json)
         VALUES ('shared-auth-pending', 1, NULL, 'copied', '{}')`,
      )
      .run();
    sharedDatabase
      .prepare(
        `INSERT INTO migration_sources
           (source_key, migration_kind, source_path, target_table, source_sha256,
            source_size_bytes, source_record_count, last_run_id, status, imported_at,
            removed_source, report_json)
         VALUES ('shared-auth-pending:store', 'shared-auth-store-state-db', ?,
                 'auth_profile_stores', NULL, NULL, NULL, 'shared-auth-pending',
                 'copied', 1, 0, '{}')`,
      )
      .run(sourcePath);
    sharedDatabase.close();

    await upsert(agentDir, "sk-after-crash");

    const after = new DatabaseSync(resolveOpenClawStateSqlitePath());
    expect(sharedValue(after, "auth.sharedStore")).toBeUndefined();
    expect(sharedValue(after, "authProfiles.store")).toBeUndefined();
    after.close();
    expect(inspectStore(agentDir).status).toBe("readable");
  });

  it("keeps legacy ownership when bootstrap source inspection fails", async ({
    auth: { agentDir },
  }) => {
    const sourcePath = resolveAuthProfileDatabasePath(agentDir);
    const inspectIdentity = databaseIdentity.inspectDatabasePathIdentitySync;
    let sourceInspectionFailed = false;
    const inspection = vi
      .spyOn(databaseIdentity, "inspectDatabasePathIdentitySync")
      .mockImplementation((pathname) => {
        if (!sourceInspectionFailed && path.resolve(pathname) === path.resolve(sourcePath)) {
          sourceInspectionFailed = true;
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return inspectIdentity(pathname);
      });

    try {
      await upsert(agentDir, "sk-unreadable");
    } finally {
      inspection.mockRestore();
    }

    expect(sourceInspectionFailed).toBe(true);
    const sharedDatabase = new DatabaseSync(resolveOpenClawStateSqlitePath());
    expect(sharedValue(sharedDatabase, "auth.sharedStore")).toBeUndefined();
    sharedDatabase.close();
    expect(inspectStore(agentDir).status).toBe("readable");
  });

  it("does not read legacy auth-profiles.json at runtime", async ({ auth: { agentDir } }) => {
    fs.writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      `${JSON.stringify(apiKeyStore("sk-json"))}\n`,
      "utf8",
    );

    expect(() => ensureAuthProfileStore(agentDir, noExternal)).toThrow(
      "requires legacy credential migration",
    );
  });

  it("keeps serving SQLite credentials after observing a retired credential source", async ({
    auth: { agentDir },
  }) => {
    saveAuthProfileStore(apiKeyStore("not-a-real"), agentDir);
    const legacyPath = path.join(agentDir, "auth.json");
    ensureAuthProfileStore(agentDir, noExternal);
    fs.writeFileSync(legacyPath, '{"openai":{"key":"not-a-real"}}\n', "utf8");
    await refreshAuthProfileFileState();
    expect(ensureAuthProfileStore(agentDir, noExternal).profiles["openai:default"]).toMatchObject({
      type: "api_key",
      provider: "openai",
      key: "not-a-real",
    });
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it("rejects a newer agent database that has no current auth table", async ({
    auth: { agentDir },
  }) => {
    const database = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
    database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
    database.close();

    expect(inspectStore(agentDir)).toEqual({ status: "unreadable" });
  });

  it("keeps auth schema classifications fresh after owner schema changes", async ({
    auth: { agentDir },
  }) => {
    using database = openNodeSqliteDatabase(resolveAuthProfileDatabasePath(agentDir));
    const createView = () =>
      database.exec(
        "CREATE VIEW auth_profile_store AS SELECT 'primary' AS store_key, '{}' AS store_json;",
      );
    const expectUnreadable = () => {
      expect(inspectStore(agentDir)).toEqual({ status: "unreadable" });
      expect(() => loadRuntime(agentDir, { readOnly: true })).toThrow("is unreadable");
    };
    const createTable = `
      CREATE TABLE auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `;
    createView();
    expectUnreadable();

    for (const key of ["synthetic-first", "synthetic-recreated"]) {
      database.exec(`DROP VIEW auth_profile_store; ${createTable}`);
      database
        .prepare("INSERT INTO auth_profile_store VALUES ('primary', ?, 1)")
        .run(JSON.stringify(apiKeyStore(key)));
      expect(loadRuntime(agentDir, { readOnly: true })).toMatchObject(apiKeyStore(key));
      database.exec("DROP TABLE auth_profile_store;");
      expect(inspectStore(agentDir)).toEqual({
        status: "missing",
        reason: "table",
      });
      expect(loadRuntime(agentDir, { readOnly: true }).profiles).toEqual({});
      createView();
      expectUnreadable();
    }
  });

  it("waits for brief rollback-journal contention before reading persisted auth", async ({
    auth: { agentDir },
  }) => {
    saveAuthProfileStore(apiKeyStore("sk-test"), agentDir);
    closeOpenClawAgentDatabasesForTest();

    const databasePath = resolveAuthProfileDatabasePath(agentDir);
    const setup = new DatabaseSync(databasePath);
    setup.exec("PRAGMA journal_mode = DELETE;");
    setup.close();

    const child = spawn(
      process.execPath,
      [
        "-e",
        `
            const { DatabaseSync } = require("node:sqlite");
            const db = new DatabaseSync(process.argv[1]);
            db.exec("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;");
            db.prepare(
              "UPDATE auth_profile_store SET updated_at = updated_at + 1 WHERE store_key = ?",
            ).run("primary");
            process.stdout.write("locked\\n");
            setTimeout(() => {
              db.exec("ROLLBACK;");
              db.close();
            }, 250);
          `,
        databasePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const childExit = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`contention child exited with code ${code}`));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      let locked = false;
      child.stdout.once("data", () => {
        locked = true;
        resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!locked) {
          reject(new Error(`contention child exited before locking with code ${code}`));
        }
      });
    });

    const loaded = loadPersistedAuthProfileStore(agentDir);

    await childExit;
    expect(loaded?.profiles["openai:default"]).toMatchObject({ key: "sk-test" });
  });

  it("uses the configured agent id for custom agentDir databases", async ({
    auth: { agentDir: envAgentDir },
  }) => {
    const customAgentDir = path.join(path.dirname(path.dirname(envAgentDir)), "custom-coder");
    const cfg = { agents: { entries: { coder: { agentDir: customAgentDir } } } };
    const agentDir = resolveAgentDir(cfg, "coder");

    saveAuthProfileStore(apiKeyStore("sk-test"), agentDir);

    const database = openOpenClawAgentDatabase({
      agentId: "coder",
      path: resolveAuthProfileDatabasePath(agentDir),
    });
    expect(database.agentId).toBe("coder");
  });

  it("keeps an explicit inherited snapshot authoritative for an omitted agent", async ({
    auth: { agentDir, stateDir },
  }) => {
    const inheritedAuthDir = path.join(stateDir, "inherited");
    replaceRuntimeAuthProfileStoreSnapshots([
      { agentDir, store: apiKeyStore("shared") },
      { agentDir: inheritedAuthDir, store: apiKeyStore("inherited") },
    ]);
    expect(ensureLocal(undefined, { inheritedAuthDir }).profiles).toEqual(
      apiKeyStore("inherited").profiles,
    );
  });

  it("keeps SecretRef-backed credentials from persisting duplicate plaintext", async ({
    auth: { agentDir },
  }) => {
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-plaintext",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
          "anthropic:default": {
            type: "token",
            provider: "anthropic",
            token: "token-plaintext",
            tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_AUTH_TOKEN" },
          },
        },
      },
      agentDir,
    );

    const loaded = ensureAuthProfileStore(agentDir, noExternal);

    expect(loaded.profiles["openai:default"]).toEqual({
      type: "api_key",
      provider: "openai",
      keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    });
    expect(loaded.profiles["anthropic:default"]).toEqual({
      type: "token",
      provider: "anthropic",
      tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_AUTH_TOKEN" },
    });
  });
});
