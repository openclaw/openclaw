import type { Dirent } from "node:fs";
// Matrix API module exposes the plugin public contract.
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import {
  hasMatrixSyncCacheStateInStore,
  openMatrixSyncCacheStoreOptions,
  readLegacyMatrixSyncCacheState,
  writeMatrixSyncCacheStateToStore,
  type MatrixSyncCacheRecord,
} from "./src/matrix/client/file-sync-store.js";

export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";

const MATRIX_SYNC_CACHE_FILENAME = "bot-storage.json";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function collectLegacySyncCacheRoots(stateDir: string): Promise<string[]> {
  const matrixRoot = path.join(stateDir, "matrix");
  const roots: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === MATRIX_SYNC_CACHE_FILENAME) {
        roots.push(dir);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
      }
    }
  }
  await visit(matrixRoot);
  return roots.filter((root) => path.resolve(root) !== path.resolve(matrixRoot)).toSorted();
}

async function archiveLegacySyncCache(params: {
  storageRootDir: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const sourcePath = path.join(params.storageRootDir, MATRIX_SYNC_CACHE_FILENAME);
  const archivedPath = `${sourcePath}.migrated`;
  if (await fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated Matrix sync cache in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.rename(sourcePath, archivedPath);
    params.changes.push(`Archived Matrix sync cache legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving Matrix sync cache legacy source: ${String(err)}`);
  }
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "matrix-sync-cache-json-to-plugin-state",
    label: "Matrix sync cache",
    async detectLegacyState(params) {
      const previews: string[] = [];
      for (const storageRootDir of await collectLegacySyncCacheRoots(params.stateDir)) {
        const persisted = await readLegacyMatrixSyncCacheState(storageRootDir);
        if (!persisted) {
          continue;
        }
        previews.push(`Matrix sync cache JSON can migrate to SQLite: ${storageRootDir}`);
      }
      return previews.length > 0 ? { preview: previews } : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      for (const storageRootDir of await collectLegacySyncCacheRoots(params.stateDir)) {
        const persisted = await readLegacyMatrixSyncCacheState(storageRootDir);
        if (!persisted) {
          continue;
        }
        const store = params.context.openPluginStateKeyedStore<MatrixSyncCacheRecord>(
          openMatrixSyncCacheStoreOptions(storageRootDir),
        );
        if (await hasMatrixSyncCacheStateInStore({ storageRootDir, store })) {
          warnings.push(
            `Skipped Matrix sync cache import for ${storageRootDir} because SQLite already has sync cache state`,
          );
          await archiveLegacySyncCache({ storageRootDir, changes, warnings });
          continue;
        }
        await writeMatrixSyncCacheStateToStore({
          storageRootDir,
          payload: persisted,
          store,
        });
        changes.push(`Migrated Matrix sync cache JSON to SQLite for ${storageRootDir}`);
        await archiveLegacySyncCache({ storageRootDir, changes, warnings });
      }
      return { changes, warnings };
    },
  },
];
