// Migrate Hermes plugin module implements apply behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  markMigrationItemError,
  markMigrationItemSkipped,
  summarizeMigrationItems,
} from "openclaw/plugin-sdk/migration";
import {
  archiveMigrationItem,
  copyMigrationFileItem,
  withCachedMigrationConfigRuntime,
  writeMigrationReport,
} from "openclaw/plugin-sdk/migration-runtime";
import type {
  MigrationApplyResult,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { applyAuthItem } from "./auth.js";
import { applyConfigItem, applyManualItem } from "./config.js";
import { appendItem } from "./helpers.js";
import { applyModelItem } from "./model.js";
import { buildHermesPlan } from "./plan.js";
import { applySecretItem } from "./secrets.js";
import { resolveTargets } from "./targets.js";

const HERMES_REASON_BLOCKED_BY_APPLY_CONFLICT = "blocked by earlier apply conflict";
const HERMES_STATE_DB_ARCHIVE_ITEM_ID = "archive:state.db";
const HERMES_STATE_DB_SNAPSHOT_PREFIX = "openclaw-migrate-hermes-state-";

async function archiveHermesItem(item: MigrationItem, reportDir: string): Promise<MigrationItem> {
  if (item.id !== HERMES_STATE_DB_ARCHIVE_ITEM_ID || !item.source) {
    return await archiveMigrationItem(item, reportDir);
  }
  const sourcePath = item.source;

  let sourceStat: import("node:fs").Stats;
  try {
    sourceStat = await fs.lstat(sourcePath);
  } catch {
    return await archiveMigrationItem(item, reportDir);
  }
  if (!sourceStat.isFile()) {
    return await archiveMigrationItem(item, reportDir);
  }

  try {
    // A raw state.db copy can omit committed rows that still live in state.db-wal.
    // Snapshot the live database into one self-contained archive artifact.
    return await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: HERMES_STATE_DB_SNAPSHOT_PREFIX },
      async ({ dir: tempDir }) => {
        const snapshotPath = path.join(tempDir, "state.db");
        const { DatabaseSync } = await import("node:sqlite");
        const source = new DatabaseSync(sourcePath, { readOnly: true });
        try {
          source.exec("PRAGMA busy_timeout = 30000;");
          source.prepare("VACUUM INTO ?").run(snapshotPath);
        } finally {
          source.close();
        }
        await fs.chmod(snapshotPath, 0o600);
        const archived = await archiveMigrationItem({ ...item, source: snapshotPath }, reportDir);
        return { ...archived, source: sourcePath };
      },
    );
  } catch (err) {
    const snapshotReason = err instanceof Error ? err.message : String(err);
    const rawArchive = await archiveMigrationItem(item, reportDir);
    if (rawArchive.status === "migrated") {
      return markMigrationItemError(
        rawArchive,
        `SQLite snapshot failed; raw state.db preserved for manual review: ${snapshotReason}`,
      );
    }
    return markMigrationItemError(
      rawArchive,
      `SQLite snapshot failed: ${snapshotReason}; raw archive failed: ${rawArchive.reason ?? rawArchive.status}`,
    );
  }
}

export async function applyHermesPlan(params: {
  ctx: MigrationProviderContext;
  plan?: MigrationPlan;
  runtime?: MigrationProviderContext["runtime"];
}): Promise<MigrationApplyResult> {
  const plan = params.plan ?? (await buildHermesPlan(params.ctx));
  const reportDir = params.ctx.reportDir ?? path.join(params.ctx.stateDir, "migration", "hermes");
  const targets = resolveTargets(params.ctx);
  const items: MigrationItem[] = [];
  const runtime = withCachedMigrationConfigRuntime(
    params.ctx.runtime ?? params.runtime,
    params.ctx.config,
  );
  const applyCtx = { ...params.ctx, runtime };
  let blockedByApplyConflict = false;
  for (const item of plan.items) {
    if (item.status !== "planned") {
      items.push(item);
      continue;
    }
    if (blockedByApplyConflict) {
      items.push(markMigrationItemSkipped(item, HERMES_REASON_BLOCKED_BY_APPLY_CONFLICT));
      continue;
    }
    let appliedItem: MigrationItem;
    if (item.id === "config:default-model") {
      appliedItem = await applyModelItem(applyCtx, item);
    } else if (item.kind === "config") {
      appliedItem = await applyConfigItem(applyCtx, item);
    } else if (item.kind === "manual") {
      appliedItem = applyManualItem(item);
    } else if (item.action === "archive") {
      appliedItem = await archiveHermesItem(item, reportDir);
    } else if (item.kind === "auth") {
      appliedItem = await applyAuthItem(applyCtx, item, targets);
    } else if (item.kind === "secret") {
      appliedItem = await applySecretItem(applyCtx, item, targets);
    } else if (item.action === "append") {
      appliedItem = await appendItem(item);
    } else {
      appliedItem = await copyMigrationFileItem(item, reportDir, {
        overwrite: params.ctx.overwrite,
      });
    }
    items.push(appliedItem);
    if (
      item.kind === "config" &&
      (appliedItem.status === "conflict" || appliedItem.status === "error")
    ) {
      blockedByApplyConflict = true;
    }
  }
  const result: MigrationApplyResult = {
    ...plan,
    items,
    summary: summarizeMigrationItems(items),
    backupPath: params.ctx.backupPath,
    reportDir,
  };
  await writeMigrationReport(result, { title: "Hermes Migration Report" });
  return result;
}
