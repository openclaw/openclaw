// Continuation (karmaterminal): pre-deploy custody for shutdown quiet kills (🌊's ruling on upstream
// #201544, item 4; openclaw/openclaw#129388). Before #201544 a graceful shutdown ended a live child
// as a quiet kill. On its first boot, upstream #201706's restore re-owes every such row still
// pending (isUnrepairedShutdownQuietKill), so a row an older restart left behind reaches its
// requester late, as a surprise. These offline operations count those rows read-only, settle the
// ones that ended before an explicit cutoff as an intentional non-delivery after writing a backup,
// and undo a settle from that backup. They never delete a row or start a turn; the operator surface
// (`openclaw continuations`) runs them only while no Gateway owns the state.
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../../../config/paths.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync } from "../../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import { isUnrepairedShutdownQuietKill } from "./subagent-registry-restore-metadata.js";
import { bindSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "./subagent-registry.store.kernel.js";
import type { SubagentRunSqliteRow } from "./subagent-registry.store.row.js";
import {
  loadSubagentMaintenanceRunsInDatabase,
  loadSubagentRunsByIdsInDatabase,
  readSubagentRunRow,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const BACKUP_KIND = "openclaw.subagent-shutdown-notice-settle";

export type ShutdownNoticeRow = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  /** A continuation delegate, as opposed to a plain sub-agent. */
  delegate: boolean;
  endedAt?: number;
};

export type ShutdownNoticeStatus = {
  databasePath: string;
  /** Rows the next boot's restore would re-owe as a late `Gateway stopped` notice. */
  reowed: number;
  rows: ShutdownNoticeRow[];
};

export type ShutdownNoticeSettleReceipt = {
  databasePath: string;
  endedBefore: number;
  /** The rows exactly as they were, with what this settle wrote; the undo reads it. */
  backupPath: string;
  settled: ShutdownNoticeRow[];
  /** Re-owed rows that ended at or after the cutoff; restore still delivers them. */
  kept: ShutdownNoticeRow[];
  /** Rows that changed between the backup and the write; left as they are. */
  changed: string[];
};

export type ShutdownNoticeUndoReceipt = {
  databasePath: string;
  backupPath: string;
  restored: string[];
  /** Rows no longer as the settle wrote them; left as they are. */
  changed: string[];
};

type BackupRow = { original: SubagentRunSqliteRow; settledPayloadJson: string };

function toNoticeRow(entry: SubagentRunRecord): ShutdownNoticeRow {
  return {
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
    delegate: entry.drainsContinuationDelegateQueue === true,
    endedAt: entry.execution.endedAt,
  };
}

/** What restore re-owes: the quiet kill, on a row whose authority restore does not skip. */
function selectReowedRuns(database: Pick<OpenClawStateDatabase, "db">): SubagentRunRecord[] {
  // The maintenance projection omits the outcome, so it only narrows the full read.
  const candidates = [...loadSubagentMaintenanceRunsInDatabase(database).values()]
    .filter((run) => run.delivery?.status === "pending" && run.killReconciliation !== undefined)
    .map((run) => run.runId);
  return [...loadSubagentRunsByIdsInDatabase(database, candidates).values()]
    .filter(
      (entry) =>
        resolveSubagentChildAuthority(entry).status !== "mismatch" &&
        isUnrepairedShutdownQuietKill(entry),
    )
    .toSorted((a, b) => (a.execution.endedAt ?? 0) - (b.execution.endedAt ?? 0));
}

/** The settled row: closed as an intentional non-delivery, so restore no longer re-owes it. */
function settleRun(entry: SubagentRunRecord): SubagentRunRecord {
  return {
    ...entry,
    suppressCompletionDelivery: true,
    delivery: {
      ...entry.delivery,
      status: "not_required",
      disposition: "intentional_non_delivery",
    },
  };
}

async function readReowedRuns(env: NodeJS.ProcessEnv) {
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const read = await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
    (database) =>
      selectReowedRuns(database).map((entry) => ({
        entry,
        row: readSubagentRunRow(database, entry.runId)!,
      })),
    { env },
  );
  if (!read) {
    throw new Error(`No OpenClaw state database at ${databasePath}; nothing was read or changed.`);
  }
  return { databasePath, read };
}

/** Read-only: lists the stopped store through a snapshot, never a writer. */
export async function readShutdownNoticeStatus(
  env: NodeJS.ProcessEnv,
): Promise<ShutdownNoticeStatus> {
  const { databasePath, read } = await readReowedRuns(env);
  return {
    databasePath,
    reowed: read.length,
    rows: read.map(({ entry }) => toNoticeRow(entry)),
  };
}

