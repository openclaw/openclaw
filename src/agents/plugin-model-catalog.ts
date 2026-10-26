/**
 * Generated plugin model catalog discovery.
 *
 * The existing agent SQLite cache lets provider discovery reuse plugin-owned
 * catalogs without loading runtimes or creating parallel state files.
 */
import { randomUUID } from "node:crypto";
import { linkSync, readdirSync, renameSync, unlinkSync, type Dirent } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { hasErrnoCode } from "../infra/errno.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { isProviderCatalogSourceAllowed } from "../plugins/provider-config-owner.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import {
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
} from "./auth-profiles/sqlite.js";
import { MODELS_JSON_STATE } from "./models-config-state.js";
import type { PluginModelCatalogAuthSnapshot } from "./plugin-model-catalog-auth.js";
import {
  withPluginModelCatalogPublicationLocks,
  withPluginModelCatalogWorker,
} from "./plugin-model-catalog-execution.js";
import {
  readLegacyPluginModelCatalog,
  PLUGIN_MODEL_CATALOG_FILE,
  isPluginModelCatalogMigrationFile,
  decodePluginModelCatalogRelativePathPluginId,
  recordCatalogMigrationIssue,
  type PluginModelCatalogMigrationIssue,
} from "./plugin-model-catalog-legacy-source.js";
import {
  isGeneratedPluginModelCatalog,
  repairPluginModelCatalogTransportMetadata,
} from "./plugin-model-catalog-repair.js";
import {
  PLUGIN_MODEL_CATALOG_CACHE_SCOPE,
  PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE,
  readPluginModelCatalogEntries,
  replacePluginModelCatalogEntriesInDatabase,
  type PersistedPluginModelCatalog,
  type PluginModelCatalogReplacement,
} from "./plugin-model-catalog.kernel.js";

export {
  encodePluginModelCatalogRelativePath,
  decodePluginModelCatalogRelativePathPluginId,
} from "./plugin-model-catalog-legacy-source.js";
export type { PluginModelCatalogMigrationIssue } from "./plugin-model-catalog-legacy-source.js";

export { isGeneratedPluginModelCatalog };
export { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "./plugin-model-catalog-repair.js";
export type { PersistedPluginModelCatalog } from "./plugin-model-catalog.kernel.js";

type PluginModelCatalogDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;

function pluginModelCatalogDatabaseOptions(agentDir: string) {
  return {
    agentId: resolveAuthProfileDatabaseOwnerId(agentDir),
    path: resolveAuthProfileDatabasePath(agentDir),
  };
}

function readPersistedPluginModelCatalogEntries(
  agentDir: string,
  scope: string,
  pluginIds?: readonly string[],
): PersistedPluginModelCatalog[] {
  const result = withOpenClawAgentDatabaseReadOnly(
    ({ db }) => readPluginModelCatalogEntries(db, scope, pluginIds),
    pluginModelCatalogDatabaseOptions(agentDir),
  );
  return result.found ? result.value : [];
}

/** Native Doctor inspection and the public synchronous ModelRegistry SDK contract. */
export function loadPersistedPluginModelCatalogsReadOnly(
  agentDir: string,
  pluginIds?: readonly string[],
): PersistedPluginModelCatalog[] {
  if (pluginIds?.length === 0) {
    return [];
  }
  return readPersistedPluginModelCatalogEntries(
    agentDir,
    PLUGIN_MODEL_CATALOG_CACHE_SCOPE,
    pluginIds,
  );
}

/** Applies Doctor's repair to unchanged persisted catalog bytes. */
export function repairPersistedPluginModelCatalogs(params: {
  agentDir: string;
  catalogs: readonly PersistedPluginModelCatalog[];
}): Array<{ pluginId: string; removedModelCount: number; completedCostModelCount: number }> {
  const repairs = params.catalogs.flatMap((catalog) => {
    const repaired = repairPluginModelCatalogTransportMetadata(catalog.contents);
    return repaired.contents !== catalog.contents
      ? [
          {
            ...catalog,
            repairedContents: repaired.contents,
            removedModelCount: repaired.removedModelCount,
            completedCostModelCount: repaired.completedCostModelCount,
          },
        ]
      : [];
  });
  if (repairs.length === 0) {
    return [];
  }

  const updatedAt = Date.now();
  const applied = runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<PluginModelCatalogDatabase>(database.db);
      return repairs.flatMap((repair) => {
        // Compare-and-set protects a concurrent provider refresh from being
        // overwritten by repair work planned from an older catalog snapshot.
        const result = executeSqliteQuerySync(
          database.db,
          kysely
            .updateTable("cache_entries")
            .set({ value_json: repair.repairedContents, updated_at: updatedAt })
            .where("scope", "=", PLUGIN_MODEL_CATALOG_CACHE_SCOPE)
            .where("key", "=", repair.pluginId)
            .where("value_json", "=", repair.contents),
        );
        return result.numAffectedRows === 1n ? [repair] : [];
      });
    },
    pluginModelCatalogDatabaseOptions(params.agentDir),
    { operationLabel: "plugin-model-catalog.repair" },
  );
  return applied.map(({ pluginId, removedModelCount, completedCostModelCount }) => ({
    pluginId,
    removedModelCount,
    completedCostModelCount,
  }));
}

