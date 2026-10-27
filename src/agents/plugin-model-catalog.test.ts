import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fileLocks from "../infra/file-lock.js";
import * as sqliteQueries from "../infra/kysely-sync.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
} from "./auth-profiles/sqlite.js";
import { removePersistedPluginModelCatalogCredentials } from "./plugin-model-catalog-credentials.js";
import * as pluginModelCatalogExecution from "./plugin-model-catalog-execution.js";
import {
  decodePluginModelCatalogRelativePathPluginId,
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  migrateLegacyPluginModelCatalogs,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  repairPersistedPluginModelCatalogs,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";

const tempDirs: string[] = [];

function replaceCatalogs(catalogs: Record<string, string>) {
  return replacePersistedPluginModelCatalogs({
    agentDir,
    pluginCatalogWrites: Object.fromEntries(
      Object.entries(catalogs).map(([id, contents]) => [
        encodePluginModelCatalogRelativePath(id),
        contents,
      ]),
    ),
  });
}

function expectMigration(
  [migrated, ...warnings]: [number, ...string[]],
  options: Omit<Parameters<typeof migrateLegacyPluginModelCatalogs>[0], "agentDir"> = {},
) {
  expect(migrateLegacyPluginModelCatalogs({ agentDir, ...options })).toEqual({
    migrated,
    warnings: warnings.map((warning) => expect.stringContaining(warning)),
    issues: expect.any(Array),
  });
}

function expectCatalogs(catalogs: Record<string, string>, ids?: string[]) {
  expect(loadPersistedPluginModelCatalogsReadOnly(agentDir, ids)).toEqual(
    Object.entries(catalogs).map(([pluginId, contents]) => ({ pluginId, contents })),
  );
}

function withDatabase<T>(run: (database: DatabaseSync) => T, readOnly = false): T {
  using database = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"), { readOnly });
  return run(database);
}

function writeLegacy(contents: string, pluginId = "zai", suffix = "") {
  mkdirSync(join(agentDir, "plugins", pluginId), { recursive: true });
  const pathname = join(agentDir, encodePluginModelCatalogRelativePath(pluginId)) + suffix;
  writeFileSync(pathname, contents, "utf8");
  return pathname;
}

let agentDir: string;
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-model-catalog-"));
  tempDirs.push(agentDir);
});

function catalogContents(provider: string, apiKey?: string, malformed = false): string {
  return JSON.stringify({
    generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
    providers: {
      [provider]: {
        baseUrl: `https://${provider}.example/v1`,
        ...(malformed ? {} : { api: "openai-completions" }),
        ...(apiKey ? { apiKey } : {}),
        models: malformed
          ? [{ id: "missing-api" }]
          : [{ id: `${provider}-model`, name: `${provider} model` }],
      },
    },
  });
}

function updateCatalog(database: DatabaseSync, contents: string, pluginId = "zai", at?: number) {
  database
    .prepare(
      `UPDATE cache_entries SET value_json = ?${at === undefined ? "" : ", updated_at = ?"} WHERE scope = ? AND key = ?`,
    )
    .run(contents, ...(at === undefined ? [] : [at]), "plugin-model-catalog-v1", pluginId);
}

async function withPermissions(
  pathname: string,
  mode: number,
  restore: number,
  run: () => unknown,
) {
  chmodSync(pathname, mode);
  try {
    await run();
  } finally {
    chmodSync(pathname, restore);
  }
}

