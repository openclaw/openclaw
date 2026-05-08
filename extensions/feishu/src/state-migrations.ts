import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import { upsertPluginStateMigrationEntry } from "openclaw/plugin-sdk/migration-runtime";

const FEISHU_PLUGIN_ID = "feishu";
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

type ImportResult = {
  imported: number;
  warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dedupeStoreKey(namespace: string, messageId: string): string {
  return createHash("sha256")
    .update(`${namespace}\0${messageId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function listDedupFiles(sourceDir: string): string[] {
  try {
    return fs
      .readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(sourceDir, entry.name))
      .toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function importDedupFiles(sourceDir: string, env: NodeJS.ProcessEnv): ImportResult {
  let imported = 0;
  const warnings: string[] = [];
  for (const filePath of listDedupFiles(sourceDir)) {
    const namespace = path.basename(filePath, ".json") || "global";
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(raw)) {
      warnings.push(`Skipped invalid Feishu dedupe cache file: ${filePath}`);
      continue;
    }
    for (const [messageId, seenAt] of Object.entries(raw)) {
      if (typeof seenAt !== "number" || !Number.isFinite(seenAt) || seenAt <= 0) {
        continue;
      }
      const createdAt = Math.floor(seenAt);
      upsertPluginStateMigrationEntry({
        pluginId: FEISHU_PLUGIN_ID,
        namespace: "dedup",
        key: dedupeStoreKey(namespace, messageId),
        value: { namespace, messageId, seenAt: createdAt },
        createdAt,
        expiresAt: createdAt + DEDUP_TTL_MS,
        env,
      });
      imported++;
    }
    fs.rmSync(filePath, { force: true });
  }
  try {
    fs.rmdirSync(sourceDir);
  } catch {
    // Best effort: only imported source files are removed.
  }
  return { imported, warnings };
}

export function detectFeishuLegacyStateMigrations(params: {
  stateDir: string;
}): ChannelLegacyStateMigrationPlan[] {
  const dedupDir = path.join(params.stateDir, "feishu", "dedup");
  if (listDedupFiles(dedupDir).length === 0) {
    return [];
  }
  return [
    {
      kind: "custom",
      label: "Feishu dedupe cache",
      sourcePath: dedupDir,
      targetTable: "plugin_state_entries:feishu/dedup",
      apply: ({ env }) => {
        const result = importDedupFiles(dedupDir, env);
        return {
          changes: [
            `Imported ${result.imported} Feishu dedupe cache row(s) into SQLite plugin state (feishu/dedup)`,
          ],
          warnings: result.warnings,
        };
      },
    },
  ];
}
