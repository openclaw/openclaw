import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describeRetiredMatrixState } from "../retired-state.js";
import { walkMatrixStateFiles } from "../state-layout-walk.js";

const LEGACY_SQLITE_NAMESPACE = "inbound-dedupe";
const LEGACY_MARKERS_NAMESPACE = "inbound-dedupe-migrations";
const MATRIX_PLUGIN_ID = "matrix";
const MIGRATION_COMPLETION_NAMESPACE = "inbound-dedupe-migration-state";
const MIGRATION_COMPLETION_KEY = "sqlite-json-to-claimable-v1";
const STATE_DATABASE_RELATIVE_PATH = path.join("state", "openclaw.sqlite");

const MATRIX_LEGACY_INBOUND_DEDUPE_FILENAME = "inbound-dedupe.json";

export type LegacyInboundDedupeMarker = {
  accountId: string;
  roomId: string;
  eventId: string;
  ts: number;
};

type MatrixInboundDedupeSourceRoots = {
  sqliteRoots: string[];
};

type MatrixInboundDedupeSourceCensus =
  | ({ status: "complete" } & MatrixInboundDedupeSourceRoots)
  | ({ status: "incomplete"; warnings: string[] } & MatrixInboundDedupeSourceRoots);

type LegacySqliteRow = {
  namespace: string;
  entry_key: string;
  value_json: string;
  expires_at: number | bigint | null;
};

type MatrixInboundDedupeMigrationCompletion = {
  version: 1;
  completedAt: number;
};

function openMatrixInboundDedupeMigrationCompletionStore(
  context: PluginDoctorStateMigrationContext,
  env: NodeJS.ProcessEnv,
) {
  return context.openPluginStateKeyedStore<MatrixInboundDedupeMigrationCompletion>({
    namespace: MIGRATION_COMPLETION_NAMESPACE,
    maxEntries: 4,
    overflowPolicy: "reject-new",
    env,
  });
}

export async function hasCompletedMatrixInboundDedupeMigration(
  context: PluginDoctorStateMigrationContext,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const marker = await openMatrixInboundDedupeMigrationCompletionStore(context, env).lookup(
    MIGRATION_COMPLETION_KEY,
  );
  return (
    isRecord(marker) &&
    marker.version === 1 &&
    typeof marker.completedAt === "number" &&
    Number.isFinite(marker.completedAt) &&
    marker.completedAt >= 0
  );
}

export async function recordMatrixInboundDedupeMigrationCompletion(
  context: PluginDoctorStateMigrationContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await openMatrixInboundDedupeMigrationCompletionStore(context, env).register(
    MIGRATION_COMPLETION_KEY,
    { version: 1, completedAt: Date.now() },
  );
}

export async function collectMatrixInboundDedupeSources(
  stateDir: string,
): Promise<MatrixInboundDedupeSourceCensus> {
  const matrixRoot = path.resolve(stateDir, "matrix");
  const sqliteRoots = new Set<string>();
  const { entries, failedDirs } = await walkMatrixStateFiles(
    stateDir,
    (name, depth) =>
      ((depth === 0 || depth === 2 || depth === 4) &&
        name === MATRIX_LEGACY_INBOUND_DEDUPE_FILENAME) ||
      (depth === 5 && name === "openclaw.sqlite"),
    [0, 2, 4],
  );
  for (const entry of entries) {
    if (entry.name === MATRIX_LEGACY_INBOUND_DEDUPE_FILENAME) {
      throw new Error(describeRetiredMatrixState(entry.path));
    } else {
      sqliteRoots.add(path.dirname(path.dirname(entry.path)));
    }
  }
  const warnings = failedDirs.map(
    ({ path: directory, error }) =>
      `Failed scanning Matrix inbound dedupe sources under ${directory}: ${String(error)}`,
  );
  const isAccountRoot = (root: string) => root !== matrixRoot;
  const roots = {
    sqliteRoots: [...sqliteRoots].filter(isAccountRoot).toSorted(),
  };
  return warnings.length === 0
    ? { status: "complete", ...roots }
    : { status: "incomplete", ...roots, warnings };
}

function selectLegacySqliteRows(db: DatabaseSync): LegacySqliteRow[] {
  const table = db
    .prepare(
      `SELECT 1 AS present
       FROM sqlite_master
       WHERE type = 'table' AND name = 'plugin_state_entries'`,
    )
    .get();
  if (!table) {
    return [];
  }
  return db
    .prepare(
      `SELECT namespace, entry_key, value_json, expires_at
       FROM plugin_state_entries
       WHERE plugin_id = ? AND namespace IN (?, ?)
       ORDER BY namespace ASC, created_at ASC, entry_key ASC`,
    )
    .all(MATRIX_PLUGIN_ID, LEGACY_SQLITE_NAMESPACE, LEGACY_MARKERS_NAMESPACE) as LegacySqliteRow[];
}

