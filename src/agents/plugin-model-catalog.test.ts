// Generated plugin catalogs reuse the existing per-agent SQLite cache.
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
import { afterEach, describe, expect, it, vi } from "vitest";
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

function createAgentDir(): string {
  const agentDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-model-catalog-"));
  tempDirs.push(agentDir);
  return agentDir;
}

function catalogContents(provider: string, apiKey?: string): string {
  return JSON.stringify({
    generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
    providers: {
      [provider]: {
        baseUrl: `https://${provider}.example/v1`,
        api: "openai-completions",
        ...(apiKey ? { apiKey } : {}),
        models: [{ id: `${provider}-model`, name: `${provider} model` }],
      },
    },
  });
}

function readCatalogCacheRow(
  agentDir: string,
  pluginId: string,
): {
  value_json: string;
  updated_at: number;
} {
  const database = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT value_json, updated_at FROM cache_entries WHERE scope = ? AND key = ?")
      .get("plugin-model-catalog-v1", pluginId) as
      | { value_json: string; updated_at: number }
      | undefined;
    if (!row) {
      throw new Error(`Missing generated catalog cache row for ${pluginId}`);
    }
    return row;
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  for (const agentDir of tempDirs.splice(0)) {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

describe("SQLite-backed plugin model catalogs", () => {
  it("reads only named catalog rows without running migration or repair", async () => {
    const agentDir = createAgentDir();
    const zai = catalogContents("zai");
    const anthropic = catalogContents("anthropic");
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: zai,
        [encodePluginModelCatalogRelativePath("anthropic")]: anthropic,
      },
    });
    const legacyPath = join(agentDir, encodePluginModelCatalogRelativePath("legacy"));
    mkdirSync(join(agentDir, "plugins", "legacy"), { recursive: true });
    writeFileSync(legacyPath, catalogContents("legacy"), "utf8");

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
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
      { pluginId: "anthropic", contents: anthropic },
      { pluginId: "zai", contents: zai },
    ]);
    expect(existsSync(legacyPath)).toBe(true);

    const database = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"));
    try {
      const insert = database.prepare(
        "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, 1)",
      );
      insert.run("plugin-model-catalog-v1", "λ🦞", "unicode catalog bytes");
      insert.run("plugin-model-catalog-v1", "\uFFFD", "replacement catalog bytes");
      insert.run("plugin-model-catalog-v1", "null", null);
    } finally {
      database.close();
    }
    for (const { ids, expected } of [
      {
        ids: ["zai", "anthropic", "zai", "missing"],
        expected: [
          { pluginId: "anthropic", contents: anthropic },
          { pluginId: "zai", contents: zai },
        ],
      },
      { ids: ["missing", "null"], expected: [] },
      { ids: ["λ🦞"], expected: [{ pluginId: "λ🦞", contents: "unicode catalog bytes" }] },
      {
        ids: ["\uFFFD"],
        expected: [{ pluginId: "\uFFFD", contents: "replacement catalog bytes" }],
      },
      { ids: ["\uD800"], expected: [] },
      { ids: ["\uDC00"], expected: [] },
    ]) {
      expect(loadPersistedPluginModelCatalogsReadOnly(agentDir, ids)).toEqual(expected);
    }
  });

  it("waits for an uncommitted catalog publication before skipping a clean catalog", async () => {
    const agentDir = createAgentDir();
    const removedKey = "synthetic-uncommitted-credential";
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: catalogContents("zai"),
      },
    });
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
          database
            .prepare("UPDATE cache_entries SET value_json = ? WHERE scope = ? AND key = ?")
            .run(catalogContents("zai", removedKey), "plugin-model-catalog-v1", "zai");
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
      expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
        { pluginId: "zai", contents: catalogContents("zai") },
      ]);
    } finally {
      finish.resolve();
      await Promise.allSettled([publishing, removing]);
      locking.mockRestore();
      database.close();
    }
  });

  it("does not overwrite a provider refresh when repair uses an older catalog snapshot", async () => {
    const agentDir = createAgentDir();
    const relativePath = encodePluginModelCatalogRelativePath("nvidia");
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: { [relativePath]: catalogContents("nvidia", "old-provider-test-key") },
    });
    const malformed = JSON.stringify({
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: {
        nvidia: {
          baseUrl: "https://nvidia.example/v1",
          apiKey: "old-provider-test-key",
          models: [{ id: "missing-api" }],
        },
      },
    });
    const database = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"));
    try {
      database
        .prepare(
          "UPDATE cache_entries SET value_json = ?, updated_at = 42 WHERE scope = ? AND key = ?",
        )
        .run(malformed, "plugin-model-catalog-v1", "nvidia");
    } finally {
      database.close();
    }
    const oldSnapshot = loadPersistedPluginModelCatalogsReadOnly(agentDir);
    const refreshed = catalogContents("nvidia", "refreshed-provider-test-key");
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: { [relativePath]: refreshed },
    });
    const refreshedRow = readCatalogCacheRow(agentDir, "nvidia");

    expect(repairPersistedPluginModelCatalogs({ agentDir, catalogs: oldSnapshot })).toEqual([]);
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
      { pluginId: "nvidia", contents: refreshed },
    ]);
    expect(readCatalogCacheRow(agentDir, "nvidia")).toEqual(refreshedRow);
  });

  it("does not create agent state when an empty catalog is already current", async () => {
    const agentDir = createAgentDir();

    expect(await replacePersistedPluginModelCatalogs({ agentDir, pluginCatalogWrites: {} })).toBe(
      false,
    );
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    expect(existsSync(join(agentDir, "plugins"))).toBe(false);
  });

  it("protects migration recovery credentials when a plugin directory cannot be inspected", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const agentDir = createAgentDir();
    const contents = catalogContents("zai", "protected-released-provider-test-key");
    const pluginDir = join(agentDir, "plugins", "zai");
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: contents,
      },
    });
    const database = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"));
    try {
      database
        .prepare(
          "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
        )
        .run("plugin-model-catalog-migration-v1", "zai", contents, Date.now());
    } finally {
      database.close();
    }
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "catalog.json"), contents, "utf8");
    chmodSync(pluginDir, 0o000);

    try {
      expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
        detected: 0,
        migrated: 0,
        warnings: [expect.stringContaining("Could not inspect legacy provider catalogs")],
      });
      const verified = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          verified
            .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
            .all("plugin-model-catalog-migration-v1", "zai"),
        ).toEqual([{ value_json: contents }]);
      } finally {
        verified.close();
      }
    } finally {
      chmodSync(pluginDir, 0o700);
    }

    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
      { pluginId: "zai", contents },
    ]);
  });

  it("preserves released credentials and unrelated regenerated SQLite catalogs", async () => {
    const agentDir = createAgentDir();
    const regenerated = catalogContents("zai", "regenerated-provider-test-key");
    const released = catalogContents("zai", "released-provider-test-key");
    const unrelated = catalogContents("anthropic", "unrelated-provider-test-key");
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: regenerated,
        [encodePluginModelCatalogRelativePath("anthropic")]: unrelated,
      },
    });
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(sourcePath, released, "utf8");

    expect(
      migrateLegacyPluginModelCatalogs({
        agentDir,
        expectedContents: new Map([["zai", released]]),
      }),
    ).toEqual({ detected: 1, migrated: 1, warnings: [] });
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
      { pluginId: "anthropic", contents: unrelated },
      { pluginId: "zai", contents: released },
    ]);
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("accepts a sidecar already migrated and removed by another process", async () => {
    const agentDir = createAgentDir();
    const contents = catalogContents("zai", "concurrently-migrated-provider-test-key");
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: contents,
      },
    });

    expect(
      migrateLegacyPluginModelCatalogs({
        agentDir,
        expectedContents: new Map([["zai", contents]]),
      }),
    ).toEqual({ detected: 0, migrated: 0, warnings: [] });
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
      { pluginId: "zai", contents },
    ]);
  });

  it("never deletes retained migrated credentials after a newer catalog replaces them", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const agentDir = createAgentDir();
    const original = catalogContents("zai", "released-provider-test-key");
    const refreshed = catalogContents("zai", "refreshed-provider-test-key");
    const pluginDir = join(agentDir, "plugins", "zai");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(sourcePath, original, "utf8");
    chmodSync(pluginDir, 0o500);

    try {
      expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
        detected: 1,
        migrated: 0,
        warnings: [expect.stringContaining("Could not remove migrated legacy provider catalog")],
      });
      await replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath("zai")]: refreshed,
        },
      });
    } finally {
      chmodSync(pluginDir, 0o700);
    }

    expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
      detected: 1,
      migrated: 0,
      warnings: [expect.stringContaining("Left superseded legacy provider catalog in place")],
    });
    expect(existsSync(sourcePath)).toBe(true);
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
      { pluginId: "zai", contents: refreshed },
    ]);
    expect(existsSync(sourcePath)).toBe(true);
  });

  it("atomically preserves a provider catalog refreshed immediately before migration claims it", () => {
    const agentDir = createAgentDir();
    const original = catalogContents("zai", "released-provider-test-key");
    const refreshed = catalogContents("zai", "concurrently-refreshed-provider-test-key");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(sourcePath, original, "utf8");

    expect(
      migrateLegacyPluginModelCatalogs({
        agentDir,
        beforeLegacyCatalogClaim: (pathname) => {
          writeFileSync(pathname, refreshed, "utf8");
        },
      }),
    ).toEqual({
      detected: 1,
      migrated: 0,
      warnings: [expect.stringContaining("Left changed legacy provider catalog in place")],
    });
    expect(readFileSync(sourcePath, "utf8")).toBe(refreshed);
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([]);
    migrateLegacyPluginModelCatalogs({ agentDir });
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
      { pluginId: "zai", contents: refreshed },
    ]);
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("never publishes a stale scan after another process removes the legacy source", async () => {
    const agentDir = createAgentDir();
    const original = catalogContents("zai", "stale-released-provider-test-key");
    const refreshed = catalogContents("zai", "current-regenerated-provider-test-key");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(sourcePath, original, "utf8");
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: original,
      },
    });
    await closeOpenClawAgentDatabasesAsync(agentDir);

    expect(
      migrateLegacyPluginModelCatalogs({
        agentDir,
        beforeLegacyCatalogClaim: (pathname) => {
          // Doctor's claim hook is synchronous; model the other process's committed refresh.
          const database = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"));
          try {
            database
              .prepare("UPDATE cache_entries SET value_json = ? WHERE scope = ? AND key = ?")
              .run(refreshed, "plugin-model-catalog-v1", "zai");
          } finally {
            database.close();
          }
          unlinkSync(pathname);
        },
      }),
    ).toEqual({
      detected: 1,
      migrated: 0,
      warnings: [
        expect.stringContaining(
          "Legacy provider catalog was claimed before its migration was committed",
        ),
      ],
    });
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
      { pluginId: "zai", contents: refreshed },
    ]);
  });

  it("retains an in-flight migration claim until a later explicit repair", () => {
    const agentDir = createAgentDir();
    const contents = catalogContents("zai", "in-flight-released-provider-test-key");
    const sourcePath = join(agentDir, encodePluginModelCatalogRelativePath("zai"));
    const claimPath = `${sourcePath}.doctor-importing-concurrent-process`;
    mkdirSync(join(agentDir, "plugins", "zai"), { recursive: true });
    writeFileSync(sourcePath, contents, "utf8");

    expect(
      migrateLegacyPluginModelCatalogs({
        agentDir,
        beforeLegacyCatalogClaim: (pathname) => {
          renameSync(pathname, claimPath);
        },
      }),
    ).toEqual({
      detected: 1,
      migrated: 0,
      warnings: [
        expect.stringContaining(
          "Legacy provider catalog was claimed before its migration was committed",
        ),
      ],
    });
    expect(existsSync(claimPath)).toBe(true);
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([]);
    migrateLegacyPluginModelCatalogs({ agentDir });
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
      { pluginId: "zai", contents },
    ]);
    expect(existsSync(claimPath)).toBe(false);
  });

  it("never migrates a provider while one retained claim cannot be read", () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const agentDir = createAgentDir();
    const pluginDir = join(agentDir, "plugins", "zai");
    const claimPath = join(pluginDir, "catalog.json.doctor-importing-previous-process");
    const sourcePath = join(pluginDir, "catalog.json");
    const retained = catalogContents("zai", "unreadable-retained-provider-test-key");
    const refreshed = catalogContents("zai", "current-canonical-provider-test-key");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(claimPath, retained, "utf8");
    writeFileSync(sourcePath, refreshed, "utf8");
    chmodSync(claimPath, 0o000);

    try {
      expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
        detected: 0,
        migrated: 0,
        warnings: [expect.stringContaining("Could not read legacy provider catalog")],
      });
      expect(existsSync(claimPath)).toBe(true);
      expect(existsSync(sourcePath)).toBe(true);
      expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    } finally {
      chmodSync(claimPath, 0o600);
    }

    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([]);
    migrateLegacyPluginModelCatalogs({ agentDir });
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
      { pluginId: "zai", contents: refreshed },
    ]);
  });

  it("preserves conflicting retained claims without guessing which credential is newer", () => {
    const agentDir = createAgentDir();
    const pluginDir = join(agentDir, "plugins", "zai");
    const olderPath = join(pluginDir, "catalog.json.doctor-importing-zzz");
    const newerPath = join(pluginDir, "catalog.json.doctor-importing-aaa");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(olderPath, catalogContents("zai", "older-provider-test-key"), "utf8");
    writeFileSync(newerPath, catalogContents("zai", "newer-provider-test-key"), "utf8");

    expect(migrateLegacyPluginModelCatalogs({ agentDir })).toEqual({
      detected: 0,
      migrated: 0,
      warnings: [expect.stringContaining("Conflicting retained legacy provider catalogs")],
    });
    expect(existsSync(olderPath)).toBe(true);
    expect(existsSync(newerPath)).toBe(true);
    expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
  });

  it("rejects invalid planning keys without deleting the committed catalog", async () => {
    const agentDir = createAgentDir();
    const zai = catalogContents("zai");
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: zai,
      },
    });

    await expect(
      replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: { "../catalog.json": catalogContents("anthropic") },
      }),
    ).rejects.toThrow("Invalid generated plugin model catalog key: ../catalog.json");
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
      { pluginId: "zai", contents: zai },
    ]);
  });

  it("round-trips encoded plugin ownership without filesystem discovery", () => {
    const pluginId = "provider/with spaces";
    const key = encodePluginModelCatalogRelativePath(pluginId);

    expect(key).toBe("plugins/provider%2Fwith%20spaces/catalog.json");
    expect(decodePluginModelCatalogRelativePathPluginId(key)).toBe(pluginId);
    expect(decodePluginModelCatalogRelativePathPluginId("../catalog.json")).toBeUndefined();
  });
});
