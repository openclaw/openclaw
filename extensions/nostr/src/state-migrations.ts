import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import { upsertPluginStateMigrationEntry } from "openclaw/plugin-sdk/migration-runtime";
import {
  NOSTR_BUS_STATE_NAMESPACE,
  NOSTR_PROFILE_STATE_NAMESPACE,
  normalizeNostrStateAccountId,
  parseNostrBusStateJson,
  parseNostrProfileStateJson,
} from "./nostr-state-store.js";

const NOSTR_PLUGIN_ID = "nostr";

type LegacyNostrStateFile = {
  accountId: string;
  filePath: string;
  kind: "bus" | "profile";
};

function listLegacyNostrStateFiles(sourceDir: string): LegacyNostrStateFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: LegacyNostrStateFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const busMatch = /^bus-state-(.+)\.json$/u.exec(entry.name);
    if (busMatch?.[1]) {
      files.push({
        accountId: busMatch[1],
        filePath: path.join(sourceDir, entry.name),
        kind: "bus",
      });
      continue;
    }
    const profileMatch = /^profile-state-(.+)\.json$/u.exec(entry.name);
    if (profileMatch?.[1]) {
      files.push({
        accountId: profileMatch[1],
        filePath: path.join(sourceDir, entry.name),
        kind: "profile",
      });
    }
  }
  return files.toSorted((left, right) => left.filePath.localeCompare(right.filePath));
}

function removeEmptyDir(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    // Best effort: imported source files are removed individually.
  }
}

function importLegacyNostrStateFiles(
  sourceDir: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  let imported = 0;
  const warnings: string[] = [];
  for (const source of listLegacyNostrStateFiles(sourceDir)) {
    const raw = fs.readFileSync(source.filePath, "utf8");
    const accountId = normalizeNostrStateAccountId(source.accountId);
    if (source.kind === "bus") {
      const parsed = parseNostrBusStateJson(raw);
      if (!parsed) {
        warnings.push(`Skipped invalid Nostr bus state file: ${source.filePath}`);
        continue;
      }
      upsertPluginStateMigrationEntry({
        pluginId: NOSTR_PLUGIN_ID,
        namespace: NOSTR_BUS_STATE_NAMESPACE,
        key: accountId,
        value: parsed,
        createdAt: Date.now(),
        env,
      });
      imported++;
    } else {
      const parsed = parseNostrProfileStateJson(raw);
      if (!parsed) {
        warnings.push(`Skipped invalid Nostr profile state file: ${source.filePath}`);
        continue;
      }
      upsertPluginStateMigrationEntry({
        pluginId: NOSTR_PLUGIN_ID,
        namespace: NOSTR_PROFILE_STATE_NAMESPACE,
        key: accountId,
        value: parsed,
        createdAt: Date.now(),
        env,
      });
      imported++;
    }
    fs.rmSync(source.filePath, { force: true });
  }
  removeEmptyDir(sourceDir);
  return { imported, warnings };
}

export function detectNostrLegacyStateMigrations(params: {
  stateDir: string;
}): ChannelLegacyStateMigrationPlan[] {
  const sourceDir = path.join(params.stateDir, "nostr");
  const files = listLegacyNostrStateFiles(sourceDir);
  if (files.length === 0) {
    return [];
  }
  return [
    {
      kind: "custom",
      label: "Nostr runtime state",
      sourcePath: sourceDir,
      targetTable: `plugin_state_entries:${NOSTR_PLUGIN_ID}/${NOSTR_BUS_STATE_NAMESPACE}+${NOSTR_PROFILE_STATE_NAMESPACE}`,
      recordCount: files.length,
      apply: ({ env }) => {
        const result = importLegacyNostrStateFiles(sourceDir, env);
        return {
          changes: [
            `Imported ${result.imported} Nostr runtime state row(s) into SQLite plugin state (nostr/${NOSTR_BUS_STATE_NAMESPACE}, nostr/${NOSTR_PROFILE_STATE_NAMESPACE})`,
          ],
          warnings: result.warnings,
        };
      },
    },
  ];
}