function readPersistedPluginModelCatalogMigrationPayloads(
  agentDir: string,
): ReadonlyMap<string, string> {
  return new Map(
    readPersistedPluginModelCatalogEntries(agentDir, PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE).map(
      (catalog) => [catalog.pluginId, catalog.contents],
    ),
  );
}

/** Doctor keeps its synchronous sidecar-claim and migration transaction. */
function replacePersistedPluginModelCatalogEntries(
  agentDir: string,
  catalog: PersistedPluginModelCatalog,
): boolean {
  const migrationPayloads = new Map([[catalog.pluginId, catalog.contents]]);
  return runOpenClawAgentWriteTransaction(
    ({ db }) =>
      replacePluginModelCatalogEntriesInDatabase({
        database: db,
        planned: migrationPayloads,
        migrationPayloads,
        deleteMissing: false,
        updatedAt: Date.now(),
      }).changed,
    pluginModelCatalogDatabaseOptions(agentDir),
    { operationLabel: "plugin-model-catalog.migrate" },
  );
}

type PluginModelCatalogMigrationResult = {
  migrated: number;
  warnings: string[];
  issues: PluginModelCatalogMigrationIssue[];
};

function hasCommittedExpectedPluginModelCatalogs(
  agentDir: string,
  expectedContents: ReadonlyMap<string, string>,
): boolean {
  const committed = new Map(
    loadPersistedPluginModelCatalogsReadOnly(agentDir).map((catalog) => [
      catalog.pluginId,
      catalog.contents,
    ]),
  );
  const migrationPayloads = readPersistedPluginModelCatalogMigrationPayloads(agentDir);
  for (const [pluginId, contents] of expectedContents) {
    if (committed.get(pluginId) !== contents && migrationPayloads.get(pluginId) !== contents) {
      return false;
    }
  }
  return true;
}

function hasCommittedMigratedPluginModelCatalog(
  agentDir: string,
  pluginId: string,
  contents: string,
): boolean {
  const committed = loadPersistedPluginModelCatalogsReadOnly(agentDir).find(
    (catalog) => catalog.pluginId === pluginId,
  );
  return (
    committed?.contents === contents &&
    readPersistedPluginModelCatalogMigrationPayloads(agentDir).get(pluginId) === contents
  );
}

function retireCommittedPluginModelCatalogMigration(params: {
  agentDir: string;
  pluginId: string;
  contents: string;
}): boolean {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<PluginModelCatalogDatabase>(database.db);
      const committed = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("cache_entries")
          .select(["scope", "value_json"])
          .where("key", "=", params.pluginId)
          .where("scope", "in", [
            PLUGIN_MODEL_CATALOG_CACHE_SCOPE,
            PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE,
          ]),
      ).rows;
      const contentsByScope = new Map(committed.map((row) => [row.scope, row.value_json]));
      if (
        contentsByScope.get(PLUGIN_MODEL_CATALOG_CACHE_SCOPE) !== params.contents ||
        contentsByScope.get(PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE) !== params.contents
      ) {
        return false;
      }
      executeSqliteQuerySync(
        database.db,
        kysely
          .deleteFrom("cache_entries")
          .where("scope", "=", PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE)
          .where("key", "=", params.pluginId),
      );
      return true;
    },
    pluginModelCatalogDatabaseOptions(params.agentDir),
    { operationLabel: "plugin-model-catalog.retire-migration" },
  );
}

