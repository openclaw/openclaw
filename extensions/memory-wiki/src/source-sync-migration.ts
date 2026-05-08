import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationProviderPlugin } from "openclaw/plugin-sdk/migration";
import { createMigrationItem, summarizeMigrationItems } from "openclaw/plugin-sdk/migration";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { writeMemoryWikiImportRunRecord } from "./import-runs.js";
import { importMemoryWikiLegacyLog, resolveMemoryWikiLegacyLogPath } from "./log.js";
import {
  importMemoryWikiLegacySourceSyncState,
  resolveMemoryWikiLegacySourceSyncStatePath,
} from "./source-sync-state.js";

const PROVIDER_ID = "memory-wiki-source-sync";

async function legacySourceExists(vaultRoot: string): Promise<boolean> {
  const sourcePath = resolveMemoryWikiLegacySourceSyncStatePath(vaultRoot);
  return await fs
    .stat(sourcePath)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

async function legacyLogExists(vaultRoot: string): Promise<boolean> {
  return await fs
    .stat(resolveMemoryWikiLegacyLogPath(vaultRoot))
    .then((stat) => stat.isFile())
    .catch(() => false);
}

function resolveLegacyImportRunsDir(vaultRoot: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "import-runs");
}

async function listLegacyImportRunJsonFiles(vaultRoot: string): Promise<string[]> {
  const importRunsDir = resolveLegacyImportRunsDir(vaultRoot);
  const entries = await fs
    .readdir(importRunsDir, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(importRunsDir, entry.name))
    .toSorted((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function importLegacyImportRunJsonFiles(vaultRoot: string): Promise<{
  imported: number;
  warnings: string[];
}> {
  const warnings: string[] = [];
  let imported = 0;
  for (const filePath of await listLegacyImportRunJsonFiles(vaultRoot)) {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!isRecord(raw) || typeof raw.runId !== "string" || !raw.runId.trim()) {
      warnings.push(`Skipped invalid Memory Wiki import run file: ${filePath}`);
      continue;
    }
    await writeMemoryWikiImportRunRecord(vaultRoot, {
      ...raw,
      runId: raw.runId.trim(),
    });
    await fs.rm(filePath, { force: true });
    imported++;
  }
  return { imported, warnings };
}

export function createMemoryWikiSourceSyncMigrationProvider(
  config: ResolvedMemoryWikiConfig,
): MigrationProviderPlugin {
  const sourcePath = resolveMemoryWikiLegacySourceSyncStatePath(config.vault.path);
  const legacyLogPath = resolveMemoryWikiLegacyLogPath(config.vault.path);
  const importRunsDir = resolveLegacyImportRunsDir(config.vault.path);
  const target = "global SQLite plugin_state_entries(memory-wiki/source-sync)";
  const buildPlan: MigrationProviderPlugin["plan"] = async () => {
    const hasSourceSync = await legacySourceExists(config.vault.path);
    const hasLegacyLog = await legacyLogExists(config.vault.path);
    const importRunFiles = await listLegacyImportRunJsonFiles(config.vault.path);
    const items = [
      ...(hasSourceSync
        ? [
            createMigrationItem({
              id: "memory-wiki-source-sync-json",
              kind: "state",
              action: "import",
              source: sourcePath,
              target,
              message: "Import Memory Wiki source sync JSON into SQLite plugin state.",
            }),
          ]
        : []),
      ...(hasLegacyLog
        ? [
            createMigrationItem({
              id: "memory-wiki-log-jsonl",
              kind: "state",
              action: "import",
              source: legacyLogPath,
              target: "global SQLite plugin_state_entries(memory-wiki/activity-log)",
              message: "Import Memory Wiki activity log JSONL into SQLite plugin state.",
            }),
          ]
        : []),
      ...(importRunFiles.length > 0
        ? [
            createMigrationItem({
              id: "memory-wiki-import-runs-json",
              kind: "state",
              action: "import",
              source: importRunsDir,
              target: "global SQLite plugin_state_entries(memory-wiki/import-runs)",
              message: "Import Memory Wiki import-run JSON records into SQLite plugin state.",
              details: { recordCount: importRunFiles.length },
            }),
          ]
        : []),
    ];
    return {
      providerId: PROVIDER_ID,
      source: sourcePath,
      target,
      summary: summarizeMigrationItems(items),
      items,
    };
  };

  return {
    id: PROVIDER_ID,
    label: "Memory Wiki source sync state",
    description: "Import the legacy Memory Wiki source sync JSON ledger into SQLite plugin state.",
    async detect() {
      const found =
        (await legacySourceExists(config.vault.path)) ||
        (await legacyLogExists(config.vault.path)) ||
        (await listLegacyImportRunJsonFiles(config.vault.path)).length > 0;
      return {
        found,
        source: sourcePath,
        label: "Memory Wiki legacy state",
        confidence: found ? "high" : "low",
        message: found
          ? `Legacy Memory Wiki state found under ${path.dirname(sourcePath)}.`
          : "No legacy Memory Wiki state files found.",
      };
    },
    plan: buildPlan,
    async apply(_ctx, plan) {
      const selectedPlan = plan ?? (await buildPlan(_ctx));
      const items = [...selectedPlan.items];
      const warnings = [...(selectedPlan.warnings ?? [])];
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex];
        if (!item) {
          continue;
        }
        try {
          if (item.id === "memory-wiki-source-sync-json") {
            const result = await importMemoryWikiLegacySourceSyncState({
              vaultRoot: config.vault.path,
            });
            warnings.push(...result.warnings);
            items[itemIndex] = {
              ...item,
              status: "migrated",
              details: {
                imported: result.imported,
              },
            };
          } else if (item.id === "memory-wiki-log-jsonl") {
            const result = await importMemoryWikiLegacyLog({
              vaultRoot: config.vault.path,
            });
            warnings.push(...result.warnings);
            items[itemIndex] = {
              ...item,
              status: "migrated",
              details: {
                imported: result.imported,
              },
            };
          } else if (item.id === "memory-wiki-import-runs-json") {
            const result = await importLegacyImportRunJsonFiles(config.vault.path);
            warnings.push(...result.warnings);
            items[itemIndex] = {
              ...item,
              status: "migrated",
              details: {
                imported: result.imported,
              },
            };
          }
        } catch (error) {
          items[itemIndex] = {
            ...item,
            status: "error",
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }
      return {
        ...selectedPlan,
        summary: summarizeMigrationItems(items),
        items,
        warnings,
      };
    },
  };
}
