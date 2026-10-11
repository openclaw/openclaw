import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import * as migrationSdk from "openclaw/plugin-sdk/runtime-doctor-migrations";
import type {
  ChannelIngressLegacyEntry,
  PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeTelegramStateAccountId } from "./state-account-id.js";

type SpoolSource = {
  accountId: string;
  id: string;
  filePath: string;
  claimPaths: string[];
  failed: boolean;
};
type SourceBackup = Awaited<ReturnType<typeof migrationSdk.backupLegacyStateSource>>;

async function listSpoolSources(stateDir: string): Promise<SpoolSource[]> {
  const telegramDir = path.join(stateDir, "telegram");
  try {
    if (!(await fs.lstat(telegramDir)).isDirectory()) {
      throw new Error(`Telegram state must be a directory, not a link: ${telegramDir}`);
    }
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const sources: SpoolSource[] = [];
  for (const directory of await fs.readdir(telegramDir, { withFileTypes: true })) {
    if (!directory.name.startsWith("ingress-spool-")) {
      continue;
    }
    const accountId = directory.name.slice("ingress-spool-".length);
    if (!directory.isDirectory() || normalizeTelegramStateAccountId(accountId) !== accountId) {
      throw new Error(`Unsupported Telegram spool directory: ${directory.name}`);
    }
    const spoolDir = path.join(telegramDir, directory.name);
    const byName = new Map<string, SpoolSource>();
    for (const candidate of (await fs.readdir(spoolDir)).toSorted()) {
      const name = migrationSdk.resolveLegacyMigrationSourcePath?.(candidate) ?? candidate;
      const match = /^(\d{16})\.json(?:\.(processing|failed))?$/.exec(name);
      if (match) {
        const source = byName.get(name) ?? {
          accountId,
          id: match[1]!,
          filePath: path.join(spoolDir, name),
          claimPaths: [],
          failed: match[2] === "failed",
        };
        if (candidate !== name) {
          source.claimPaths.push(path.join(spoolDir, candidate));
        }
        byName.set(name, source);
      }
    }
    sources.push(...byName.values());
  }
  return sources;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseSource(source: SpoolSource, bytes: Buffer): ChannelIngressLegacyEntry {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isNonNegativeSafeInteger(value.updateId) ||
    String(value.updateId).padStart(16, "0") !== source.id ||
    !isNonNegativeSafeInteger(value.receivedAt)
  ) {
    throw new Error("invalid version, update ID, or receipt timestamp");
  }
  if (source.failed) {
    const failure = value.failure;
    if (
      !isRecord(failure) ||
      typeof failure.reason !== "string" ||
      !failure.reason ||
      typeof failure.message !== "string" ||
      !isNonNegativeSafeInteger(failure.failedAt)
    ) {
      throw new Error("invalid failure tombstone");
    }
    return {
      id: source.id,
      receivedAt: value.receivedAt,
      status: "failed",
      reason: failure.reason,
      message: failure.message,
      failedAt: failure.failedAt,
    };
  }
  if (!isRecord(value.update) || value.update.update_id !== value.updateId) {
    throw new Error("update payload does not match its spool ID");
  }
  return {
    id: source.id,
    receivedAt: value.receivedAt,
    status: "pending",
    payload: {
      version: 1,
      updateId: value.updateId,
      receivedAt: value.receivedAt,
      update: value.update,
    },
  };
}

export const telegramIngressSpoolMigration = {
  id: "telegram-json-ingress-spool",
  label: "Telegram JSON ingress spool",
  collectBackupResources: ({ stateDir }) => [
    { path: path.join(stateDir, "telegram"), kind: "directory" },
    { path: path.join(stateDir, "state", "openclaw.sqlite"), kind: "sqlite" },
  ],
  async detectLegacyState({ stateDir }) {
    const sources = await listSpoolSources(stateDir);
    return sources.length
      ? { preview: [`- Import ${sources.length} Telegram JSON spool file(s) into SQLite ingress`] }
      : null;
  },
  async migrateLegacyState({ stateDir, context }) {
    const changes: string[] = [];
    const warnings: string[] = [];
    let hasRefusal = false;
    const access = context.channelIngressQueues?.find((entry) => entry.channelId === "telegram");
    const { backupLegacyStateSource } = migrationSdk;
    if (!access?.importLegacyEntries || !access.assertCurrent || !backupLegacyStateSource) {
      return {
        changes,
        warnings: [
          "Telegram JSON spool import requires offline Doctor ingress access. Upgrade the host and run openclaw doctor --fix; legacy files remain unchanged.",
        ],
      };
    }
    const groups = new Map<string, SpoolSource[]>();
    for (const source of await listSpoolSources(stateDir)) {
      const key = JSON.stringify([source.accountId, source.id]);
      const group = groups.get(key) ?? [];
      group.push(source);
      groups.set(key, group);
    }
    for (const sources of groups.values()) {
      const first = sources[0]!;
      const backups: SourceBackup[] = [];
      try {
        const entries: ChannelIngressLegacyEntry[] = [];
        for (const source of sources) {
          const backup = await backupLegacyStateSource({
            filePath: source.filePath,
            claimPaths: source.claimPaths,
            assertCurrent: access.assertCurrent,
          });
          backups.push(backup);
          entries.push(parseSource(source, backup.bytes));
        }
        const pending = entries.filter((entry) => entry.status === "pending");
        const failed = entries.find((entry) => entry.status === "failed");
        if (
          pending.some((entry) => !isDeepStrictEqual(entry, pending[0])) ||
          (failed && pending.some((entry) => entry.receivedAt !== failed.receivedAt))
        ) {
          throw new Error("pending, processing, and failed sources disagree");
        }
        // A published failure tombstone suppresses pending crash leftovers; old process claims expire.
        const entry = failed ?? pending[0]!;
        for (const backup of backups) {
          backup.assertUnchanged();
        }
        const result = access.importLegacyEntries({
          accountId: first.accountId,
          entries: [
            {
              entry,
              sources: backups.map(({ snapshot }) => ({
                sourcePath: snapshot.sourcePath,
                sha256: snapshot.sha256,
                size: snapshot.size,
              })),
            },
          ],
        });
        if (result.conflicts.length) {
          throw new Error("current SQLite ingress contains a different event; kept both copies");
        }
        const imported = result.imported.includes(entry.id);
        if (!imported && !result.present.includes(entry.id)) {
          throw new Error("SQLite ingress import did not confirm a committed event or receipt");
        }
        let removedSources = 0;
        for (const backup of backups) {
          try {
            backup.removeSource(() => {
              result.markSourcesRemoved([backup.snapshot.sourcePath]);
            });
            removedSources++;
          } catch (error) {
            // Only verified cleanup debt is advisory; source drift and lost authority still refuse.
            access.assertCurrent();
            backup.assertBackupUnchanged();
            backup.assertUnchanged();
            warnings.push(
              `Retained Telegram spool source ${backup.snapshot.sourcePath}; cleanup remains incomplete after committed SQLite import: ${String(error)}. Verified backup: ${backup.backupPath}. Run openclaw doctor --fix to retry cleanup.`,
            );
          }
        }
        const outcome = imported
          ? `Imported Telegram spool ${first.accountId}/${first.id} as ${entry.status}`
          : removedSources === backups.length
            ? `Retired redundant Telegram spool source ${first.accountId}/${first.id}; preserved current ingress state and import history`
            : `Confirmed prior Telegram spool import ${first.accountId}/${first.id}; source cleanup remains pending`;
        changes.push(
          `${outcome}; original bytes: ${backups.map((backup) => backup.backupPath).join(", ")}`,
        );
      } catch (error) {
        hasRefusal = true;
        warnings.push(
          `Telegram spool migration incomplete for ${first.filePath}: ${String(error)}. Check retained sources and backups, resolve the reported failure, then run openclaw doctor --fix.`,
        );
      }
    }
    return {
      changes,
      warnings,
      ...(warnings.length > 0 && !hasRefusal ? { warningDisposition: "recoverable" as const } : {}),
    };
  },
} satisfies PluginDoctorStateMigration;