function retireOrphanedPluginModelCatalogMigrations(params: {
  agentDir: string;
  protectedPluginIds?: ReadonlySet<string>;
}): void {
  for (const [pluginId, contents] of readPersistedPluginModelCatalogMigrationPayloads(
    params.agentDir,
  )) {
    if (params.protectedPluginIds?.has(pluginId)) {
      continue;
    }
    // A crashed claim can leave recovery bytes after its source was removed.
    // The transaction retires them only while the canonical catalog still matches.
    retireCommittedPluginModelCatalogMigration({
      agentDir: params.agentDir,
      pluginId,
      contents,
    });
  }
}

/** Inspects released sidecars without creating, repairing, claiming, or removing state. */
export function inspectLegacyPluginModelCatalogs(agentDir: string): {
  catalogs: Array<{ pluginId: string; pathname: string; contents: string }>;
  warnings: string[];
  issues: PluginModelCatalogMigrationIssue[];
  protectedPluginIds: ReadonlySet<string>;
  directoryError?: unknown;
} {
  const pluginsDir = path.join(agentDir, "plugins");
  let pluginDirs: Dirent[];
  try {
    pluginDirs = readdirSync(pluginsDir, { withFileTypes: true });
  } catch (error) {
    return {
      catalogs: [],
      warnings:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? []
          : [`Could not inspect legacy provider catalogs: ${pluginsDir}`],
      issues:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? []
          : [
              {
                kind: "inspection-failed",
                pathname: pluginsDir,
                message: `Could not inspect legacy provider catalogs: ${pluginsDir}`,
              },
            ],
      protectedPluginIds: new Set(),
      directoryError: error,
    };
  }
  const warnings: string[] = [];
  const issues: PluginModelCatalogMigrationIssue[] = [];
  const legacyCatalogs: Array<{ pluginId: string; pathname: string; contents: string }> = [];
  const protectedMigrationPluginIds = new Set<string>();
  for (const pluginDir of pluginDirs) {
    if (!pluginDir.isDirectory()) {
      continue;
    }
    const relativePath = path.join("plugins", pluginDir.name, PLUGIN_MODEL_CATALOG_FILE);
    const pluginId = decodePluginModelCatalogRelativePathPluginId(relativePath);
    if (!pluginId) {
      continue;
    }
    const pluginPath = path.join(agentDir, "plugins", pluginDir.name);
    let catalogFiles: Dirent[];
    try {
      catalogFiles = readdirSync(pluginPath, { withFileTypes: true });
    } catch {
      // An uninspected owner may still contain the source for a recovery row.
      // Never retire its credential backup based on an incomplete scan.
      protectedMigrationPluginIds.add(pluginId);
      recordCatalogMigrationIssue(
        warnings,
        issues,
        "inspection-failed",
        pluginPath,
        `Could not inspect legacy provider catalogs: ${pluginPath}`,
      );
      continue;
    }
    const sourceFiles = catalogFiles
      .filter((entry) => entry.isFile() && isPluginModelCatalogMigrationFile(entry.name))
      .toSorted((left, right) => {
        if (left.name === PLUGIN_MODEL_CATALOG_FILE) {
          return 1;
        }
        if (right.name === PLUGIN_MODEL_CATALOG_FILE) {
          return -1;
        }
        return left.name.localeCompare(right.name);
      });
    if (sourceFiles.length > 0) {
      protectedMigrationPluginIds.add(pluginId);
    }
    const pluginLegacyCatalogs: Array<{
      pluginId: string;
      pathname: string;
      contents: string;
    }> = [];
    let hasUnreadableCatalog = false;
    for (const sourceFile of sourceFiles) {
      const pathname = path.join(pluginPath, sourceFile.name);
      let contents: string | null;
      try {
        contents = readLegacyPluginModelCatalog(pathname);
      } catch {
        hasUnreadableCatalog = true;
        recordCatalogMigrationIssue(
          warnings,
          issues,
          "inspection-failed",
          pathname,
          `Could not read legacy provider catalog: ${pathname}`,
        );
        continue;
      }
      if (contents === null) {
        recordCatalogMigrationIssue(
          warnings,
          issues,
          "source-disappeared",
          pathname,
          `Legacy provider catalog disappeared before migration: ${pathname}`,
        );
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents) as unknown;
      } catch {
        continue;
      }
      if (isGeneratedPluginModelCatalog(parsed)) {
        pluginLegacyCatalogs.push({ pluginId, pathname, contents });
      }
    }
    if (hasUnreadableCatalog) {
      // One inaccessible claim can hold a newer credential than the readable
      // source; migrating either side would make later recovery roll back.
      continue;
    }
    if (
      !pluginLegacyCatalogs.some(
        (catalog) => path.basename(catalog.pathname) === PLUGIN_MODEL_CATALOG_FILE,
      ) &&
      new Set(pluginLegacyCatalogs.map((catalog) => catalog.contents)).size > 1
    ) {
      // Random claim names carry no generation order. Preserve every divergent
      // credential until Doctor or its operator can select an authoritative source.
      recordCatalogMigrationIssue(
        warnings,
        issues,
        "conflicting-sources",
        pluginPath,
        `Conflicting retained legacy provider catalogs: ${pluginPath}`,
      );
      continue;
    }
    legacyCatalogs.push(...pluginLegacyCatalogs);
  }

  return {
    catalogs: legacyCatalogs,
    warnings,
    issues,
    protectedPluginIds: protectedMigrationPluginIds,
  };
}