function readCatalogCacheRow(pluginId: string) {
  return withDatabase((database) => {
    const row = database
      .prepare("SELECT value_json, updated_at FROM cache_entries WHERE scope = ? AND key = ?")
      .get("plugin-model-catalog-v1", pluginId) as
      | { value_json: string; updated_at: number }
      | undefined;
    if (!row) {
      throw new Error(`Missing generated catalog cache row for ${pluginId}`);
    }
    return row;
  }, true);
}

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite-backed plugin model catalogs", () => {
  it("refuses malformed UTF-8 catalogs and continues importing healthy owners", () => {
    const source = writeLegacy(catalogContents("broken", "synthetic-key"), "broken");
    const corrupted = Buffer.from(catalogContents("broken", "synthetic-key"));
    corrupted[corrupted.indexOf("synthetic-key")] = 0xff;
    writeFileSync(source, corrupted);
    const valid = catalogContents("healthy");
    writeLegacy(valid, "healthy");

    expectMigration([1, "Could not read legacy provider catalog"]);

    expectCatalogs({ healthy: valid });
    expect(readFileSync(source)).toEqual(corrupted);
  });
  it("reads only named catalog rows without running migration or repair", async () => {
    const zai = catalogContents("zai");
    const anthropic = catalogContents("anthropic");
    await replaceCatalogs({ zai, anthropic });
    const legacyPath = writeLegacy(catalogContents("legacy"), "legacy");

    const reads = vi.spyOn(sqliteQueries, "executeSqliteQuerySync");
    try {
      expect(loadPersistedPluginModelCatalogsReadOnly(agentDir, ["missing", "zai", "zai"])).toEqual(
        [{ pluginId: "zai", contents: zai }],
      );
      const materializedRows = reads.mock.results.flatMap((result) =>
        result.type === "return" ? result.value.rows : [],
      );
      expect(materializedRows).toContainEqual({ key: "zai", value_json: zai });
      expect(materializedRows).not.toContainEqual({ key: "anthropic", value_json: anthropic });
      reads.mockClear();
      expect(loadPersistedPluginModelCatalogsReadOnly(agentDir, [])).toEqual([]);
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
    expectCatalogs({ anthropic, zai });
    expect(existsSync(legacyPath)).toBe(true);

    withDatabase((database) => {
      const insert = database.prepare(
        "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, 1)",
      );
      insert.run("plugin-model-catalog-v1", "λ🦞", "unicode catalog bytes");
      insert.run("plugin-model-catalog-v1", "\uFFFD", "replacement catalog bytes");
      insert.run("plugin-model-catalog-v1", "null", null);
    });
    const selections: { ids: string[]; expected: Record<string, string> }[] = [
      {
        ids: ["zai", "anthropic", "zai", "missing"],
        expected: { anthropic, zai },
      },
      { ids: ["missing", "null"], expected: {} },
      { ids: ["λ🦞"], expected: { "λ🦞": "unicode catalog bytes" } },
      {
        ids: ["\uFFFD"],
        expected: { "\uFFFD": "replacement catalog bytes" },
      },
      { ids: ["\uD800"], expected: {} },
      { ids: ["\uDC00"], expected: {} },
    ];
    for (const { ids, expected } of selections) {
      expectCatalogs(expected, ids);
    }
  });

  it("skips catalog mutation for unrelated credentials and observes a later matching publication", async () => {
    const relativePath = encodePluginModelCatalogRelativePath("zai");
    const unrelated = catalogContents("zai", "unrelated-provider-test-key");
    const removedKey = "removed-provider-test-key";
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: { [relativePath]: unrelated },
    });
    const candidate = {
      agentId: resolveAuthProfileDatabaseOwnerId(agentDir),
      databasePath: resolveAuthProfileDatabasePath(agentDir),
    };
    const removal = { candidates: [candidate], credentials: new Set([removedKey]) };
    const before = readCatalogCacheRow("zai");
    using worker = vi.spyOn(pluginModelCatalogExecution, "withPluginModelCatalogWorker");

    await removePersistedPluginModelCatalogCredentials(removal);
    expect(worker.mock.calls.length).toBe(0);
    expect(readCatalogCacheRow("zai")).toEqual(before);

    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: { [relativePath]: catalogContents("zai", removedKey) },
    });
    worker.mockClear();
    await removePersistedPluginModelCatalogCredentials(removal);
    expect(worker.mock.calls.length).toBe(1);
    expectCatalogs({ zai: catalogContents("zai") });
  });

  it("waits for an uncommitted catalog publication before skipping a clean catalog", async () => {
    const removedKey = "synthetic-uncommitted-credential";
    await replaceCatalogs({ zai: catalogContents("zai") });
    const databasePath = resolveAuthProfileDatabasePath(agentDir);
    const database = new DatabaseSync(databasePath);
    const started = createDeferredCore();
    const finish = createDeferredCore();
    const waiting = createDeferredCore();
    const publishing = pluginModelCatalogExecution.withPluginModelCatalogPublicationLocks(
      [databasePath],
      async () => {
        // Model a writer that validated auth before logout but has not committed its catalog.
        database.exec("BEGIN IMMEDIATE");
        try {
          updateCatalog(database, catalogContents("zai", removedKey));
          started.resolve();
          await finish.promise;
          database.exec("COMMIT");
        } finally {
          if (database.isTransaction) {
            database.exec("ROLLBACK");
          }
        }
      },
    );
    await started.promise;
    const lock = fileLocks.withFileLock;
    const locking = vi
      .spyOn(fileLocks, "withFileLock")
      .mockImplementation((pathname, options, run) => {
        waiting.resolve();
        return lock(pathname, options, run);
      });
    const removing = removePersistedPluginModelCatalogCredentials({
      candidates: [{ agentId: resolveAuthProfileDatabaseOwnerId(agentDir), databasePath }],
      credentials: new Set([removedKey]),
    });
    try {
      expect(
        await Promise.race([
          waiting.promise.then(() => "waiting"),
          removing.then(() => "completed"),
        ]),
      ).toBe("waiting");
      finish.resolve();
      await publishing;
      await removing;
      expectCatalogs({ zai: catalogContents("zai") });
    } finally {
      finish.resolve();
      await Promise.allSettled([publishing, removing]);
      locking.mockRestore();
      database.close();
    }
  });

  it("removes generated model rows whose API semantics cannot be derived", async () => {
    const relativePath = encodePluginModelCatalogRelativePath("nvidia");
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [relativePath]: JSON.stringify({
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: {
            nvidia: {
              baseUrl: "https://integrate.api.nvidia.com/v1",
              apiKey: "NVIDIA_API_KEY",
              models: [
                { id: "meta-llama/llama-3.3-70b-instruct" },
                { id: "model-owned-api", api: "openai-completions" },
              ],
            },
          },
        }),
      },
    });

    const persisted = loadPersistedPluginModelCatalogsReadOnly(agentDir);
    expect(persisted).toHaveLength(1);
    const catalog = JSON.parse(persisted[0]?.contents ?? "{}") as {
      providers?: {
        nvidia?: { api?: string; apiKey?: string; models?: Array<{ id?: string; api?: string }> };
      };
    };
    expect(catalog.providers?.nvidia).toMatchObject({
      apiKey: "NVIDIA_API_KEY",
      models: [{ id: "model-owned-api", api: "openai-completions" }],
    });
    expect(catalog.providers?.nvidia).not.toHaveProperty("api");
  });

  it("leaves malformed persisted catalogs and valid sibling timestamps unchanged", async () => {
    const validNvidia = catalogContents("nvidia", "NVIDIA_API_KEY");
    const validZai = catalogContents("zai", "ZAI_API_KEY");
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("nvidia")]: validNvidia,
        [encodePluginModelCatalogRelativePath("zai")]: validZai,
      },
    });
    const malformedNvidia = JSON.stringify({
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: {
        nvidia: {
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: "NVIDIA_API_KEY",
          models: [{ id: "meta-llama/llama-3.3-70b-instruct" }],
        },
      },
    });
    const database = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"));
    try {
      database
        .prepare(
          "UPDATE cache_entries SET value_json = ?, updated_at = 42 WHERE scope = ? AND key = ?",
        )
        .run(malformedNvidia, "plugin-model-catalog-v1", "nvidia");
    } finally {
      database.close();
    }

    const before = readCatalogCacheRow("nvidia");
    const sibling = readCatalogCacheRow("zai");
    for (let read = 0; read < 2; read += 1) {
      expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
        { pluginId: "nvidia", contents: malformedNvidia },
        { pluginId: "zai", contents: validZai },
      ]);
      expect(readCatalogCacheRow("nvidia")).toEqual(before);
      expect(readCatalogCacheRow("zai")).toEqual(sibling);
    }
  });

  it("does not overwrite a provider refresh when repair uses an older catalog snapshot", async () => {
    await replaceCatalogs({ nvidia: catalogContents("nvidia", "old-provider-test-key") });
    withDatabase((database) => {
      updateCatalog(
        database,
        catalogContents("nvidia", "old-provider-test-key", true),
        "nvidia",
        42,
      );
    });
    const oldSnapshot = loadPersistedPluginModelCatalogsReadOnly(agentDir);
    const refreshed = catalogContents("nvidia", "refreshed-provider-test-key");
    await replaceCatalogs({ nvidia: refreshed });
    const refreshedRow = readCatalogCacheRow("nvidia");

    expect(repairPersistedPluginModelCatalogs({ agentDir, catalogs: oldSnapshot })).toEqual([]);
    expectCatalogs({ nvidia: refreshed });
    expect(readCatalogCacheRow("nvidia")).toEqual(refreshedRow);
  });

  it("does not create an agent database for a read-only cache miss", () => {
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([]);
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    expect(existsSync(join(agentDir, "plugins"))).toBe(false);
  });

  it("does not create agent state when an empty catalog is already current", async () => {
    expect(await replaceCatalogs({})).toEqual({ changed: false, catalogs: [] });
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    expect(existsSync(join(agentDir, "plugins"))).toBe(false);
  });

  it("retires migrated credential recovery data after verifying the canonical catalog", () => {
    const contents = catalogContents("zai", "retired-released-provider-test-key");
    const sourcePath = writeLegacy(contents);

    expectMigration([1]);
    expectCatalogs({ zai: contents });
    expect(existsSync(sourcePath)).toBe(false);
    expectMigration([0]);
    expectCatalogs({ zai: contents });
    using database = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"), { readOnly: true });
    expect(
      database
        .prepare("SELECT value_json FROM cache_entries WHERE scope = ?")
        .all("plugin-model-catalog-migration-v1"),
    ).toEqual([]);
  });

  it("protects migration recovery credentials when a plugin directory cannot be inspected", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const contents = catalogContents("zai", "protected-released-provider-test-key");
    const pluginDir = join(agentDir, "plugins", "zai");
    await replaceCatalogs({ zai: contents });
    withDatabase((database) => {
      database
        .prepare(
          "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
        )
        .run("plugin-model-catalog-migration-v1", "zai", contents, Date.now());
    });
    writeLegacy(contents);
    await withPermissions(pluginDir, 0o000, 0o700, () => {
      expectMigration([0, "Could not inspect legacy provider catalogs"]);
      withDatabase((verified) => {
        expect(
          verified
            .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
            .all("plugin-model-catalog-migration-v1", "zai"),
        ).toEqual([{ value_json: contents }]);
      }, true);
    });

    expectCatalogs({ zai: contents });
  });

  it("detects a released catalog that appears after an earlier empty scan", () => {
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([]);

    const contents = catalogContents("zai", "late-released-provider-test-key");
    const sourcePath = writeLegacy(contents);

    migrateLegacyPluginModelCatalogs({ agentDir });
    expectCatalogs({ zai: contents });
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("migrates a later provider catalog after an earlier migration completed", () => {
    const zai = catalogContents("zai", "released-zai-provider-test-key");
    const zaiPath = writeLegacy(zai);

    migrateLegacyPluginModelCatalogs({ agentDir });
    expectCatalogs({ zai });

    const anthropic = catalogContents("anthropic", "late-anthropic-provider-test-key");
    const anthropicPath = writeLegacy(anthropic, "anthropic");

    migrateLegacyPluginModelCatalogs({ agentDir });
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
      { pluginId: "anthropic", contents: anthropic },
      { pluginId: "zai", contents: zai },
    ]);
    expect(existsSync(zaiPath)).toBe(false);
    expect(existsSync(anthropicPath)).toBe(false);
  });

  it("migrates a changed later sidecar for an already migrated provider", () => {
    const original = catalogContents("zai", "first-released-provider-test-key");
    const later = catalogContents("zai", "later-released-provider-test-key");
    const sourcePath = writeLegacy(original);
    migrateLegacyPluginModelCatalogs({ agentDir });
    expectCatalogs({ zai: original });

    writeFileSync(sourcePath, later, "utf8");

    migrateLegacyPluginModelCatalogs({ agentDir });
    expectCatalogs({ zai: later });
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("preserves released credentials and unrelated regenerated SQLite catalogs", async () => {
    const regenerated = catalogContents("zai", "regenerated-provider-test-key");
    const released = catalogContents("zai", "released-provider-test-key");
    const unrelated = catalogContents("anthropic", "unrelated-provider-test-key");
    await replaceCatalogs({ zai: regenerated, anthropic: unrelated });
    const sourcePath = writeLegacy(released);

    expectMigration([1], { expectedContents: new Map([["zai", released]]) });
    expectCatalogs({ anthropic: unrelated, zai: released });
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("recovers a released sidecar that appears after a catalog replacement was planned", async () => {
    const released = catalogContents("zai", "released-provider-test-key");
    const preplanned = catalogContents("zai", "preplanned-provider-test-key");
    const sourcePath = writeLegacy(released);

    await replaceCatalogs({ zai: preplanned });

    expect(existsSync(sourcePath)).toBe(true);
    migrateLegacyPluginModelCatalogs({ agentDir });
    expectCatalogs({ zai: released });
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("accepts a sidecar already migrated and removed by another process", async () => {
    const contents = catalogContents("zai", "concurrently-migrated-provider-test-key");
    await replaceCatalogs({ zai: contents });

    expectMigration([0], { expectedContents: new Map([["zai", contents]]) });
    expectCatalogs({ zai: contents });
  });

  it("keeps committed catalogs available when a released sidecar cannot be removed", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const contents = catalogContents("zai", "released-provider-test-key");
    const pluginDir = join(agentDir, "plugins", "zai");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(sourcePath, contents, "utf8");
    chmodSync(pluginDir, 0o500);

    try {
      expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
        migrated: 0,
        warnings: [expect.stringContaining("Could not remove migrated legacy provider catalog")],
        issues: [expect.objectContaining({ kind: "cleanup-failed", pathname: sourcePath })],
      });
      expectCatalogs({ zai: contents });
      expect(existsSync(sourcePath)).toBe(true);

      const refreshed = catalogContents("zai", "refreshed-provider-test-key");
      await replaceCatalogs({ zai: refreshed });
      expectCatalogs({ zai: refreshed });
      expect(existsSync(sourcePath)).toBe(true);
    } finally {
      chmodSync(pluginDir, 0o700);
    }
  });

  it("never deletes retained migrated credentials after a newer catalog replaces them", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const original = catalogContents("zai", "released-provider-test-key");
    const refreshed = catalogContents("zai", "refreshed-provider-test-key");
    const pluginDir = join(agentDir, "plugins", "zai");
    const sourcePath = writeLegacy(original);
    await withPermissions(pluginDir, 0o500, 0o700, async () => {
      expectMigration([0, "Could not remove migrated legacy provider catalog"]);
      await replaceCatalogs({ zai: refreshed });
    });

    expectMigration([0, "Left superseded legacy provider catalog in place"]);
    expectCatalogs({ zai: refreshed });
    expect(existsSync(sourcePath)).toBe(true);
  });

  it("atomically preserves a provider catalog refreshed immediately before migration claims it", () => {
    const original = catalogContents("zai", "released-provider-test-key");
    const refreshed = catalogContents("zai", "concurrently-refreshed-provider-test-key");
    const sourcePath = writeLegacy(original);

    expectMigration([0, "Left changed legacy provider catalog in place"], {
      beforeLegacyCatalogClaim: (pathname) => writeFileSync(pathname, refreshed, "utf8"),
    });
    expect(readFileSync(sourcePath, "utf8")).toBe(refreshed);
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([]);
    migrateLegacyPluginModelCatalogs({ agentDir });
    expectCatalogs({ zai: refreshed });
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("never publishes a stale scan after another process removes the legacy source", async () => {
    const original = catalogContents("zai", "stale-released-provider-test-key");
    const refreshed = catalogContents("zai", "current-regenerated-provider-test-key");
    writeLegacy(original);
    await replaceCatalogs({ zai: original });
    await closeOpenClawAgentDatabasesAsync(agentDir);

    expectMigration([0, "Legacy provider catalog was claimed before its migration was committed"], {
      beforeLegacyCatalogClaim: (pathname) => {
        // Doctor's claim hook is synchronous; model the other process's committed refresh.
        withDatabase((database) => updateCatalog(database, refreshed));
        unlinkSync(pathname);
      },
    });
    expectCatalogs({ zai: refreshed });
  });

  it("retains an in-flight migration claim until a later explicit repair", () => {
    const contents = catalogContents("zai", "in-flight-released-provider-test-key");
    const sourcePath = writeLegacy(contents);
    const claimPath = `${sourcePath}.doctor-importing-concurrent-process`;

    expectMigration([0, "Legacy provider catalog was claimed before its migration was committed"], {
      beforeLegacyCatalogClaim: (pathname) => renameSync(pathname, claimPath),
    });
    expect(existsSync(claimPath)).toBe(true);
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([]);
    migrateLegacyPluginModelCatalogs({ agentDir });
    expectCatalogs({ zai: contents });
    expect(existsSync(claimPath)).toBe(false);
  });

  it("never migrates a provider while one retained claim cannot be read", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const retained = catalogContents("zai", "unreadable-retained-provider-test-key");
    const refreshed = catalogContents("zai", "current-canonical-provider-test-key");
    const claimPath = writeLegacy(retained, "zai", ".doctor-importing-previous-process");
    const sourcePath = writeLegacy(refreshed);
    await withPermissions(claimPath, 0o000, 0o600, () => {
      expectMigration([0, "Could not read legacy provider catalog"]);
      expect(existsSync(claimPath)).toBe(true);
      expect(existsSync(sourcePath)).toBe(true);
      expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    });

    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([]);
    migrateLegacyPluginModelCatalogs({ agentDir });
    expectCatalogs({ zai: refreshed });
  });

  it("recovers a retained claim before applying a newer canonical provider catalog", () => {
    const retained = catalogContents("zai", "interrupted-released-provider-test-key");
    const refreshed = catalogContents("zai", "concurrently-refreshed-provider-test-key");
    const claimPath = writeLegacy(retained, "zai", ".doctor-importing-previous-process");
    const sourcePath = writeLegacy(refreshed);

    expectMigration([2]);
    expectCatalogs({ zai: refreshed });
    expect(existsSync(claimPath)).toBe(false);
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("preserves conflicting retained claims without guessing which credential is newer", () => {
    const olderPath = writeLegacy(
      catalogContents("zai", "older-provider-test-key"),
      "zai",
      ".doctor-importing-zzz",
    );
    const newerPath = writeLegacy(
      catalogContents("zai", "newer-provider-test-key"),
      "zai",
      ".doctor-importing-aaa",
    );

    expectMigration([0, "Conflicting retained legacy provider catalogs"]);
    expect(existsSync(olderPath)).toBe(true);
    expect(existsSync(newerPath)).toBe(true);
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
  });

  it("does not let an unreadable sidecar hide other committed provider catalogs", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const anthropic = catalogContents("anthropic", "available-anthropic-provider-test-key");
    await replaceCatalogs({ anthropic });
    const sourcePath = writeLegacy(catalogContents("zai", "unreadable-provider-test-key"));
    await withPermissions(sourcePath, 0o000, 0o600, () => {
      expectMigration([0, "Could not read legacy provider catalog"]);
      expectCatalogs({ anthropic });
    });
  });

  it("never migrates or deletes an unmarked user-authored catalog", () => {
    const contents = JSON.stringify({ providers: { zai: { apiKey: "user-authored-test-key" } } });
    const sourcePath = writeLegacy(contents);

    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([]);
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    expect(existsSync(sourcePath)).toBe(true);
  });

  it("preserves SQLite catalog key order in committed receipts", async () => {
    const contents = catalogContents("fixture");
    const ids = ["anthropic", "zai", "\uE000", "𐀀"];
    const writes = Object.fromEntries(ids.toReversed().map((id) => [id, contents]));
    const catalogs = ids.map((pluginId) => ({ pluginId, contents }));
    expect(await replaceCatalogs(writes)).toEqual({
      changed: true,
      catalogs,
    });
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual(catalogs);
    expect(await replaceCatalogs(writes)).toEqual({
      changed: false,
      catalogs,
    });
  });

  it("recognizes unchanged payloads and atomically removes stale provider rows", async () => {
    const zai = catalogContents("zai");
    const catalogRows = (prefix: string) =>
      Object.fromEntries(
        Array.from({ length: 70 }, (_, index) => [
          `${prefix}-${index}`,
          catalogContents(`${prefix}-${index}`),
        ]),
      );
    const both = { zai, ...catalogRows("stale") };

    expect(await replaceCatalogs(both)).toMatchObject({ changed: true });
    expect(await replaceCatalogs(both)).toMatchObject({ changed: false });
    const unchanged = readCatalogCacheRow("zai");
    const refreshed = catalogContents("fresh");
    const next: Record<string, string> = { zai, ...catalogRows("new") };
    // Exercise both row and payload batch boundaries without changing JSON semantics.
    next["new-35"] += " ".repeat(1024 * 1024);
    expect(await replaceCatalogs(next)).toMatchObject({ changed: true });
    expect(readCatalogCacheRow("zai")).toEqual(unchanged);
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toHaveLength(71);
    expect(readCatalogCacheRow("new-35").value_json).toBe(next["new-35"]);
    expect(await replaceCatalogs({ zai: refreshed })).toEqual({
      changed: true,
      catalogs: [{ pluginId: "zai", contents: refreshed }],
    });
    expectCatalogs({ zai: refreshed });
  });

  it("rejects invalid planning keys without deleting the committed catalog", async () => {
    const zai = catalogContents("zai");
    await replaceCatalogs({ zai });

    await expect(
      replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: { "../catalog.json": catalogContents("anthropic") },
      }),
    ).rejects.toThrow("Invalid generated plugin model catalog key: ../catalog.json");
    expectCatalogs({ zai });
  });

  it("round-trips encoded plugin ownership without filesystem discovery", () => {
    const pluginId = "provider/with spaces";
    const key = encodePluginModelCatalogRelativePath(pluginId);

    expect(key).toBe("plugins/provider%2Fwith%20spaces/catalog.json");
    expect(decodePluginModelCatalogRelativePathPluginId(key)).toBe(pluginId);
    expect(decodePluginModelCatalogRelativePathPluginId("../catalog.json")).toBeUndefined();
  });
});
