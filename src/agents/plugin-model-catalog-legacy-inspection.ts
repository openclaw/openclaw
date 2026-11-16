import { readdirSync, type Dirent } from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import {
  readLegacyPluginModelCatalog,
  PLUGIN_MODEL_CATALOG_FILE,
  isPluginModelCatalogMigrationFile,
  decodePluginModelCatalogRelativePathPluginId,
  recordCatalogMigrationIssue,
  type PluginModelCatalogMigrationIssue,
} from "./plugin-model-catalog-legacy-source.js";
import { isGeneratedPluginModelCatalog } from "./plugin-model-catalog-repair.js";

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
      warnings: hasErrnoCode(error, "ENOENT")
        ? []
        : [`Could not inspect legacy provider catalogs: ${pluginsDir}`],
      issues: hasErrnoCode(error, "ENOENT")
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

/** Runtime catalogs report migration guidance without adopting released credential bytes. */
export function inspectLegacyPluginModelCatalogWarning(agentDir: string): string | null {
  const inspected = inspectLegacyPluginModelCatalogs(agentDir);
  const diagnostics = [
    ...inspected.warnings,
    ...inspected.catalogs.map(({ pathname }) => `Legacy generated provider catalog: ${pathname}`),
  ];
  return diagnostics.length > 0
    ? `${diagnostics.join("\n")}\nRun openclaw doctor --fix to verify and import legacy provider catalogs.`
    : null;
}