/** Doctor-owned import of released sidecars into canonical agent SQLite state. */
export function migrateLegacyPluginModelCatalogs(params: {
  agentDir: string;
  expectedContents?: ReadonlyMap<string, string>;
  beforeLegacyCatalogClaim?: (pathname: string) => void;
}): PluginModelCatalogMigrationResult {
  const agentDir = path.resolve(params.agentDir);
  const {
    catalogs: legacyCatalogs,
    warnings,
    issues,
    protectedPluginIds: protectedMigrationPluginIds,
    directoryError,
  } = inspectLegacyPluginModelCatalogs(agentDir);
  if (directoryError) {
    if (!hasErrnoCode(directoryError, "ENOENT")) {
      if (
        params.expectedContents &&
        !hasCommittedExpectedPluginModelCatalogs(agentDir, params.expectedContents)
      ) {
        throw new Error("Could not inspect expected legacy provider catalogs", {
          cause: directoryError,
        });
      }
      return { migrated: 0, warnings, issues };
    }
    if (
      params.expectedContents &&
      params.expectedContents.size > 0 &&
      !hasCommittedExpectedPluginModelCatalogs(agentDir, params.expectedContents)
    ) {
      throw new Error("Legacy provider catalogs disappeared before migration", {
        cause: directoryError,
      });
    }
    retireOrphanedPluginModelCatalogMigrations({ agentDir });
    return { migrated: 0, warnings: [], issues: [] };
  }

  retireOrphanedPluginModelCatalogMigrations({
    agentDir,
    protectedPluginIds: protectedMigrationPluginIds,
  });

  if (params.expectedContents) {
    const observed = new Map(legacyCatalogs.map((catalog) => [catalog.pluginId, catalog.contents]));
    for (const [pluginId, contents] of params.expectedContents) {
      const observedContents = observed.get(pluginId);
      if (observedContents === contents) {
        continue;
      }
      if (
        observedContents === undefined &&
        hasCommittedExpectedPluginModelCatalogs(agentDir, new Map([[pluginId, contents]]))
      ) {
        continue;
      }
      if (observedContents !== contents) {
        throw new Error(`Legacy provider catalog changed before migration: ${pluginId}`);
      }
    }
  }

  if (legacyCatalogs.length === 0) {
    return { migrated: 0, warnings, issues };
  }

  let migrated = 0;
  for (const catalog of legacyCatalogs) {
    if (
      readPersistedPluginModelCatalogMigrationPayloads(agentDir).get(catalog.pluginId) ===
        catalog.contents &&
      !hasCommittedMigratedPluginModelCatalog(agentDir, catalog.pluginId, catalog.contents)
    ) {
      recordCatalogMigrationIssue(
        warnings,
        issues,
        "superseded-source",
        catalog.pathname,
        `Left superseded legacy provider catalog in place: ${catalog.pathname}`,
      );
      continue;
    }
    params.beforeLegacyCatalogClaim?.(catalog.pathname);
    const claimPath = `${catalog.pathname}.doctor-importing-${process.pid}-${randomUUID()}`;
    try {
      // Claim the exact inode before checking or deleting it; a legacy writer
      // can safely recreate catalog.json without losing its newer credentials.
      renameSync(catalog.pathname, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (
          hasCommittedExpectedPluginModelCatalogs(
            agentDir,
            new Map([[catalog.pluginId, catalog.contents]]),
          )
        ) {
          migrated += 1;
        } else {
          recordCatalogMigrationIssue(
            warnings,
            issues,
            "claim-uncommitted",
            catalog.pathname,
            `Legacy provider catalog was claimed before its migration was committed: ${catalog.pathname}`,
          );
        }
      } else {
        let published = false;
        try {
          if (readLegacyPluginModelCatalog(catalog.pathname) === catalog.contents) {
            // A directory can permit reads while forbidding rename. Publish the
            // verified credential, retain its source, and retry cleanup later.
            replacePersistedPluginModelCatalogEntries(agentDir, catalog);
            published = true;
          }
        } catch {
          // Preserve the original source and surface its migration warning.
        }
        recordCatalogMigrationIssue(
          warnings,
          issues,
          published ? "cleanup-failed" : "import-failed",
          catalog.pathname,
          `Could not remove migrated legacy provider catalog: ${catalog.pathname}`,
        );
      }
      continue;
    }

    try {
      if (readLegacyPluginModelCatalog(claimPath) !== catalog.contents) {
        throw new Error("legacy provider catalog changed before migration could claim it");
      }
      // Never publish scanned bytes until the exact source inode is claimed.
      // Catalog and temporary credential recovery commit in one transaction.
      replacePersistedPluginModelCatalogEntries(agentDir, catalog);
      if (!hasCommittedMigratedPluginModelCatalog(agentDir, catalog.pluginId, catalog.contents)) {
        throw new Error("committed provider catalog changed before migration could remove it");
      }
      unlinkSync(claimPath);
    } catch {
      // linkSync restores without replacing a newer catalog.json created by a
      // concurrent writer; retain the claim if that canonical path already exists.
      let retainedPath = claimPath;
      try {
        linkSync(claimPath, catalog.pathname);
        retainedPath = catalog.pathname;
        unlinkSync(claimPath);
      } catch {
        // Either canonical or claimed bytes remain available for Doctor repair.
      }
      recordCatalogMigrationIssue(
        warnings,
        issues,
        "source-changed",
        retainedPath,
        `Left changed legacy provider catalog in place: ${retainedPath}`,
      );
      continue;
    }
    // Retire the temporary secret only when the same SQLite transaction proves
    // the authoritative catalog still contains every migrated credential.
    retireCommittedPluginModelCatalogMigration({
      agentDir,
      pluginId: catalog.pluginId,
      contents: catalog.contents,
    });
    migrated += 1;
  }
  return { migrated, warnings, issues };
}

