// Memory Wiki Doctor owns compiled-cache cleanup and unsupported state detection.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { walkMemoryWikiDirectory } from "./src/bounded-walk.js";
import {
  resolveMemoryWikiAgentConfig,
  resolveMemoryWikiConfig,
  resolveMemoryWikiConfiguredAgentIds,
  type MemoryWikiPluginConfig,
} from "./src/config.js";
import {
  createMemoryWikiImportRunStateStore,
  resolveMemoryWikiImportRunsDir,
} from "./src/import-runs-state.js";
import { createMemoryWikiSourceSyncStateStore } from "./src/source-sync-state.js";
export { legacyConfigRules, normalizeCompatibilityConfig } from "./src/config-compat.js";

const LEGACY_MEMORY_WIKI_COMPILED_CACHE_PATHS = [
  ".openclaw-wiki/cache/agent-digest.json",
  ".openclaw-wiki/cache/claims.jsonl",
] as const;

function resolveHomeDir(env: NodeJS.ProcessEnv): string | undefined {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || undefined;
}

function isMissingPathError(error: unknown): boolean {
  return (
    (error instanceof FsSafeError && error.code === "not-found") ||
    (isRecord(error) && error.code === "ENOENT")
  );
}

async function safeLegacyCacheFileExists(
  vaultRoot: Awaited<ReturnType<typeof fsRoot>>,
  relativePath: string,
): Promise<boolean> {
  try {
    const stat = await vaultRoot.stat(relativePath);
    return stat.isFile;
  } catch (error) {
    if (isMissingPathError(error) || error instanceof FsSafeError) {
      return false;
    }
    throw error;
  }
}

async function openExistingVaultRoot(vaultRoot: string) {
  try {
    return await fsRoot(vaultRoot);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
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
    env: params.env,
  });
  if (resolved.vault.scope === "global") {
    return [resolved.vault.path];
  }
  return resolveMemoryWikiConfiguredAgentIds(params.config).map(
    (agentId) =>
      resolveMemoryWikiAgentConfig({
        config: resolved,
        appConfig: params.config,
        agentId,
      }).vault.path,
  );
}

type WikiStateMigrationParams = Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0];

function unsupportedJsonWarning(filePath: string, emptySourceSync = false): string {
  return `Memory Wiki: upgrades from pre-July-2026 JSON state are no longer migrated (${filePath}). ${emptySourceSync ? "No canonical SQLite source-sync state was found; an empty store cannot be distinguished from unmigrated state. " : "No canonical SQLite import-run record was found. "}Restore a backup produced by a July 2026 or newer release, or back up and move this retired file aside after verifying the SQLite state, then rerun openclaw doctor --fix. The file was left unchanged.`;
}

async function unsupportedSourceSyncFiles(params: WikiStateMigrationParams): Promise<string[]> {
  const warnings: string[] = [];
  const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
  for (const vaultRoot of resolveConfiguredVaultRoots(params)) {
    const filePath = path.join(vaultRoot, ".openclaw-wiki", "source-sync.json");
    try {
      await fs.lstat(filePath);
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      throw error;
    }
    const state = await store.read(vaultRoot);
    if (Object.keys(state.entries).length === 0) {
      warnings.push(unsupportedJsonWarning(filePath, true));
    }
  }
  return warnings;
}

async function unsupportedImportRunFiles(params: WikiStateMigrationParams): Promise<string[]> {
  const warnings: string[] = [];
  const store = createMemoryWikiImportRunStateStore(params.context.openPluginStateKeyedStore);
  for (const vaultRoot of resolveConfiguredVaultRoots(params)) {
    const importRunsDir = resolveMemoryWikiImportRunsDir(vaultRoot);
    const files = await walkMemoryWikiDirectory(importRunsDir, "", {
      maxDepth: 1,
      entryFilter: (entry) =>
        entry.kind === "directory"
          ? "skip-subtree"
          : entry.kind === "file" && entry.relativePath.endsWith(".json")
            ? "include"
            : "skip",
    }).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return [];
      }
      throw error;
    });
    if (files.length === 0) {
      continue;
    }
    const runIds = new Set((await store.list(vaultRoot)).map((record) => record.runId));
    for (const file of files) {
      if (!runIds.has(file.relativePath.slice(0, -".json".length))) {
        warnings.push(unsupportedJsonWarning(path.join(importRunsDir, file.relativePath)));
      }
    }
  }
  return warnings;
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "memory-wiki-compiled-cache-file-cleanup",
    label: "Memory Wiki compiled cache files",
    async detectLegacyState(params) {
      const previews: string[] = [];
      for (const vaultRoot of resolveConfiguredVaultRoots(params)) {
        const root = await openExistingVaultRoot(vaultRoot);
        if (!root) {
          continue;
        }
        const stalePaths = (
          await Promise.all(
            LEGACY_MEMORY_WIKI_COMPILED_CACHE_PATHS.map(async (relativePath) => {
              const filePath = path.join(vaultRoot, relativePath);
              return (await safeLegacyCacheFileExists(root, relativePath)) ? filePath : null;
            }),
          )
        ).filter((filePath): filePath is string => Boolean(filePath));
        for (const filePath of stalePaths) {
          previews.push(`- Remove rebuildable Memory Wiki compiled cache: ${filePath}`);
        }
      }
      return previews.length > 0 ? { preview: previews } : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      for (const vaultRoot of resolveConfiguredVaultRoots(params)) {
        const root = await openExistingVaultRoot(vaultRoot);
        if (!root) {
          continue;
        }
        for (const relativePath of LEGACY_MEMORY_WIKI_COMPILED_CACHE_PATHS) {
          const filePath = path.join(vaultRoot, relativePath);
          if (!(await safeLegacyCacheFileExists(root, relativePath))) {
            continue;
          }
          try {
            await root.remove(relativePath);
            changes.push(`Removed rebuildable Memory Wiki compiled cache: ${filePath}`);
          } catch (error) {
            if (!isMissingPathError(error)) {
              warnings.push(
                `Skipped rebuildable Memory Wiki compiled cache cleanup. Run openclaw doctor --fix to retry. ${filePath}: ${String(error)}`,
              );
            }
          }
        }
      }
      return {
        changes,
        warnings,
        ...(warnings.length > 0 ? { warningDisposition: "recoverable" as const } : {}),
      };
    },
  },
  {
    id: "memory-wiki-source-sync-json-to-plugin-state",
    label: "Memory Wiki unsupported source-sync JSON",
    collectBackupResources: () => [],
    async detectLegacyState(params) {
      const warnings = await unsupportedSourceSyncFiles(params);
      return warnings.length > 0 ? { preview: warnings.map((warning) => `- ${warning}`) } : null;
    },
    async migrateLegacyState(params) {
      return { changes: [], warnings: await unsupportedSourceSyncFiles(params) };
    },
  },
  {
    id: "memory-wiki-import-runs-json-to-plugin-state",
    label: "Memory Wiki unsupported import-run JSON",
    collectBackupResources: () => [],
    async detectLegacyState(params) {
      const warnings = await unsupportedImportRunFiles(params);
      return warnings.length > 0 ? { preview: warnings.map((warning) => `- ${warning}`) } : null;
    },
    async migrateLegacyState(params) {
      return { changes: [], warnings: await unsupportedImportRunFiles(params) };
    },
  },
];
