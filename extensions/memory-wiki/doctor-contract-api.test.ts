// Memory Wiki Doctor preserves retired files and supported SQLite state.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  OpenBlobStoreOptions,
  OpenKeyedStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginBlobStoreForTests,
  createPluginStateKeyedStoreForTests,
  resetPluginBlobStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { rollbackChatGptImportRun } from "./src/chatgpt-import.js";
import {
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
} from "./src/compiled-cache.js";
import { resolveMemoryWikiConfig } from "./src/config.js";
import {
  configureMemoryWikiImportRunStateStore,
  createMemoryWikiImportRunStateStore,
  readMemoryWikiImportRunRecord,
} from "./src/import-runs-state.js";
import {
  createMemoryWikiSourceSyncStateStore,
  readMemoryWikiSourceSyncState,
  writeMemoryWikiSourceSyncState,
} from "./src/source-sync-state.js";
import { createMemoryWikiTestHarness } from "./src/test-helpers.js";

function requireStateMigration(id: string) {
  return expectDefined(
    stateMigrations.find((migration) => migration.id === id),
    `Memory Wiki state migration ${id}`,
  );
}

const tempDirs = createMemoryWikiTestHarness();

function resolveLegacyImportRunRecordPath(vaultRoot: string, runId: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "import-runs", `${runId}.json`);
}

function migrationParams(params: { stateDir: string; vaultRoot: string; agentIds?: string[] }) {
  const env = { ...process.env, HOME: params.stateDir, OPENCLAW_STATE_DIR: params.stateDir };
  return {
    config: {
      ...(params.agentIds ? { agents: { list: params.agentIds.map((id) => ({ id })) } } : {}),
      plugins: {
        entries: {
          "memory-wiki": {
            config: {
              vault: {
                path: params.vaultRoot,
                ...(params.agentIds ? { scope: "agent" as const } : {}),
              },
            },
          },
        },
      },
    },
    env,
    stateDir: params.stateDir,
    oauthDir: path.join(params.stateDir, "credentials"),
    context: {
      openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
    },
  };
}

// Row keys and values are the v2026.7.1-beta.1 writer's format, independent of current codecs.
function julyVaultRootKey(vaultRoot: string): string {
  return createHash("sha256").update(path.resolve(vaultRoot), "utf8").digest("hex").slice(0, 32);
}

async function seedJulySourceSyncRow(
  params: Pick<ReturnType<typeof migrationParams>, "context">,
  vaultRoot: string,
  syncKey = "alpha",
) {
  const vaultRootKey = julyVaultRootKey(vaultRoot);
  const entry = {
    group: "bridge" as const,
    pagePath: `sources/${syncKey}.md`,
    sourcePath: `/tmp/${syncKey}.md`,
    sourceUpdatedAtMs: 100,
    sourceSize: 200,
    renderFingerprint: syncKey,
  };
  const store = params.context.openPluginStateKeyedStore({
    namespace: "source-sync",
    maxEntries: 20_000,
  });
  await store.register(
    createHash("sha256").update(`${vaultRootKey}\0${syncKey}`, "utf8").digest("hex"),
    { ...entry, vaultRootKey, syncKey },
  );
  // July's namespace options belong to the old process; current readers choose theirs on reopen.
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  return entry;
}

async function seedJulyImportRun(
  params: Pick<ReturnType<typeof migrationParams>, "context">,
  vaultRoot: string,
  runId: string,
  paths: { created?: string; updated?: string } = {},
): Promise<void> {
  const vaultRootKey = julyVaultRootKey(vaultRoot);
  const store = params.context.openPluginStateKeyedStore({
    namespace: "import-runs",
    maxEntries: 20_000,
  });
  const metadata = {
    version: 1,
    kind: "meta",
    vaultRootKey,
    runId,
    importType: "chatgpt",
    exportPath: "/tmp/chatgpt",
    sourcePath: "/tmp/chatgpt/conversations.json",
    appliedAt: "2026-07-01T12:00:00.000Z",
    conversationCount: 2,
    createdCount: paths.created ? 1 : 0,
    updatedCount: paths.updated ? 1 : 0,
    skippedCount: 0,
  };
  await store.register(
    createHash("sha256").update(`${vaultRootKey}\0meta\0${runId}`, "utf8").digest("hex"),
    metadata,
  );
  for (const [kind, pagePath] of [
    ["created-path", paths.created],
    ["updated-path", paths.updated],
  ] as const) {
    if (!pagePath) {
      continue;
    }
    await store.register(
      createHash("sha256")
        .update([vaultRootKey, runId, kind, 0, pagePath].join("\0"), "utf8")
        .digest("hex"),
      {
        kind,
        vaultRootKey,
        runId,
        index: 0,
        path: pagePath,
        ...(kind === "updated-path" ? { snapshotPath: "snapshots/alpha.md" } : {}),
      },
    );
  }
}

