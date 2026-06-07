// Memory Wiki doctor contract migrates shipped source-sync state.
import fs from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import { resolveMemoryWikiConfig, type MemoryWikiPluginConfig } from "./src/config.js";
export { legacyConfigRules, normalizeCompatibilityConfig } from "./src/config-compat.js";
import {
  createMemoryWikiSourceSyncStateStore,
  MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
  MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
  readLegacyMemoryWikiSourceSyncState,
  resolveMemoryWikiSourceSyncStatePath,
  writeMemoryWikiSourceSyncState,
} from "./src/source-sync-state.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolveHomeDir(env: NodeJS.ProcessEnv): string | undefined {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || undefined;
}

function readConfiguredPluginConfig(config: OpenClawConfig): MemoryWikiPluginConfig | undefined {
  const entries = config.plugins?.entries;
  const pluginEntry = isRecord(entries) ? entries["memory-wiki"] : undefined;
  if (!isRecord(pluginEntry) || !isRecord(pluginEntry.config)) {
    return undefined;
  }
  return pluginEntry.config as MemoryWikiPluginConfig;
}

function resolveConfiguredVaultRoots(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): string[] {
  const homeDir = resolveHomeDir(params.env);
  const resolved = resolveMemoryWikiConfig(readConfiguredPluginConfig(params.config), {
    homedir: homeDir,
  });
  return [resolved.vault.path];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function archiveLegacySource(params: {
  filePath: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  if (await fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated Memory Wiki source-sync source in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived Memory Wiki source-sync legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving Memory Wiki source-sync legacy source: ${String(err)}`);
  }
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "memory-wiki-source-sync-json-to-plugin-state",
    label: "Memory Wiki source sync state",
    async detectLegacyState(params) {
      const previews: string[] = [];
      for (const vaultRoot of resolveConfiguredVaultRoots({
        config: params.config,
        env: params.env,
      })) {
        const filePath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
        const state = await readLegacyMemoryWikiSourceSyncState(vaultRoot);
        const count = Object.keys(state.entries).length;
        if (count === 0 || !(await fileExists(filePath))) {
          continue;
        }
        previews.push(
          `- Memory Wiki source sync: ${filePath} -> plugin state (${MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE}, ${count} entries)`,
        );
      }
      return previews.length > 0 ? { preview: previews } : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
      for (const vaultRoot of resolveConfiguredVaultRoots({
        config: params.config,
        env: params.env,
      })) {
        const filePath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
        if (!(await fileExists(filePath))) {
          continue;
        }
        const state = await readLegacyMemoryWikiSourceSyncState(vaultRoot);
        const count = Object.keys(state.entries).length;
        if (count === 0) {
          continue;
        }
        const existingState = await store.read(vaultRoot);
        const mergedEntries = {
          ...state.entries,
          ...existingState.entries,
        };
        const mergedCount = Object.keys(mergedEntries).length;
        if (mergedCount > MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES) {
          warnings.push(
            `Skipped Memory Wiki source-sync import for ${vaultRoot}: ${mergedCount} entries exceeds ${MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES}`,
          );
          continue;
        }
        await writeMemoryWikiSourceSyncState(
          vaultRoot,
          { version: 1, entries: mergedEntries },
          store,
        );
        const existingCount = Object.keys(existingState.entries).length;
        const importedCount = mergedCount - existingCount;
        changes.push(
          `Migrated Memory Wiki source sync -> plugin state (${importedCount} imported, ${existingCount} existing)`,
        );
        await archiveLegacySource({ filePath, changes, warnings });
      }
      return { changes, warnings };
    },
  },
];