function isLegacySqliteRowExpired(row: LegacySqliteRow, now: number): boolean {
  if (typeof row.expires_at === "bigint") {
    return row.expires_at <= BigInt(now);
  }
  return row.expires_at !== null && row.expires_at <= now;
}

function normalizeLegacyTimestamp(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return Math.max(0, Math.floor(raw));
}

function parseLegacySqliteRow(row: {
  key: string;
  value: unknown;
}): LegacyInboundDedupeMarker | null {
  const value = isRecord(row.value) ? row.value : {};
  const roomId = typeof value.roomId === "string" ? value.roomId.trim() : "";
  const eventId = typeof value.eventId === "string" ? value.eventId.trim() : "";
  const ts = normalizeLegacyTimestamp(value.ts);
  const separator = row.key.lastIndexOf(":");
  if (!roomId || !eventId || ts === null || separator <= 0) {
    return null;
  }
  const accountId = row.key.slice(0, separator);
  // Legacy keys embed sha256(accountId\0roomId\0eventId); recomputing it
  // validates the account-prefix parse and drops corrupt rows, mirroring the
  // retired runtime loader's expected-key check.
  const digest = createHash("sha256")
    .update(accountId)
    .update("\0")
    .update(roomId)
    .update("\0")
    .update(eventId)
    .digest("hex");
  if (row.key.slice(separator + 1) !== digest) {
    return null;
  }
  return { accountId, roomId, eventId, ts };
}

/**
 * Reads one storage root's legacy SQLite dedupe rows without opening it through
 * the current state runtime. Historical per-account databases can predate the
 * current core schema, and detection must not upgrade them merely to inspect
 * these retired plugin-state namespaces.
 */
export async function readLegacyInboundDedupeSqliteSource(
  storageRootDir: string,
): Promise<{ markers: LegacyInboundDedupeMarker[]; legacyRowCount: number }> {
  const { openNodeSqliteDatabase } = await import("openclaw/plugin-sdk/sqlite-worker-runtime");
  const databasePath = path.join(storageRootDir, STATE_DATABASE_RELATIVE_PATH);
  const db = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    const rows = selectLegacySqliteRows(db);
    const markers: LegacyInboundDedupeMarker[] = [];
    const now = Date.now();
    for (const row of rows) {
      // The keyed-store reader filtered expired rows before decoding them. We
      // still count that residue so doctor can retire it, but it has no replay
      // value and malformed expired JSON must not block the whole root.
      if (isLegacySqliteRowExpired(row, now)) {
        continue;
      }
      // The keyed-store reader parsed every value, including import-marker
      // values. Keep that fail-closed behavior so corrupt sources are not
      // retired unread.
      const value = JSON.parse(row.value_json) as unknown;
      if (row.namespace !== LEGACY_SQLITE_NAMESPACE) {
        continue;
      }
      const marker = parseLegacySqliteRow({ key: row.entry_key, value });
      if (marker) {
        markers.push(marker);
      }
    }
    return { markers, legacyRowCount: rows.length };
  } finally {
    db.close();
  }
}

/** Deletes only the two retired Matrix namespaces after a successful import. */
export async function retireLegacyInboundDedupeSqliteRows(storageRootDir: string): Promise<void> {
  const { openNodeSqliteDatabase, runSqliteImmediateTransactionSync } =
    await import("openclaw/plugin-sdk/sqlite-worker-runtime");
  const databasePath = path.join(storageRootDir, STATE_DATABASE_RELATIVE_PATH);
  const db = openNodeSqliteDatabase(databasePath);
  try {
    // Plan outside the write transaction, then re-read after BEGIN IMMEDIATE
    // before deleting. The predicates intentionally cannot touch other Matrix
    // namespaces or another plugin's rows.
    if (selectLegacySqliteRows(db).length === 0) {
      return;
    }
    runSqliteImmediateTransactionSync(db, () => {
      if (selectLegacySqliteRows(db).length === 0) {
        return;
      }
      db.prepare(
        `DELETE FROM plugin_state_entries
         WHERE plugin_id = ? AND namespace IN (?, ?)`,
      ).run(MATRIX_PLUGIN_ID, LEGACY_SQLITE_NAMESPACE, LEGACY_MARKERS_NAMESPACE);
    });
  } finally {
    db.close();
  }
}

