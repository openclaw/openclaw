// Zalouser tests cover Doctor-owned credential migration.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateSyncKeyedStoreForTests,
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { setZalouserRuntime } from "./src/runtime.js";
import {
  clearStoredZaloCredentials,
  resolveLegacyZalouserCredentialsPath,
  zalouserCredentialStoreKey,
  ZALOUSER_CREDENTIALS_MAX_ENTRIES,
  ZALOUSER_CREDENTIALS_NAMESPACE,
  type StoredZaloCredentials,
} from "./src/session-state.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("zalouser", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

describe("zalouser doctor state migration", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-doctor-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("imports a profile credential blob into SQLite before archiving it", async () => {
    const profile = "work";
    const filePath = resolveLegacyZalouserCredentialsPath(profile, env);
    const legacy = {
      imei: "imei-1",
      cookie: [{ key: "zpsid", value: "secret", domain: "chat.zalo.me" }],
      userAgent: "user-agent",
      language: "vi",
      lastUsedAt: "2026-07-02T12:00:00.000Z",
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(legacy));
    const createdAt = (await fs.stat(filePath)).mtime.toISOString();
    const migration = stateMigrations.find(
      (entry) => entry.id === "zalouser-credentials-json-to-plugin-state",
    );
    if (!migration) {
      throw new Error("missing Zalouser credential migration");
    }
    const context = createDoctorContext(env);
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [
        `- Zalo Personal credentials: 1 file -> plugin state (${ZALOUSER_CREDENTIALS_NAMESPACE})`,
      ],
    });
    const result = await migration.migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Zalo Personal credentials for profile work",
      expect.stringContaining("Archived Zalo Personal credentials legacy source"),
    ]);
    const store = context.openPluginStateKeyedStore<StoredZaloCredentials>({
      namespace: ZALOUSER_CREDENTIALS_NAMESPACE,
      maxEntries: ZALOUSER_CREDENTIALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(store.lookup(zalouserCredentialStoreKey(profile))).resolves.toEqual({
      profile,
      ...legacy,
      createdAt,
    });
    await expect(fs.access(`${filePath}.migrated`)).resolves.toBeUndefined();
  });

  it("archives legacy credentials without restoring an explicitly cleared profile", async () => {
    const profile = "work";
    const filePath = resolveLegacyZalouserCredentialsPath(profile, env);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        imei: "legacy-imei",
        cookie: [{ key: "zpsid", value: "legacy", domain: "chat.zalo.me" }],
        userAgent: "legacy-agent",
      }),
    );
    const runtime = createPluginRuntimeMock();
    runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("zalouser", {
        ...options,
        env: options.env ?? env,
      });
    setZalouserRuntime(runtime);
    clearStoredZaloCredentials(profile, env);
    const context = createDoctorContext(env);
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };
    const migration = stateMigrations.find(
      (entry) => entry.id === "zalouser-credentials-json-to-plugin-state",
    )!;

    const result = await migration.migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Archived revoked Zalo Personal credential legacy source for profile work",
      expect.stringContaining("Archived Zalo Personal credentials legacy source"),
    ]);
    await expect(fs.access(`${filePath}.migrated`)).resolves.toBeUndefined();
  });
});
