import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
} from "./src/import-runs-state.js";
import { createMemoryWikiSourceSyncStateStore } from "./src/source-sync-state.js";
import { createMemoryWikiTestHarness } from "./src/test-helpers.js";

function requireStateMigration(id: string) {
  return expectDefined(
    stateMigrations.find((migration) => migration.id === id),
    `Memory Wiki state migration ${id}`,
  );
}

const tempDirs = createMemoryWikiTestHarness();

function migrationParams(params: { stateDir: string; vaultRoot: string; agentIds?: string[] }) {
  const env = { ...process.env, HOME: params.stateDir, OPENCLAW_STATE_DIR: params.stateDir };
  const vault = {
    path: params.vaultRoot,
    ...(params.agentIds ? { scope: "agent" as const } : {}),
  };
  const config: OpenClawConfig = {
    ...(params.agentIds
      ? { agents: { entries: Object.fromEntries(params.agentIds.map((id) => [id, {}])) } }
      : {}),
    plugins: { entries: { "memory-wiki": { config: { vault } } } },
  };
  return {
    config,
    env,
    stateDir: params.stateDir,
    oauthDir: path.join(params.stateDir, "credentials"),
    context: {
      openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
    },
  };
}

async function writeFiles(files: Record<string, string>) {
  for (const [filePath, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
}

async function expectMissing(filePath: string) {
  await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectRetained(filePath: string, content: string) {
  await expectContents(filePath, content);
  await expectMissing(`${filePath}.migrated`);
}

async function expectContents(filePath: string, content: string) {
  await expect(fs.readFile(filePath, "utf8")).resolves.toBe(content);
}

// Row keys and values are the v2026.7.1-beta.1 writer's format, independent of current codecs.
function julyKey(...parts: (string | number)[]): string {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

type Params = ReturnType<typeof migrationParams>;

async function seedJulySourceSyncRow(params: Params, vaultRoot: string) {
  const syncKey = "alpha";
  const vaultRootKey = julyKey(path.resolve(vaultRoot)).slice(0, 32);
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
  await store.register(julyKey(vaultRootKey, syncKey), { ...entry, vaultRootKey, syncKey });
  // July's namespace options belong to the old process; current readers choose theirs on reopen.
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  return entry;
}

async function seedJulyImportRun(
  params: Params,
  vaultRoot: string,
  runId: string,
  paths: { created?: string; updated?: string } = {},
): Promise<void> {
  const vaultRootKey = julyKey(path.resolve(vaultRoot)).slice(0, 32);
  const store = params.context.openPluginStateKeyedStore({
    namespace: "import-runs",
    maxEntries: 20_000,
  });
  await store.register(julyKey(vaultRootKey, "meta", runId), {
    version: 1,
    runId,
    importType: "chatgpt",
    exportPath: "/tmp/chatgpt",
    sourcePath: "/tmp/chatgpt/conversations.json",
    appliedAt: "2026-07-01T12:00:00.000Z",
    conversationCount: 2,
    createdCount: paths.created ? 1 : 0,
    updatedCount: paths.updated ? 1 : 0,
    skippedCount: 0,
    kind: "meta",
    vaultRootKey,
  });
  for (const [kind, pagePath] of [
    ["created-path", paths.created],
    ["updated-path", paths.updated],
  ] as const) {
    if (!pagePath) {
      continue;
    }
    await store.register(julyKey(vaultRootKey, runId, kind, 0, pagePath), {
      kind,
      vaultRootKey,
      runId,
      index: 0,
      path: pagePath,
      ...(kind === "updated-path" ? { snapshotPath: "snapshots/alpha.md" } : {}),
    });
  }
}

describe("memory-wiki Doctor state compatibility", () => {
  let stateDir: string;
  let vaultRoot: string;
  let params: Params;
  const cleanup = requireStateMigration("memory-wiki-compiled-cache-file-cleanup");
  const wikiPath = (...parts: string[]) => path.join(vaultRoot, ".openclaw-wiki", ...parts);
  const sourceStore = () =>
    createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
  const importStore = () =>
    createMemoryWikiImportRunStateStore(params.context.openPluginStateKeyedStore);
  const sourceMigration = requireStateMigration("memory-wiki-source-sync-json-to-plugin-state");
  const importMigration = requireStateMigration("memory-wiki-import-runs-json-to-plugin-state");

  async function expectMigration(
    migration: typeof cleanup,
    changes: string[] = [],
    warnings: string[] = [],
  ) {
    const preview = [...changes, ...warnings];
    await expect(migration.detectLegacyState(params)).resolves.toEqual(
      preview.length ? { preview } : null,
    );
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({ changes, warnings });
  }

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    vaultRoot = path.join(stateDir, "vault");
    params = migrationParams({ stateDir, vaultRoot });
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    configureMemoryWikiCompiledCacheStore(undefined);
    configureMemoryWikiImportRunStateStore(undefined);
    resetPluginBlobStoreForTests();
    resetPluginStateStoreForTests();
  });

  it("backs up and removes only rebuildable cache files, leaving absent vaults untouched", async () => {
    const homeDir = await tempDirs.createTempDir("memory-wiki-doctor-home-");
    vaultRoot = path.join(stateDir, "wiki", "main");
    params.config = { plugins: { entries: { "memory-wiki": { config: {} } } } };
    params.env = { ...params.env, HOME: homeDir };
    const legacyPaths = [wikiPath("cache/agent-digest.json"), wikiPath("cache/claims.jsonl")];
    const homeCache = path.join(
      homeDir,
      ".openclaw/wiki/main/.openclaw-wiki/cache/agent-digest.json",
    );
    expect(stateMigrations.map((migration) => migration.collectBackupResources?.(params))).toEqual([
      legacyPaths.map((filePath) => ({ path: filePath, kind: "file" })),
      [],
      [],
    ]);
    await expectMigration(cleanup);
    await expectMissing(vaultRoot);
    await writeFiles(
      Object.fromEntries([...legacyPaths, homeCache].map((filePath) => [filePath, "stale\n"])),
    );
    await expectMigration(
      cleanup,
      legacyPaths.map((filePath) => expect.stringContaining(filePath)),
    );
    await Promise.all(legacyPaths.map(expectMissing));
    await expectContents(homeCache, "stale\n");
  });

  it("does not follow a symlinked legacy cache directory", async () => {
    const externalCacheDir = path.join(stateDir, "external-cache");
    const externalCachePath = path.join(externalCacheDir, "agent-digest.json");
    await fs.mkdir(wikiPath(), { recursive: true });
    await writeFiles({ [externalCachePath]: "private\n" });
    await fs.symlink(externalCacheDir, wikiPath("cache"));
    await expectMigration(cleanup);
    await expectContents(externalCachePath, "private\n");
  });

  it.each(["source-sync", "import-runs"] as const)(
    "refuses retired %s JSON without reading, importing, or archiving it",
    async (source) => {
      const otherVault = path.join(stateDir, "other-vault");
      const legacyPath =
        source === "source-sync"
          ? wikiPath("source-sync.json")
          : wikiPath("import-runs/chatgpt-alpha.json");
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
      const warning = expect.stringContaining(`JSON state are no longer migrated (${legacyPath})`);
      for (const bytes of [
        JSON.stringify(legacyValue),
        "retired malformed JSON must survive unchanged\n",
      ]) {
        await writeFiles({ [legacyPath]: bytes });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await expectMigration(migration, [], [warning]);
        }
        await expectRetained(legacyPath, bytes);
        await expect(sourceStore().read(vaultRoot)).resolves.toEqual({ version: 1, entries: {} });
        await expect(importStore().list(vaultRoot)).resolves.toEqual([]);
      }
    },
  );

  it("preserves July source rows and diagnoses empty agent stores without borrowing state", async () => {
    const agents = ["support", "marketing"];
    params = migrationParams({ stateDir, vaultRoot, agentIds: agents });
    const support = path.join(vaultRoot, "support");
    const marketing = path.join(vaultRoot, "marketing");
    const legacyPaths = agents.map((id) =>
      path.join(vaultRoot, id, ".openclaw-wiki/source-sync.json"),
    );
    await writeFiles(Object.fromEntries(legacyPaths.map((file) => [file, "stale source JSON\n"])));
    const entry = await seedJulySourceSyncRow(params, support);
    const store = sourceStore();
    await expectMigration(sourceMigration, [], [expect.stringContaining(marketing)]);
    await expect(store.read(support)).resolves.toEqual({
      version: 1,
      entries: { alpha: entry },
    });
    await store.write(marketing, { version: 1, entries: { alpha: entry } });
    await expectMigration(sourceMigration);
    await store.write(support, { version: 1, entries: {} });
    await expectMigration(
      sourceMigration,
      [],
      [expect.stringContaining("an empty store cannot be distinguished")],
    );
    for (const filePath of legacyPaths) {
      await expectRetained(filePath, "stale source JSON\n");
    }
  });

  it("accepts an empty July import run and preserves snapshot rollback", async () => {
    await seedJulyImportRun(params, vaultRoot, "chatgpt-empty");
    await seedJulyImportRun(params, vaultRoot, "chatgpt-alpha", {
      created: "sources/legacy.md",
      updated: "sources/existing.md",
    });
    const snapshotPath = wikiPath("import-runs/chatgpt-alpha/snapshots/alpha.md");
    const legacyPagePath = path.join(vaultRoot, "sources", "legacy.md");
    const existingPagePath = path.join(vaultRoot, "sources", "existing.md");
    const legacyPageContent = "# Edited July import page\n";
    await writeFiles({
      [snapshotPath]: "previous page\n",
      [legacyPagePath]: legacyPageContent,
      [existingPagePath]: "imported replacement\n",
    });
    const retiredPaths = ["chatgpt-empty", "chatgpt-alpha"].map((id) =>
      wikiPath(`import-runs/${id}.json`),
    );
    for (const filePath of retiredPaths) {
      await fs.writeFile(filePath, "stale import JSON\n");
    }
    await expectMigration(importMigration);
    const store = importStore();
    await expect(store.read(vaultRoot, "chatgpt-empty")).resolves.toMatchObject({
      createdPaths: [],
      updatedPaths: [],
    });
    await expect(store.read(vaultRoot, "chatgpt-alpha")).resolves.toMatchObject({
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
    await expectContents(path.join(vaultRoot, preservedLegacy.recoveryPath), legacyPageContent);
    await expectContents(existingPagePath, "previous page\n");
    await expectContents(snapshotPath, "previous page\n");
    await expect(store.read(vaultRoot, "chatgpt-alpha")).resolves.toMatchObject({
      rollbackStartedAt: expect.any(String),
      rollbackTargetsFinalizedAt: expect.any(String),
      rolledBackAt: expect.any(String),
    });
    for (const filePath of retiredPaths) {
      await expectRetained(filePath, "stale import JSON\n");
    }
  });
});
