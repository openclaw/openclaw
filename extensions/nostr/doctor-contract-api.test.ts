// Nostr tests cover doctor contract api plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";

function requireStateMigration(index: number) {
  return expectDefined(stateMigrations[index], `Nostr state migration ${index}`);
}

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("nostr", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

describe("nostr doctor state migration", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-doctor-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  async function writeOrderedLegacyFiles(
    namespace: string,
    entries: Array<{ accountId: string; value: unknown }>,
  ) {
    const nostrDir = path.join(stateDir, "nostr");
    await fs.mkdir(nostrDir, { recursive: true });
    const names = entries.map(({ accountId }) => `${namespace}-${accountId}.json`);
    const paths = names.map((name) => path.join(nostrDir, name));
    for (const [index, entry] of entries.entries()) {
      await fs.writeFile(
        expectDefined(paths[index], "legacy source path"),
        JSON.stringify(entry.value),
      );
    }
    const readdir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      const result = await readdir(...args);
      return String(args[0]) === nostrDir
        ? result.toSorted(
            (left, right) => names.indexOf(String(left.name)) - names.indexOf(String(right.name)),
          )
        : result;
    });
    return paths;
  }

  describe.each([
    {
      index: 0,
      namespace: "bus-state",
      label: "Nostr bus state",
      value: (timestamp: number) => ({
        version: 2,
        lastProcessedAt: timestamp,
        gatewayStartedAt: null,
        recentEventIds: [],
      }),
    },
    {
      index: 1,
      namespace: "profile-state",
      label: "Nostr profile state",
      value: (timestamp: number) => ({
        version: 1,
        lastPublishedAt: timestamp,
        lastPublishedEventId: null,
        lastPublishResults: null,
      }),
    },
  ])("$namespace migration", ({ index, namespace, label, value }) => {
    it("refuses the whole import before archiving when distinct missing keys exceed capacity", async () => {
      const context = createDoctorContext(env);
      const store = context.openPluginStateKeyedStore({ namespace, maxEntries: 256 });
      for (let key = 0; key < 255; key++) {
        await store.register(`existing-${key}`, value(key));
      }
      const before = await store.entries();
      const paths = await writeOrderedLegacyFiles(namespace, [
        { accountId: "existing-0", value: value(999) },
        { accountId: "missing-a", value: value(1) },
        { accountId: "missing-b", value: value(2) },
      ]);
      await expect(
        requireStateMigration(index).migrateLegacyState({
          config: {},
          env,
          stateDir,
          oauthDir: path.join(stateDir, "oauth"),
          context,
        }),
      ).resolves.toEqual({
        changes: [],
        warnings: [
          `Skipped migrating ${label} because plugin state has room for 1 of 2 missing entries; left legacy sources in place`,
        ],
      });
      expect(before).toHaveLength(255);
      await expect(store.entries()).resolves.toEqual(before);
      for (const filePath of paths) {
        await fs.access(filePath);
        await expect(fs.access(`${filePath}.migrated`)).rejects.toThrow();
      }
    });

    it("preserves existing keys and first collision values while archiving in discovery order", async () => {
      const context = createDoctorContext(env);
      const store = context.openPluginStateKeyedStore({ namespace, maxEntries: 256 });
      await store.register("existing", value(100));
      const paths = await writeOrderedLegacyFiles(namespace, [
        { accountId: "existing", value: value(999) },
        { accountId: "team@one", value: value(1) },
        { accountId: "team one", value: value(2) },
      ]);
      const params = { config: {}, env, stateDir, oauthDir: path.join(stateDir, "oauth"), context };
      await expect(requireStateMigration(index).detectLegacyState(params)).resolves.toEqual({
        preview: [`- ${label}: 3 accounts -> plugin state (${namespace})`],
      });
      await expect(requireStateMigration(index).migrateLegacyState(params)).resolves.toEqual({
        changes: [
          `Migrated 1 Nostr ${namespace} entry -> plugin state`,
          ...paths.map((filePath) => `Archived ${label} legacy source -> ${filePath}.migrated`),
        ],
        warnings: [],
      });
      await expect(store.lookup("existing")).resolves.toEqual(value(100));
      await expect(store.lookup("team_one")).resolves.toEqual(value(1));
      await expect(store.entries()).resolves.toHaveLength(2);
      for (const filePath of paths) {
        await expect(fs.access(filePath)).rejects.toThrow();
        await fs.access(`${filePath}.migrated`);
      }
    });

    it("commits and archives each source before a later registration failure", async () => {
      const paths = await writeOrderedLegacyFiles(namespace, [
        { accountId: "first", value: value(1) },
        { accountId: "second", value: value(2) },
        { accountId: "third", value: value(3) },
      ]);
      const firstPath = expectDefined(paths[0], "first legacy source path");
      const baseContext = createDoctorContext(env);
      const registrations: string[] = [];
      const failure = new Error("second registration failed");
      const context: PluginDoctorStateMigrationContext = {
        openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
          const store = baseContext.openPluginStateKeyedStore<T>(options);
          const wrapped: typeof store = {
            ...store,
            async register(key, entry, registerOptions) {
              registrations.push(key);
              if (key === "second") {
                await fs.access(`${firstPath}.migrated`);
                await expect(fs.access(firstPath)).rejects.toThrow();
                throw failure;
              }
              await store.register(key, entry, registerOptions);
            },
          };
          return wrapped;
        },
      };
      await expect(
        requireStateMigration(index).migrateLegacyState({
          config: {},
          env,
          stateDir,
          oauthDir: path.join(stateDir, "oauth"),
          context,
        }),
      ).rejects.toBe(failure);
      expect(registrations).toEqual(["first", "second"]);
      const store = baseContext.openPluginStateKeyedStore({ namespace, maxEntries: 256 });
      await expect(store.lookup("first")).resolves.toEqual(value(1));
      await expect(store.entries()).resolves.toHaveLength(1);
      for (const filePath of paths.slice(1)) {
        await fs.access(filePath);
        await expect(fs.access(`${filePath}.migrated`)).rejects.toThrow();
      }
    });

    it("keeps committed state and continues after an archive failure", async () => {
      const paths = await writeOrderedLegacyFiles(namespace, [
        { accountId: "first", value: value(1) },
        { accountId: "second", value: value(2) },
      ]);
      const firstPath = expectDefined(paths[0], "first legacy source path");
      const secondPath = expectDefined(paths[1], "second legacy source path");
      await fs.mkdir(`${firstPath}.migrated`);
      const context = createDoctorContext(env);
      const result = await requireStateMigration(index).migrateLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context,
      });
      expect(result.changes).toEqual([
        `Migrated 2 Nostr ${namespace} entries -> plugin state`,
        `Archived ${label} legacy source -> ${secondPath}.migrated`,
      ]);
      expect(result.warnings).toEqual([
        expect.stringContaining(`Failed archiving ${label} legacy source:`),
      ]);
      const store = context.openPluginStateKeyedStore({ namespace, maxEntries: 256 });
      await expect(store.lookup("first")).resolves.toEqual(value(1));
      await expect(store.lookup("second")).resolves.toEqual(value(2));
      await fs.access(firstPath);
      await expect(fs.access(secondPath)).rejects.toThrow();
      await fs.access(`${secondPath}.migrated`);
    });
  });

  it("imports legacy bus and profile state into plugin state", async () => {
    const nostrDir = path.join(stateDir, "nostr");
    const busPath = path.join(nostrDir, "bus-state-main.json");
    const profilePath = path.join(nostrDir, "profile-state-main.json");
    await fs.mkdir(nostrDir, { recursive: true });
    await fs.writeFile(
      busPath,
      JSON.stringify({
        version: 1,
        lastProcessedAt: 1700,
        gatewayStartedAt: 1600,
      }),
    );
    await fs.writeFile(
      profilePath,
      JSON.stringify({
        version: 1,
        lastPublishedAt: 1800,
        lastPublishedEventId: "event-1",
        lastPublishResults: { "wss://relay.example": "ok", bad: "nope" },
      }),
    );

    const context = createDoctorContext(env);
    const busResult = await requireStateMigration(0).migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    });
    const profileResult = await requireStateMigration(1).migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    });

    expect(busResult.warnings).toEqual([]);
    expect(profileResult.warnings).toEqual([]);
    await expect(fs.access(busPath)).rejects.toThrow();
    await expect(fs.access(profilePath)).rejects.toThrow();
    await fs.access(`${busPath}.migrated`);
    await fs.access(`${profilePath}.migrated`);
    await expect(
      context.openPluginStateKeyedStore({ namespace: "bus-state", maxEntries: 256 }).lookup("main"),
    ).resolves.toEqual({
      version: 2,
      lastProcessedAt: 1700,
      gatewayStartedAt: 1600,
      recentEventIds: [],
    });
    await expect(
      context
        .openPluginStateKeyedStore({ namespace: "profile-state", maxEntries: 256 })
        .lookup("main"),
    ).resolves.toEqual({
      version: 1,
      lastPublishedAt: 1800,
      lastPublishedEventId: "event-1",
      lastPublishResults: { "wss://relay.example": "ok" },
    });
  });

  it("preserves legacy account key bytes when importing state files", async () => {
    const nostrDir = path.join(stateDir, "nostr");
    const busPath = path.join(nostrDir, "bus-state-Team.A.json");
    await fs.mkdir(nostrDir, { recursive: true });
    await fs.writeFile(
      busPath,
      JSON.stringify({
        version: 1,
        lastProcessedAt: 1700,
        gatewayStartedAt: 1600,
      }),
    );

    const context = createDoctorContext(env);
    await requireStateMigration(0).migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    });

    const store = context.openPluginStateKeyedStore({ namespace: "bus-state", maxEntries: 256 });
    await expect(store.lookup("Team.A")).resolves.toMatchObject({
      lastProcessedAt: 1700,
    });
    await expect(store.lookup("team-a")).resolves.toBeUndefined();
  });
});