/** Replaces rebuildable provider catalogs in the existing per-agent SQLite cache. */
export async function replacePersistedPluginModelCatalogs(params: {
  agentDir: string;
  pluginCatalogWrites: Readonly<Record<string, string>>;
  authSnapshot?: PluginModelCatalogAuthSnapshot;
  env?: NodeJS.ProcessEnv;
}): Promise<PluginModelCatalogReplacement> {
  const options = {
    ...pluginModelCatalogDatabaseOptions(params.agentDir),
    env: cloneEnvWithPlatformSemantics(params.env ?? process.env),
  };
  options.path = resolvePathViaExistingAncestorSync(options.path);
  const planned = new Map<string, string>();
  for (const [relativePath, contents] of Object.entries(params.pluginCatalogWrites)) {
    const pluginId = decodePluginModelCatalogRelativePathPluginId(relativePath);
    if (!pluginId) {
      throw new Error(`Invalid generated plugin model catalog key: ${relativePath}`);
    }
    planned.set(pluginId, repairPluginModelCatalogTransportMetadata(contents).contents);
  }
  if (planned.size === 0) {
    try {
      await stat(options.path);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return { changed: false, catalogs: [] };
      }
      throw error;
    }
  }
  return await withPluginModelCatalogPublicationLocks([options.path], () =>
    withPluginModelCatalogWorker(options, planned.size > 0, (scope) =>
      scope.execute({
        type: "catalog.replace",
        input: {
          planned: [...planned],
          authSnapshot: params.authSnapshot,
          env: { ...options.env, OPENCLAW_STATE_DIR: resolveStateDir(options.env) },
        },
      }),
    ),
  );
}