/**
 * Offline only. Writes every re-owed row that ended before the cutoff to a new backup file
 * (fsynced), then closes each one whose stored row is still the one backed up. A second run finds
 * nothing to settle.
 */
export async function settleShutdownNotices(
  env: NodeJS.ProcessEnv,
  params: { endedBefore: number },
): Promise<ShutdownNoticeSettleReceipt> {
  const { databasePath, read } = await readReowedRuns(env);
  const due = read.filter(({ entry }) => (entry.execution.endedAt ?? 0) < params.endedBefore);
  const kept = read.filter((planned) => !due.includes(planned)).map(({ entry }) => entry);
  const planned = due.map(({ entry, row }) => ({
    entry,
    original: row,
    postimage: bindSubagentRunRecord(settleRun(entry)),
  }));
  const createdAt = Date.now();
  const backupPath = path.join(
    resolveStateDir(env),
    "backups",
    "subagent-shutdown-notices",
    `settle-${new Date(createdAt).toISOString().replaceAll(":", "-")}-${process.pid}.json`,
  );
  const backupRows: BackupRow[] = planned.map(({ original, postimage }) => ({
    original,
    settledPayloadJson: postimage.payload_json,
  }));
  await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  {
    await using handle = await fs.open(backupPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify(
        {
          kind: BACKUP_KIND,
          version: 1,
          databasePath,
          endedBefore: params.endedBefore,
          createdAt,
          rows: backupRows,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await handle.sync();
  }
  const changed: string[] = [];
  const settled = runOpenClawStateWriteTransaction(
    (database) =>
      planned.flatMap(({ entry, original, postimage }) => {
        if (readSubagentRunRow(database, entry.runId)?.payload_json !== original.payload_json) {
          changed.push(entry.runId);
          return [];
        }
        writeSubagentRunValuesInDatabase(database, [postimage], []);
        return [toNoticeRow(entry)];
      }),
    { env },
  );
  return {
    databasePath,
    endedBefore: params.endedBefore,
    backupPath,
    settled,
    kept: kept.map(toNoticeRow),
    changed,
  };
}

function parseBackupRow(value: unknown): BackupRow | undefined {
  if (!isRecord(value) || typeof value.settledPayloadJson !== "string") {
    return undefined;
  }
  const original = value.original;
  const optionalText = (field: unknown) => field === null || typeof field === "string";
  if (
    !isRecord(original) ||
    typeof original.run_id !== "string" ||
    typeof original.child_session_key !== "string" ||
    typeof original.requester_session_key !== "string" ||
    typeof original.created_at !== "number" ||
    typeof original.payload_json !== "string" ||
    !optionalText(original.controller_session_key) ||
    !optionalText(original.requester_store_path ?? null) ||
    !optionalText(original.controller_store_path ?? null)
  ) {
    return undefined;
  }
  return {
    original: original as SubagentRunSqliteRow,
    settledPayloadJson: value.settledPayloadJson,
  };
}

/**
 * Offline only. Puts back each backed-up row whose stored row is still exactly what the settle
 * wrote. The next boot's restore then re-owes it, as it would have without the settle.
 */
export async function undoShutdownNoticeSettle(
  env: NodeJS.ProcessEnv,
  backupPath: string,
): Promise<ShutdownNoticeUndoReceipt> {
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const notBackup = new Error(
    `${backupPath} is not a subagent shutdown-notice settle backup; nothing was changed.`,
  );
  let backup: unknown;
  try {
    backup = JSON.parse(await fs.readFile(backupPath, "utf8"));
  } catch (error) {
    throw Object.assign(notBackup, { cause: error });
  }
  if (
    !isRecord(backup) ||
    backup.kind !== BACKUP_KIND ||
    backup.version !== 1 ||
    !Array.isArray(backup.rows)
  ) {
    throw notBackup;
  }
  const rows = backup.rows.map(parseBackupRow).filter((row) => row !== undefined);
  if (rows.length !== backup.rows.length) {
    throw notBackup;
  }
  if (backup.databasePath !== databasePath) {
    throw new Error(
      `${backupPath} was written for ${String(backup.databasePath)}, not ${databasePath}; nothing was changed. Run this with the seat's service environment.`,
    );
  }
  const changed: string[] = [];
  const restored = runOpenClawStateWriteTransaction(
    (database) =>
      rows.flatMap(({ original, settledPayloadJson }) => {
        if (readSubagentRunRow(database, original.run_id)?.payload_json !== settledPayloadJson) {
          changed.push(original.run_id);
          return [];
        }
        writeSubagentRunValuesInDatabase(database, [original], []);
        return [original.run_id];
      }),
    { env },
  );
  return { databasePath, backupPath, restored, changed };
}
