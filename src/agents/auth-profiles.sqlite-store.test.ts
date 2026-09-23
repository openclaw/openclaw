/**
 * SQLite auth-profile store integration tests.
 * Verifies secrets/state persistence, runtime overlays, and legacy JSON
 * migration boundaries in temporary agent directories.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nodeSqlite from "../infra/node-sqlite.js";
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
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnv } from "../test-utils/env.js";
import { resolveAgentDir } from "./agent-scope.js";
import * as authProfileClone from "./auth-profiles/clone.js";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";
import { loadPersistedAuthProfileStore } from "./auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/runtime-snapshots.js";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "./auth-profiles/sqlite.js";
import {
  apiKeyCredential,
  apiKeyStore,
  withAgentDirEnv,
} from "./auth-profiles/sqlite.test-support.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForRuntime,
  saveAuthProfileStore,
} from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "./auth-profiles/types.js";
import {
  persistAuthProfileBatch,
  upsertAuthProfileWithLockOrThrow,
} from "./auth-profiles/upsert-with-lock.js";

type RuntimeOnlyOverlay = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};

const mocks = vi.hoisted(() => ({
  resolveExternalCliAuthProfiles: vi.fn<
    (store?: unknown, options?: unknown) => RuntimeOnlyOverlay[]
  >(() => []),
}));

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  listExternalCliSyncProviderIds: () => [],
  resolveExternalCliAuthProfiles: mocks.resolveExternalCliAuthProfiles,
}));

vi.mock("../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
  }),
}));

describe("auth profile sqlite store", () => {
  beforeEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    mocks.resolveExternalCliAuthProfiles.mockReset();
    mocks.resolveExternalCliAuthProfiles.mockReturnValue([]);
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
  });

  it("persists auth profiles and runtime scheduling state in the agent sqlite database", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-", (agentDir) => {
      saveAuthProfileStore(
        {
          ...apiKeyStore("sk-test"),
          order: { openai: ["openai:default"] },
          lastGood: { openai: "openai:default" },
          usageStats: { "openai:default": { lastUsed: 123 } },
        },
        agentDir,
      );

      const loaded = ensureAuthProfileStore(agentDir, { syncExternalCli: false });

      expect(loaded.profiles["openai:default"]).toMatchObject({ key: "sk-test" });
      expect(loaded.order?.openai).toEqual(["openai:default"]);
      expect(loaded.lastGood?.openai).toBe("openai:default");
      expect(loaded.usageStats?.["openai:default"]?.lastUsed).toBe(123);
      expect(fs.existsSync(path.join(agentDir, "auth-profiles.json"))).toBe(false);
      expect(fs.existsSync(path.join(agentDir, "auth-state.json"))).toBe(false);
      expect(fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(true);
    });
  });

  it.each([
    {
      label: "inactive",
      replacement: true,
      expectedProfileId: "openai:default",
      expectedAccess: "working-access",
    },
    {
      label: "active",
      replacement: false,
      expectedProfileId: "openai:setup-replacement",
      expectedAccess: "newer-access",
    },
  ])("keeps OAuth selection correct with a newer $label shared sign-in", async (testCase) => {
    await withAgentDirEnv("openclaw-auth-setup-drift-", async (mainAgentDir, stateDir) => {
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
              setup: {
                replacement: testCase.replacement,
                modelRef: "openai/test-model",
                configJson: "{}",
              },
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

      const runtimeStore = loadAuthProfileStoreForRuntime(localAgentDir, {
        readOnly: true,
        syncExternalCli: false,
      });
      expect(resolveAuthProfileOrder({ store: runtimeStore, provider: "openai" })).toEqual([
        testCase.expectedProfileId,
      ]);
      expect(runtimeStore.profiles[testCase.expectedProfileId]).toMatchObject({
        access: testCase.expectedAccess,
      });
      expect(runtimeStore.lastGood?.openai).toBe(testCase.expectedProfileId);
      expect(loadPersistedAuthProfileStore(localAgentDir)?.profiles["openai:default"]).toEqual(
        working,
      );
    });
  });

  it.each([
    { label: "pre-recorded ownership", recordOwnership: true },
    { label: "fresh ownership", recordOwnership: false },
  ])("persists the shared store through the shared-state adapter with $label", async (testCase) => {
    await withAgentDirEnv("openclaw-auth-shared-state-", async (agentDir) => {
      if (testCase.recordOwnership) {
        writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      }
      await persistAuthProfileBatch({
        agentDir,
        profiles: [
          {
            profileId: "openai:default",
            credential: apiKeyCredential("sk-shared"),
          },
        ],
        order: { openai: ["openai:default"] },
      });

      expect(ensureAuthProfileStore(undefined, { syncExternalCli: false })).toMatchObject({
        profiles: { "openai:default": { key: "sk-shared" } },
        order: { openai: ["openai:default"] },
      });
      const database = new DatabaseSync(resolveOpenClawStateSqlitePath());
      expect(
        database
          .prepare(
            "SELECT state_key FROM config_machine_state WHERE state_key = 'authProfiles.store'",
          )
          .get(),
      ).toEqual({ state_key: "authProfiles.store" });
      expect(
        database
          .prepare(
            "SELECT state_key FROM config_machine_state WHERE state_key = 'authProfiles.state'",
          )
          .get(),
      ).toEqual({ state_key: "authProfiles.state" });
      expect(
        database
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'auth.sharedStore'",
          )
          .get(),
      ).toEqual({ value_json: JSON.stringify({ location: "state-db" }) });
      try {
        for (const [key, lastUsed] of [
          ["synthetic-shared-first", 789],
          ["synthetic-shared-second", 790],
        ] as const) {
          database
            .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
            .run(JSON.stringify(apiKeyStore(key)), "authProfiles.store");
          database
            .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
            .run(
              JSON.stringify({ version: 1, usageStats: { "openai:default": { lastUsed } } }),
              "authProfiles.state",
            );
          const loaded = loadAuthProfileStoreForRuntime(undefined, { readOnly: true });
          expect(loaded).toMatchObject({
            ...apiKeyStore(key),
            usageStats: { "openai:default": { lastUsed } },
          });
          expect(loaded.order).toBeUndefined();
        }
      } finally {
        database.close();
      }
      expect(fs.existsSync(resolveAuthProfileDatabasePath(agentDir))).toBe(false);
    });
  });

  it.each([
    {
      label: "credential row",
      seed: (agentDir: string) =>
        writePersistedAuthProfileStoreRaw(apiKeyStore("sk-legacy"), agentDir),
    },
    {
      label: "runtime-state row",
      seed: (agentDir: string) =>
        writePersistedAuthProfileStateRaw(
          { version: 1, order: { openai: ["openai:legacy"] } },
          agentDir,
        ),
    },
  ])("keeps legacy ownership when the main agent has a $label", async (testCase) => {
    await withAgentDirEnv("openclaw-auth-shared-legacy-", async (agentDir) => {
      testCase.seed(agentDir);

      await upsertAuthProfileWithLockOrThrow({
        agentDir,
        profileId: "openai:default",
        credential: apiKeyCredential("sk-updated"),
      });

      const sharedDatabase = new DatabaseSync(resolveOpenClawStateSqlitePath());
      expect(
        sharedDatabase
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'auth.sharedStore'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        sharedDatabase
          .prepare(
            "SELECT state_key FROM config_machine_state WHERE state_key = 'authProfiles.store'",
          )
          .get(),
      ).toBeUndefined();
      sharedDatabase.close();
      expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("readable");
    });
  });

  it("memoizes legacy inspection and follows Doctor's ownership flip", async () => {
    await withAgentDirEnv("openclaw-auth-shared-memo-", async (agentDir, stateDir) => {
      const sourcePath = resolveAuthProfileDatabasePath(agentDir);
      writePersistedAuthProfileStoreRaw(apiKeyStore("sk-legacy"), agentDir);
      const realLstat = fs.lstatSync;
      let sourceInspections = 0;
      const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation((pathname, options) => {
        if (path.resolve(String(pathname)) === path.resolve(sourcePath)) {
          sourceInspections += 1;
        }
        return realLstat(pathname, options as never);
      });

      try {
        for (const key of ["sk-first", "sk-second"]) {
          await upsertAuthProfileWithLockOrThrow({
            agentDir,
            profileId: "openai:default",
            credential: apiKeyCredential(key),
          });
        }
        expect(sourceInspections).toBe(1);

        const detected = detectSharedAuthStoreMigration({
          stateDir,
          doctorOnlyStateMigrations: true,
        });
        await migrateSharedAuthStore({ detected, stateDir });
        const inspectionsAfterDoctor = sourceInspections;

        await upsertAuthProfileWithLockOrThrow({
          agentDir,
          profileId: "openai:default",
          credential: apiKeyCredential("sk-after-doctor"),
        });

        expect(sourceInspections).toBe(inspectionsAfterDoctor);
        expect(ensureAuthProfileStore(undefined, { syncExternalCli: false })).toMatchObject({
          profiles: { "openai:default": { key: "sk-after-doctor" } },
        });
        expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("missing");
      } finally {
        lstatSpy.mockRestore();
      }
    });
  });

  it("keeps legacy ownership while shared-auth cleanup is pending", async () => {
    await withAgentDirEnv("openclaw-auth-shared-pending-", async (agentDir) => {
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

      await upsertAuthProfileWithLockOrThrow({
        agentDir,
        profileId: "openai:default",
        credential: apiKeyCredential("sk-after-crash"),
      });

      const after = new DatabaseSync(resolveOpenClawStateSqlitePath());
      expect(
        after
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'auth.sharedStore'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        after
          .prepare(
            "SELECT state_key FROM config_machine_state WHERE state_key = 'authProfiles.store'",
          )
          .get(),
      ).toBeUndefined();
      after.close();
      expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("readable");
    });
  });

  it("keeps legacy ownership when the main-agent source is unreadable", async () => {
    await withAgentDirEnv("openclaw-auth-shared-unreadable-", async (agentDir) => {
      const sourcePath = resolveAuthProfileDatabasePath(agentDir);
      const realLstat = fs.lstatSync;
      const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation((pathname, options) => {
        if (path.resolve(String(pathname)) === path.resolve(sourcePath)) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return realLstat(pathname, options as never);
      });

      try {
        await upsertAuthProfileWithLockOrThrow({
          agentDir,
          profileId: "openai:default",
          credential: apiKeyCredential("sk-unreadable"),
        });
      } finally {
        lstatSpy.mockRestore();
      }

      const sharedDatabase = new DatabaseSync(resolveOpenClawStateSqlitePath());
      expect(
        sharedDatabase
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'auth.sharedStore'",
          )
          .get(),
      ).toBeUndefined();
      sharedDatabase.close();
      expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("readable");
    });
  });

  it("keeps legacy ownership when a retired-file probe fails", async () => {
    await withAgentDirEnv("openclaw-auth-shared-file-probe-error-", async (agentDir) => {
      const authPath = path.join(agentDir, "auth-profiles.json");
      const realExistsSync = fs.existsSync.bind(fs);
      let authPathProbes = 0;
      const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((pathname) => {
        if (path.resolve(String(pathname)) === path.resolve(authPath)) {
          authPathProbes += 1;
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return realExistsSync(pathname);
      });

      try {
        writePersistedAuthProfileStoreRaw(apiKeyStore("sk-first"));
        writePersistedAuthProfileStoreRaw(apiKeyStore("sk-second"));
        expect(authPathProbes).toBe(1);
      } finally {
        existsSpy.mockRestore();
      }

      const sharedDatabase = new DatabaseSync(resolveOpenClawStateSqlitePath());
      expect(
        sharedDatabase
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'auth.sharedStore'",
          )
          .get(),
      ).toBeUndefined();
      sharedDatabase.close();
      expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("readable");
    });
  });

  it("does not read legacy auth-profiles.json at runtime", async () => {
    await withAgentDirEnv("openclaw-auth-no-json-fallback-", (agentDir) => {
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        `${JSON.stringify(apiKeyStore("sk-json"))}\n`,
        "utf8",
      );

      expect(() => ensureAuthProfileStore(agentDir, { syncExternalCli: false })).toThrow(
        "requires legacy credential migration",
      );
    });
  });

  it("keeps serving SQLite credentials when a credential source appears during the read", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-late-legacy-", (agentDir) => {
      saveAuthProfileStore(apiKeyStore("not-a-real"), agentDir);
      const legacyPath = path.join(agentDir, "auth.json");
      const existsSync = fs.existsSync.bind(fs);
      let legacyChecks = 0;
      const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((pathname) => {
        if (path.resolve(String(pathname)) === path.resolve(legacyPath)) {
          legacyChecks += 1;
          if (legacyChecks === 2) {
            fs.writeFileSync(legacyPath, '{"openai":{"key":"not-a-real"}}\n', "utf8");
            return true;
          }
          return false;
        }
        return existsSync(pathname);
      });
      try {
        // The migrated store already owns these credentials, so a retired file
        // appearing beside it is unarchived bytes rather than pending migration.
        expect(
          ensureAuthProfileStore(agentDir, { syncExternalCli: false }).profiles["openai:default"],
        ).toMatchObject({ type: "api_key", provider: "openai", key: "not-a-real" });
      } finally {
        existsSpy.mockRestore();
      }
      // Runtime never reads or removes it; Doctor still owns the archive step.
      expect(fs.existsSync(legacyPath)).toBe(true);
    });
  });

  it("does not create sqlite files for missing-store reads", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-no-create-", (agentDir) => {
      expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
      expect(fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    });
  });

  it("treats a legacy agent database without auth tables as a missing store", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-legacy-schema-", (agentDir) => {
      const database = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
      database.exec("CREATE TABLE legacy_state (id INTEGER PRIMARY KEY);");
      database.close();

      expect(inspectPersistedAuthProfileStoreRaw(agentDir)).toEqual({
        status: "missing",
        reason: "table",
      });
    });
  });

  it("classifies each missing auth table through an existing database handle", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-partial-schema-", (agentDir) => {
      const database = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
      database.exec(`
        CREATE TABLE auth_profile_store (
          store_key TEXT NOT NULL PRIMARY KEY,
          store_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      try {
        expect(inspectPersistedAuthProfileStoreRaw(agentDir, { db: database })).toEqual({
          status: "missing",
          reason: "row",
        });
        expect(inspectPersistedAuthProfileStateRaw(agentDir, { db: database })).toEqual({
          status: "missing",
          reason: "table",
        });
      } finally {
        database.close();
      }
    });
  });

  it("rejects a newer agent database that has no current auth table", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-newer-schema-", (agentDir) => {
      const database = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
      database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
      database.close();

      expect(inspectPersistedAuthProfileStoreRaw(agentDir)).toEqual({ status: "unreadable" });
    });
  });

  it("keeps auth schema classifications fresh after external schema changes", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-invalid-schema-", (agentDir) => {
      const database = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
      const createTable = `
        CREATE TABLE auth_profile_store (
          store_key TEXT NOT NULL PRIMARY KEY,
          store_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `;
      try {
        database.exec(
          "CREATE VIEW auth_profile_store AS SELECT 'primary' AS store_key, '{}' AS store_json;",
        );
        expect(inspectPersistedAuthProfileStoreRaw(agentDir)).toEqual({ status: "unreadable" });
        expect(() => loadAuthProfileStoreForRuntime(agentDir, { readOnly: true })).toThrow(
          "is unreadable",
        );

        for (const key of ["synthetic-first", "synthetic-recreated"]) {
          database.exec(`DROP VIEW auth_profile_store; ${createTable}`);
          database
            .prepare("INSERT INTO auth_profile_store VALUES ('primary', ?, 1)")
            .run(JSON.stringify(apiKeyStore(key)));
          expect(loadAuthProfileStoreForRuntime(agentDir, { readOnly: true })).toMatchObject(
            apiKeyStore(key),
          );
          database.exec("DROP TABLE auth_profile_store;");
          expect(inspectPersistedAuthProfileStoreRaw(agentDir)).toEqual({
            status: "missing",
            reason: "table",
          });
          expect(loadAuthProfileStoreForRuntime(agentDir, { readOnly: true }).profiles).toEqual({});
          database.exec(
            "CREATE VIEW auth_profile_store AS SELECT 'primary' AS store_key, '{}' AS store_json;",
          );
          expect(inspectPersistedAuthProfileStoreRaw(agentDir)).toEqual({ status: "unreadable" });
          expect(() => loadAuthProfileStoreForRuntime(agentDir, { readOnly: true })).toThrow(
            "is unreadable",
          );
        }
      } finally {
        database.close();
      }
    });
  });

  it("reads existing sqlite auth stores without registering shared state", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-readonly-", (agentDir) => {
      saveAuthProfileStore(apiKeyStore("sk-test"), agentDir);
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const stateDbPath = resolveOpenClawStateSqlitePath();
      fs.rmSync(path.dirname(stateDbPath), { recursive: true, force: true });

      const loaded = loadPersistedAuthProfileStore(agentDir);

      expect(loaded?.profiles["openai:default"]).toMatchObject({ key: "sk-test" });
      expect(fs.existsSync(stateDbPath)).toBe(false);
    });
  });

  it("reuses the transaction database while filtering multiple inherited OAuth profiles", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-save-reuse-", (mainAgentDir) => {
      const customAgentDir = path.join(path.dirname(path.dirname(mainAgentDir)), "custom", "agent");
      const profiles = Object.fromEntries(
        Array.from({ length: 3 }, (_, index) => [
          `openai:profile-${index}`,
          {
            type: "oauth" as const,
            provider: "openai",
            access: `access-${index}`,
            refresh: `refresh-${index}`,
            expires: Date.now() + 60_000,
          },
        ]),
      );
      const store: AuthProfileStore = { version: 1, profiles };
      saveAuthProfileStore(store, mainAgentDir);
      closeOpenClawAgentDatabasesForTest();
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      try {
        saveAuthProfileStore(store, customAgentDir);
        const readOnlyOpens = openSpy.mock.calls.filter(
          ([, options]) => options?.readOnly === true,
        );
        expect(readOnlyOpens).toHaveLength(1);
        expect(path.resolve(String(readOnlyOpens[0]?.[0]))).toBe(
          path.resolve(resolveAuthProfileDatabasePath(mainAgentDir)),
        );
      } finally {
        openSpy.mockRestore();
      }
    });
  });

  it("waits for brief rollback-journal contention before reading persisted auth", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-contention-", async (agentDir) => {
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
  });

  it("uses the configured agent id for custom agentDir databases", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-custom-agent-", (envAgentDir) => {
      const customAgentDir = path.join(path.dirname(path.dirname(envAgentDir)), "custom-coder");
      const cfg = {
        agents: {
          list: [{ id: "coder", agentDir: customAgentDir }],
        },
      };
      const agentDir = resolveAgentDir(cfg, "coder");

      saveAuthProfileStore(apiKeyStore("sk-test"), agentDir);

      const database = openOpenClawAgentDatabase({
        agentId: "coder",
        path: resolveAuthProfileDatabasePath(agentDir),
      });
      expect(database.agentId).toBe("coder");
    });
  });

  it("resolves database filenames without reverse-owner filesystem discovery", async () => {
    await withAgentDirEnv("openclaw-auth-filename-", (agentDir, stateDir) => {
      const alias = path.join(stateDir, "agent-alias");
      const missing = path.join(stateDir, "missing", "agent");
      fs.symlinkSync(agentDir, alias, "junction");
      withEnv({ OPENCLAW_HOME: stateDir }, () => {
        const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
        expect(resolveAuthProfileDatabasePath("")).toBe(databasePath);
        const realpath = vi.spyOn(fs.realpathSync, "native");
        try {
          for (const [input, expected] of [
            [agentDir, databasePath],
            [path.relative(process.cwd(), agentDir), databasePath],
            ["~/agents/main/agent", databasePath],
            [alias, path.join(alias, "openclaw-agent.sqlite")],
            [missing, path.join(missing, "openclaw-agent.sqlite")],
            ["", databasePath],
            ["  ", "openclaw-agent.sqlite"],
          ] as const) {
            expect(resolveAuthProfileDatabasePath(input)).toBe(expected);
          }
          expect(realpath).not.toHaveBeenCalled();
          expect(fs.existsSync(missing)).toBe(false);
        } finally {
          realpath.mockRestore();
        }
      });
    });
  });

  it("does not copy an unused same-owner snapshot during runtime reads", async () => {
    await withAgentDirEnv("openclaw-auth-snapshot-work-", (agentDir) => {
      const store = { ...apiKeyStore("synthetic"), order: { openai: ["openai:default"] } };
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
      const clone = vi.spyOn(authProfileClone, "cloneAuthProfileStore");
      try {
        const loaded = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
        expect(loaded).toMatchObject(store);
        expect(clone.mock.calls.length).toBeLessThanOrEqual(2);
        expectDefined(loaded.order?.openai, "loaded profile order").push("mutated");
        expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.order?.openai).toEqual([
          "openai:default",
        ]);
      } finally {
        clone.mockRestore();
      }
    });
  });

  it("keeps an explicit inherited snapshot authoritative for an omitted agent", async () => {
    await withAgentDirEnv("openclaw-auth-inherited-selection-", (agentDir, stateDir) => {
      const inheritedAuthDir = path.join(stateDir, "inherited");
      replaceRuntimeAuthProfileStoreSnapshots([
        { agentDir, store: apiKeyStore("shared") },
        { agentDir: inheritedAuthDir, store: apiKeyStore("inherited") },
      ]);
      expect(
        ensureAuthProfileStoreWithoutExternalProfiles(undefined, { inheritedAuthDir }).profiles,
      ).toEqual(apiKeyStore("inherited").profiles);
    });
  });

  it("keeps SecretRef-backed credentials from persisting duplicate plaintext", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-secret-ref-", (agentDir) => {
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

      const loaded = ensureAuthProfileStore(agentDir, { syncExternalCli: false });

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

  it("recomputes runtime-only external auth overlays from the sqlite base store", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-overlay-", (agentDir) => {
      saveAuthProfileStore(apiKeyStore("sk-test"), agentDir);
      mocks.resolveExternalCliAuthProfiles
        .mockReturnValueOnce([
          {
            profileId: "openai:default",
            credential: {
              type: "oauth",
              provider: "openai",
              access: "access-1",
              refresh: "refresh-1",
              expires: Date.now() + 60_000,
            },
          },
        ])
        .mockReturnValueOnce([
          {
            profileId: "openai:default",
            credential: {
              type: "oauth",
              provider: "openai",
              access: "access-2",
              refresh: "refresh-2",
              expires: Date.now() + 60_000,
            },
          },
        ]);

      const first = ensureAuthProfileStore(agentDir);
      const second = ensureAuthProfileStore(agentDir);

      expect((first.profiles["openai:default"] as OAuthCredential | undefined)?.access).toBe(
        "access-1",
      );
      expect((second.profiles["openai:default"] as OAuthCredential | undefined)?.access).toBe(
        "access-2",
      );
      expect(mocks.resolveExternalCliAuthProfiles).toHaveBeenCalledTimes(2);
    });
  });
});