describe("memory-wiki Doctor state compatibility", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    configureMemoryWikiCompiledCacheStore(undefined);
    configureMemoryWikiImportRunStateStore(undefined);
    resetPluginBlobStoreForTests();
    resetPluginStateStoreForTests();
  });

  it("deletes rebuildable compiled cache files without importing them", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    const vaultRoot = path.join(stateDir, "vault");
    const cacheDir = path.join(vaultRoot, ".openclaw-wiki", "cache");
    const legacyPaths = [
      path.join(cacheDir, "agent-digest.json"),
      path.join(cacheDir, "claims.jsonl"),
    ];
    await fs.mkdir(cacheDir, { recursive: true });
    await Promise.all(legacyPaths.map((filePath) => fs.writeFile(filePath, "stale\n", "utf8")));
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = requireStateMigration("memory-wiki-compiled-cache-file-cleanup");

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: legacyPaths.map((filePath) =>
        expect.stringContaining(`Remove rebuildable Memory Wiki compiled cache: ${filePath}`),
      ),
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: legacyPaths.map(
        (filePath) => `Removed rebuildable Memory Wiki compiled cache: ${filePath}`,
      ),
      warnings: [],
    });
    await Promise.all(
      legacyPaths.map((filePath) =>
        expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" }),
      ),
    );
  });

  it("migrates the default state-directory vault without touching the real-home vault", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-state-");
    const homeDir = await tempDirs.createTempDir("memory-wiki-doctor-home-");
    const stateVault = path.join(stateDir, "wiki", "main");
    const homeVault = path.join(homeDir, ".openclaw", "wiki", "main");
    const cacheRelativePath = path.join(".openclaw-wiki", "cache", "agent-digest.json");
    const stateCache = path.join(stateVault, cacheRelativePath);
    const homeCache = path.join(homeVault, cacheRelativePath);
    for (const cachePath of [stateCache, homeCache]) {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "stale\n", "utf8");
    }
    const params = {
      ...migrationParams({ stateDir, vaultRoot: stateVault }),
      config: { plugins: { entries: { "memory-wiki": { config: {} } } } },
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir },
    };
    const migration = requireStateMigration("memory-wiki-compiled-cache-file-cleanup");

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining(stateCache)],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [expect.stringContaining(stateCache)],
      warnings: [],
    });
    await expect(fs.stat(stateCache)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(homeCache, "utf8")).resolves.toBe("stale\n");
  });

  it("skips configured vaults that have not been initialized", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    const vaultRoot = path.join(stateDir, "missing-vault");
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = requireStateMigration("memory-wiki-compiled-cache-file-cleanup");

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });

  it("does not follow a symlinked legacy cache directory", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    const vaultRoot = path.join(stateDir, "vault");
    const externalCacheDir = path.join(stateDir, "external-cache");
    const externalCachePath = path.join(externalCacheDir, "agent-digest.json");
    await fs.mkdir(path.join(vaultRoot, ".openclaw-wiki"), { recursive: true });
    await fs.mkdir(externalCacheDir, { recursive: true });
    await fs.writeFile(externalCachePath, "private\n", "utf8");
    await fs.symlink(externalCacheDir, path.join(vaultRoot, ".openclaw-wiki", "cache"));
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = requireStateMigration("memory-wiki-compiled-cache-file-cleanup");

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    await expect(fs.readFile(externalCachePath, "utf8")).resolves.toBe("private\n");
  });

  it.each(["source-sync", "import-runs"] as const)(
    "refuses retired %s JSON without reading, importing, or archiving it",
    async (source) => {
      const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
      const vaultRoot = path.join(stateDir, "vault");
      const otherVault = path.join(stateDir, "other-vault");
      const legacyPath =
        source === "source-sync"
          ? path.join(vaultRoot, ".openclaw-wiki", "source-sync.json")
          : resolveLegacyImportRunRecordPath(vaultRoot, "chatgpt-alpha");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      const params = migrationParams({ stateDir, vaultRoot });
      const legacyValue =
        source === "source-sync"
          ? {
              version: 1,
              entries: { alpha: await seedJulySourceSyncRow(params, otherVault) },
            }
          : {
              version: 1,
              runId: "chatgpt-alpha",
              importType: "chatgpt",
              exportPath: "/tmp/chatgpt",
              sourcePath: "/tmp/chatgpt/conversations.json",
              appliedAt: "2026-06-01T12:00:00.000Z",
              conversationCount: 1,
              createdCount: 1,
              updatedCount: 0,
              skippedCount: 0,
              createdPaths: ["sources/legacy.md"],
              updatedPaths: [],
            };
      if (source === "import-runs") {
        await seedJulyImportRun(params, otherVault, "chatgpt-alpha");
      }
      const migration = requireStateMigration(`memory-wiki-${source}-json-to-plugin-state`);
      for (const bytes of [
        JSON.stringify(legacyValue),
        "retired malformed JSON must survive unchanged\n",
      ]) {
        await fs.writeFile(legacyPath, bytes);
        await expect(migration.detectLegacyState(params)).resolves.toEqual({
          preview: [expect.stringContaining("upgrades from pre-July-2026 JSON state")],
        });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await expect(migration.migrateLegacyState(params)).resolves.toEqual({
            changes: [],
            warnings: [expect.stringContaining(legacyPath)],
          });
        }
        await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe(bytes);
        await expect(fs.stat(`${legacyPath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore).read(
            vaultRoot,
          ),
        ).resolves.toEqual({ version: 1, entries: {} });
        await expect(
          createMemoryWikiImportRunStateStore(params.context.openPluginStateKeyedStore).list(
            vaultRoot,
          ),
        ).resolves.toEqual([]);
      }
    },
  );

  it("preserves July source rows and explains an empty canonical store without reviving JSON", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-state-");
    const homeDir = await tempDirs.createTempDir("memory-wiki-doctor-home-");
    const vaultRoot = path.join(stateDir, "wiki", "main");
    const legacyPath = path.join(vaultRoot, ".openclaw-wiki", "source-sync.json");
    const homeLegacyPath = path.join(
      homeDir,
      ".openclaw",
      "wiki",
      "main",
      ".openclaw-wiki",
      "source-sync.json",
    );
    for (const filePath of [legacyPath, homeLegacyPath]) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "stale source JSON\n");
    }
    const params = {
      ...migrationParams({ stateDir, vaultRoot }),
      config: { plugins: { entries: { "memory-wiki": { config: {} } } } },
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir },
    };
    const entry = await seedJulySourceSyncRow(params, vaultRoot);
    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    const migration = requireStateMigration("memory-wiki-source-sync-json-to-plugin-state");

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    const state = await readMemoryWikiSourceSyncState(vaultRoot, store);
    expect(state).toEqual({ version: 1, entries: { alpha: entry } });
    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      { version: 1, entries: { alpha: { ...entry, sourceSize: 201 } } },
      store,
    );
    await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toMatchObject({
      entries: { alpha: { sourceSize: 201 } },
    });
    await writeMemoryWikiSourceSyncState(vaultRoot, { version: 1, entries: {} }, store);
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [expect.stringContaining("an empty store cannot be distinguished")],
    });
    for (const filePath of [legacyPath, homeLegacyPath]) {
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("stale source JSON\n");
      await expect(fs.stat(`${filePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("accepts an empty July import run and preserves snapshot rollback", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    const vaultRoot = path.join(stateDir, "vault");
    const params = migrationParams({ stateDir, vaultRoot });
    await seedJulyImportRun(params, vaultRoot, "chatgpt-empty");
    await seedJulyImportRun(params, vaultRoot, "chatgpt-alpha", {
      created: "sources/legacy.md",
      updated: "sources/existing.md",
    });
    const snapshotPath = path.join(
      vaultRoot,
      ".openclaw-wiki",
      "import-runs",
      "chatgpt-alpha",
      "snapshots",
      "alpha.md",
    );
    const legacyPagePath = path.join(vaultRoot, "sources", "legacy.md");
    const existingPagePath = path.join(vaultRoot, "sources", "existing.md");
    const legacyPageContent = "# Edited July import page\n";
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.mkdir(path.dirname(legacyPagePath), { recursive: true });
    await fs.writeFile(snapshotPath, "previous page\n");
    await fs.writeFile(legacyPagePath, legacyPageContent);
    await fs.writeFile(existingPagePath, "imported replacement\n");
    const retiredPaths = ["chatgpt-empty", "chatgpt-alpha"].map((runId) =>
      resolveLegacyImportRunRecordPath(vaultRoot, runId),
    );
    for (const filePath of retiredPaths) {
      await fs.writeFile(filePath, "stale import JSON\n");
    }
    const migration = requireStateMigration("memory-wiki-import-runs-json-to-plugin-state");
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    const store = createMemoryWikiImportRunStateStore(params.context.openPluginStateKeyedStore);
    await expect(
      readMemoryWikiImportRunRecord(vaultRoot, "chatgpt-empty", store),
    ).resolves.toMatchObject({
      createdPaths: [],
      updatedPaths: [],
    });
    await expect(
      readMemoryWikiImportRunRecord(vaultRoot, "chatgpt-alpha", store),
    ).resolves.toMatchObject({
      createdPaths: [{ path: "sources/legacy.md" }],
      updatedPaths: [{ path: "sources/existing.md", snapshotPath: "snapshots/alpha.md" }],
    });
    configureMemoryWikiImportRunStateStore(store);
    configureMemoryWikiCompiledCacheStore(
      createMemoryWikiCompiledCacheStore(<T>(options: OpenBlobStoreOptions) =>
        createPluginBlobStoreForTests<T>("memory-wiki", options, params.env),
      ),
    );
    const rollback = await rollbackChatGptImportRun({
      config: resolveMemoryWikiConfig({ vault: { path: vaultRoot } }),
      runId: "chatgpt-alpha",
    });
    const preservedLegacy = expectDefined(
      rollback.preservedPaths.find((entry) => entry.path === "sources/legacy.md"),
      "preserved July import page",
    );
    await expect(
      fs.readFile(path.join(vaultRoot, preservedLegacy.recoveryPath), "utf8"),
    ).resolves.toBe(legacyPageContent);
    await expect(fs.readFile(existingPagePath, "utf8")).resolves.toBe("previous page\n");
    await expect(fs.readFile(snapshotPath, "utf8")).resolves.toBe("previous page\n");
    await expect(
      readMemoryWikiImportRunRecord(vaultRoot, "chatgpt-alpha", store),
    ).resolves.toMatchObject({
      rollbackStartedAt: expect.any(String),
      rollbackTargetsFinalizedAt: expect.any(String),
      rolledBackAt: expect.any(String),
    });
    for (const filePath of retiredPaths) {
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("stale import JSON\n");
      await expect(fs.stat(`${filePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("checks every configured agent vault without borrowing canonical state", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    const vaultRoot = path.join(stateDir, "vaults");
    const agentIds = ["support", "marketing"];
    const params = migrationParams({ stateDir, vaultRoot, agentIds });
    for (const agentId of agentIds) {
      const legacyPath = path.join(vaultRoot, agentId, ".openclaw-wiki", "source-sync.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(legacyPath, "retained source JSON\n");
    }
    await seedJulySourceSyncRow(params, path.join(vaultRoot, "support"));
    const migration = requireStateMigration("memory-wiki-source-sync-json-to-plugin-state");
    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining(path.join(vaultRoot, "marketing"))],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [expect.stringContaining(path.join(vaultRoot, "marketing"))],
    });
    for (const agentId of agentIds) {
      await expect(
        fs.readFile(path.join(vaultRoot, agentId, ".openclaw-wiki", "source-sync.json"), "utf8"),
      ).resolves.toBe("retained source JSON\n");
    }
  });
});
