import { readFileSync } from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { decodeUtf8Input } from "../infra/utf8-input.js";

export type PluginModelCatalogMigrationIssue = {
  kind:
    | "inspection-failed"
    | "source-disappeared"
    | "conflicting-sources"
    | "superseded-source"
    | "claim-uncommitted"
    | "import-failed"
    | "cleanup-failed"
    | "source-changed";
  pathname: string;
  message: string;
};

export function recordCatalogMigrationIssue(
  warnings: string[],
  issues: PluginModelCatalogMigrationIssue[],
  kind: PluginModelCatalogMigrationIssue["kind"],
  pathname: string,
  message: string,
) {
  warnings.push(message);
  issues.push({ kind, pathname, message });
}

export function readLegacyPluginModelCatalog(pathname: string): string | null {
  try {
    return decodeUtf8Input(readFileSync(pathname), `Legacy provider catalog ${pathname}`);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

// The in-memory planning key retains the established owner encoding; generated
// payloads themselves are persisted only in the agent SQLite cache.
export const PLUGIN_MODEL_CATALOG_FILE = "catalog.json";

/** Recognizes canonical catalogs and recoverable atomic migration claims. */
export function isPluginModelCatalogMigrationFile(filename: string): boolean {
  return (
    filename === PLUGIN_MODEL_CATALOG_FILE ||
    filename.startsWith(`${PLUGIN_MODEL_CATALOG_FILE}.doctor-importing-`)
  );
}

/** Encodes the profile-relative path for a plugin-owned generated model catalog. */
export function encodePluginModelCatalogRelativePath(pluginId: string): string {
  return `plugins/${encodeURIComponent(pluginId)}/${PLUGIN_MODEL_CATALOG_FILE}`;
}

/** Decodes the plugin id from a canonical generated catalog path. */
export function decodePluginModelCatalogRelativePathPluginId(
  relativePath: string,
): string | undefined {
  const parts = relativePath.split(/[\\/]/);
  const encodedPluginId = parts[1];
  if (
    path.isAbsolute(relativePath) ||
    parts.length !== 3 ||
    parts[0] !== "plugins" ||
    !encodedPluginId ||
    encodedPluginId === "." ||
    encodedPluginId === ".." ||
    parts[2] !== PLUGIN_MODEL_CATALOG_FILE
  ) {
    return undefined;
  }
  try {
    return decodeURIComponent(encodedPluginId);
  } catch {
    return undefined;
  }
}
