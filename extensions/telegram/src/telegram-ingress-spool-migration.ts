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
const LEGACY_UPDATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_LEGACY_REASON = "stale-legacy-import";

function updateTimestamp(update: unknown): number | undefined {
  if (!isRecord(update)) {
    return undefined;
  }
  const message = Object.values(update)
    .filter(isRecord)
    .find((value) => isNonNegativeSafeInteger(value.date));
  const date = message?.edit_date ?? message?.date;
  return isNonNegativeSafeInteger(date) && Number.isSafeInteger(date * 1000)
    ? date * 1000
    : undefined;
}

function legacyTimestamp(receivedAt: number, payload: unknown): number {
  return Math.min(
    receivedAt,
    updateTimestamp(isRecord(payload) ? payload.update : undefined) ?? receivedAt,
  );
}

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
      const name = migrationSdk.resolveLegacyMigrationSourcePath(candidate);
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
    String(value.updateId).padStart(16, "0") !== source.id
  ) {
    throw new Error("invalid version, update ID, or receipt timestamp");
  }
  const receivedAt = isNonNegativeSafeInteger(value.receivedAt)
    ? value.receivedAt
    : updateTimestamp(value.update);
  if (receivedAt === undefined) {
    throw new Error("invalid receipt timestamp");
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
      receivedAt,
      status: "failed",
      reason: failure.reason,
      message: failure.message,
      failedAt: failure.failedAt,
    };
  }
  if (!isRecord(value.update) || value.update.update_id !== value.updateId) {
    throw new Error("update payload does not match its spool ID");
  }
  // Unprocessed updates older than 24 hours are sacrificed rather than replaying stale instructions.
  if (legacyTimestamp(receivedAt, value) < Date.now() - LEGACY_UPDATE_MAX_AGE_MS) {
    return {
      id: source.id,
      receivedAt,
      status: "failed",
      reason: STALE_LEGACY_REASON,
      failedAt: Date.now(),
    };
  }
  return {
    id: source.id,
    receivedAt,
    status: "pending",
    payload: {
      version: 1,
      updateId: value.updateId,
      receivedAt,
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
  // Already-imported work drains immediately; accept rare stale pending rows rather than add a sweep.
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
    if (!access?.importLegacyEntries || !access.assertCurrent) {
      return {
        changes,
        warnings: [
          "Telegram JSON spool import requires offline Doctor ingress access. Upgrade the host and run openclaw doctor --fix; legacy files remain unchanged.",
        ],
      };
    }
    const staleDates: number[] = [];
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
        // Published failures suppress pending crash leftovers, including newly classified stale entries.
        const failed =
          entries.find((_, index) => sources[index]!.failed) ??
          entries.find((entry) => entry.status === "failed");
        if (
          pending.some((entry) => !isDeepStrictEqual(entry, pending[0])) ||
          (failed && pending.some((entry) => entry.receivedAt !== failed.receivedAt))
        ) {
          throw new Error("pending, processing, and failed sources disagree");
        }
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
        const stale = entry.status === "failed" && entry.reason === STALE_LEGACY_REASON;
        if (imported && stale) {
          staleDates.push(
            legacyTimestamp(entry.receivedAt, JSON.parse(backups[0]!.bytes.toString("utf8"))),
          );
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
        if (!stale) {
          changes.push(
            `${outcome}; original bytes: ${backups.map((backup) => backup.backupPath).join(", ")}`,
          );
        }
      } catch (error) {
        hasRefusal = true;
        warnings.push(
          `Telegram spool migration incomplete for ${first.filePath}: ${String(error)}. Check retained sources and backups, resolve the reported failure, then run openclaw doctor --fix.`,
        );
      }
    }
    if (staleDates.length) {
      staleDates.sort((a, b) => a - b);
      warnings.push(
        `Retired ${staleDates.length} stale legacy Telegram update(s) older than 24 hours as ${STALE_LEGACY_REASON}; oldest ${new Date(staleDates[0]!).toISOString()}, newest ${new Date(staleDates.at(-1)!).toISOString()}. Original bytes and import receipts are retained; these updates will not be dispatched.`,
      );
    }
    return {
      changes,
      warnings,
      ...(warnings.length > 0 && !hasRefusal ? { warningDisposition: "recoverable" as const } : {}),
    };
  },
} satisfies PluginDoctorStateMigration;