/** Removes only cached endpoints known to belong to a just-removed config entry. */
export async function pruneRemovedProviderPluginModelCatalogs(params: {
  agentDir: string;
  removedProviderBaseUrls: Readonly<Record<string, string>>;
}): Promise<boolean> {
  if (Object.keys(params.removedProviderBaseUrls).length === 0) {
    return false;
  }
  // Discovery plans hold this queue through publication; prune after older plans settle.
  return await MODELS_JSON_STATE.writeQueue.enqueue(
    path.join(params.agentDir, "models.json"),
    async () => {
      const options = pluginModelCatalogDatabaseOptions(params.agentDir);
      options.path = resolvePathViaExistingAncestorSync(options.path);
      try {
        await stat(options.path);
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          return false;
        }
        throw error;
      }
      return await withPluginModelCatalogPublicationLocks([options.path], () =>
        withPluginModelCatalogWorker(options, false, (scope) =>
          scope.execute({
            type: "catalog.pruneRemovedProviders",
            input: { removedProviderBaseUrls: { ...params.removedProviderBaseUrls } },
          }),
        ),
      );
    },
  );
}

export type PluginModelCatalogMetadataSnapshot = Pick<PluginMetadataSnapshot, "owners"> & {
  manifestRegistry?: Pick<PluginMetadataSnapshot["manifestRegistry"], "plugins">;
  index?: {
    plugins: ReadonlyArray<{
      enabled: boolean;
      pluginId: string;
    }>;
  };
  normalizePluginId?: (pluginId: string) => string;
};

/** Resolves the sole enabled plugin that owns a provider's model catalog. */
export function resolvePluginModelCatalogOwnerPluginId(params: {
  providerId: string;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
}): string | undefined {
  const snapshot = params.pluginMetadataSnapshot;
  const owners = snapshot?.owners;
  if (!owners) {
    return undefined;
  }
  const providerId = normalizeProviderId(params.providerId);
  const candidates = [
    owners.modelCatalogProviders.get(providerId),
    owners.providers.get(providerId),
    owners.setupProviders.get(providerId),
  ].find((entry): entry is readonly string[] => Boolean(entry?.length));
  const pluginId = candidates?.length === 1 ? candidates[0] : undefined;
  if (!pluginId) {
    return undefined;
  }
  if (!snapshot?.index) {
    return pluginId;
  }
  const normalizedPluginId = snapshot.normalizePluginId?.(pluginId) ?? pluginId;
  return snapshot.index.plugins.some(
    (plugin) => plugin.pluginId === normalizedPluginId && plugin.enabled,
  )
    ? normalizedPluginId
    : undefined;
}

/** Keeps generated catalog providers only when the catalog plugin still owns them. */
export function filterGeneratedPluginModelCatalogProviders<T>(params: {
  catalogPluginId?: string;
  isProviderAvailable?: (providerId: string) => boolean;
  config?: OpenClawConfig;
  parsedCatalog?: unknown;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
  providers: Record<string, T>;
}): Record<string, T> {
  if (
    !params.catalogPluginId ||
    !params.pluginMetadataSnapshot ||
    (params.parsedCatalog !== undefined && !isGeneratedPluginModelCatalog(params.parsedCatalog))
  ) {
    return {};
  }
  const plugin = params.pluginMetadataSnapshot.manifestRegistry?.plugins.find(
    (candidate) => candidate.id === params.catalogPluginId,
  );
  const providers = Object.fromEntries(
    Object.entries(params.providers).filter(
      ([providerId]) =>
        resolvePluginModelCatalogOwnerPluginId({
          providerId,
          pluginMetadataSnapshot: params.pluginMetadataSnapshot,
        }) === params.catalogPluginId &&
        isProviderCatalogSourceAllowed({
          provider: providerId,
          config: params.config,
          plugin,
        }),
    ),
  );
  // Captured auth, not the retained catalog's credentials, admits deferred inventory.
  if (
    plugin?.activation?.onStartup === false &&
    params.isProviderAvailable &&
    !Object.keys(providers).some(params.isProviderAvailable)
  ) {
    return {};
  }
  return providers;
}