/** Import committed replay markers as ingress tombstones without replaying payloads. */
export async function importInboundDedupeMarkersToIngress(params: {
  context: PluginDoctorStateMigrationContext;
  markers: Iterable<LegacyInboundDedupeMarker>;
  now?: number;
}): Promise<{ imported: number; total: number }> {
  const openQueue = resolveMatrixIngressQueueOpener(params.context);
  const queues = new Map<string, ReturnType<typeof openQueue>>();
  const now = params.now ?? Date.now();
  const newestByKey = new Map<string, LegacyInboundDedupeMarker>();
  for (const marker of params.markers) {
    const accountId = marker.accountId.trim() || "default";
    const eventId = marker.eventId.trim();
    if (!marker.roomId.trim() || !eventId) {
      continue;
    }
    const key = JSON.stringify([accountId, eventId]);
    const existing = newestByKey.get(key);
    if (!existing || marker.ts > existing.ts) {
      newestByKey.set(key, { ...marker, accountId, eventId });
    }
  }
  let imported = 0;
  for (const marker of newestByKey.values()) {
    if (now - marker.ts >= MATRIX_INBOUND_DEDUPE_TTL_MS) {
      continue;
    }
    let queue = queues.get(marker.accountId);
    if (!queue) {
      queue = openQueue({ accountId: marker.accountId });
      queues.set(marker.accountId, queue);
    }
    // Existing ingress claims and terminal rows already own this event identity.
    // complete(id) creates only an absent tombstone or settles a pending replay.
    if (await queue.complete(marker.eventId, { completedAt: marker.ts })) {
      imported++;
    }
  }
  return { imported, total: newestByKey.size };
}

function resolveMatrixIngressQueueOpener(context: PluginDoctorStateMigrationContext) {
  const openQueue = context.channelIngressQueues?.find(
    (entry) => entry.channelId === "matrix",
  )?.openChannelIngressQueue;
  if (!openQueue) {
    throw new Error("Matrix ingress migration requires the host-owned ingress queue");
  }
  return openQueue;
}

// These are the released replay guard's persisted namespace and retention, kept
// only to move its committed identities into the ingress owner's tombstones.
const MATRIX_INBOUND_DEDUPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MATRIX_INBOUND_DEDUPE_STATE_MAX_ENTRIES = 20_000;
const MATRIX_INBOUND_DEDUPE_STATE_NAMESPACE = `matrix.inbound-dedupe.${createHash("sha256").update("global").digest("hex").slice(0, 32)}`;

function readReplayGuardRows(context: PluginDoctorStateMigrationContext) {
  const read = context.readPluginStateEntriesInKeyRange;
  if (!read) {
    throw new Error("Matrix ingress migration requires the host-owned plugin-state reader");
  }
  const rows: ReturnType<typeof read> = [];
  let after: string | undefined;
  for (;;) {
    const batch = read(MATRIX_INBOUND_DEDUPE_STATE_NAMESPACE, { prefix: "", after, limit: 512 });
    rows.push(...batch);
    const last = batch.at(-1);
    if (batch.length < 512 || !last) {
      return rows;
    }
    after = last.key;
  }
}

function parseReplayGuardMarker(value: unknown): LegacyInboundDedupeMarker | null {
  if (!isRecord(value) || typeof value.key !== "string") {
    return null;
  }
  const [accountId, roomId, eventId, extra] = value.key.split("\0");
  const ts = normalizeLegacyTimestamp(value.seenAt);
  return accountId && roomId && eventId && extra === undefined && ts !== null
    ? { accountId, roomId, eventId, ts }
    : null;
}

export const matrixReplayGuardIngressMigration: PluginDoctorStateMigration = {
  id: "matrix-replay-guard-to-ingress",
  label: "Matrix inbound replay markers",
  collectBackupResources: () => [],
  detectLegacyState({ context }) {
    return readReplayGuardRows(context).length > 0
      ? { preview: ["Move committed Matrix event identities into the durable ingress spool."] }
      : null;
  },
  async migrateLegacyState({ context, env }) {
    const rows = readReplayGuardRows(context);
    if (rows.length === 0) {
      return { changes: [], warnings: [] };
    }
    // Only rows carrying a usable replay identity can become tombstones.
    const markers = rows.flatMap((row) => {
      const marker = parseReplayGuardMarker(row.value);
      return marker ? [marker] : [];
    });
    const result = await importInboundDedupeMarkersToIngress({
      context,
      markers,
    });
    const store = context.openPluginStateKeyedStore({
      namespace: MATRIX_INBOUND_DEDUPE_STATE_NAMESPACE,
      maxEntries: MATRIX_INBOUND_DEDUPE_STATE_MAX_ENTRIES,
      defaultTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
      env,
    });
    // Startup migrations hold exclusive state ownership. Delete sources only
    // after every tombstone persisted so interruption can retry idempotently.
    for (const row of rows) {
      await store.delete(row.key);
    }
    return {
      changes: [
        `Migrated Matrix replay markers to the durable ingress spool (${result.imported} of ${result.total} entries)`,
      ],
      warnings: [],
    };
  },
};
