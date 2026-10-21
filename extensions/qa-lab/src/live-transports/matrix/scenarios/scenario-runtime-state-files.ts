import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { findFilesByName } from "./scenario-runtime-find-files.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

const MATRIX_PLUGIN_ID = "matrix";
const MATRIX_SYNC_CACHE_NAMESPACE = "sync-cache";
const MATRIX_STATE_POLL_INTERVAL_MS = 100;
const MATRIX_SYNC_CACHE_MAX_ENTRIES = 20_000;
const MATRIX_SYNC_CACHE_MAX_CHUNKS = Math.floor((MATRIX_SYNC_CACHE_MAX_ENTRIES - 1) / 2);
// PluginState serializes this string inside a row object; 24KB leaves room for JSON escaping.
const MATRIX_SYNC_CACHE_CHUNK_BYTES = 24_000;

type MatrixSyncStoreCursor = {
  cursor: string;
  pathname: string;
  stateKey: string;
};

type MatrixStateIdentity = { accountId: string; userId: string };

function parsePluginStateJson(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function readMatrixSyncCacheFromRows(rows: Array<{ entryKey?: unknown; valueJson?: unknown }>) {
  const rowsByKey = new Map<string, unknown>();
  for (const row of rows) {
    if (typeof row.entryKey === "string") {
      rowsByKey.set(row.entryKey, parsePluginStateJson(row.valueJson));
    }
  }
  const entries: Array<{
    cursor: string;
    stateKey: string;
    sync: Record<string, unknown>;
  }> = [];
  for (const [entryKey, rawMeta] of rowsByKey) {
    if (!entryKey.endsWith(":meta") || !isRecord(rawMeta) || rawMeta.kind !== "meta") {
      continue;
    }
    const stateKey = entryKey.slice(0, -":meta".length);
    const generation = typeof rawMeta.generation === "string" ? rawMeta.generation : "";
    const chunkCount =
      typeof rawMeta.chunkCount === "number" &&
      Number.isSafeInteger(rawMeta.chunkCount) &&
      rawMeta.chunkCount <= MATRIX_SYNC_CACHE_MAX_CHUNKS
        ? rawMeta.chunkCount
        : 0;
    const chunks: string[] = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = rowsByKey.get(`${stateKey}:sync:${generation}:${index}`);
      if (!isRecord(chunk) || typeof chunk.data !== "string") {
        chunks.length = 0;
        break;
      }
      chunks.push(chunk.data);
    }
    if (chunks.length === 0) {
      continue;
    }
    try {
      const sync: unknown = JSON.parse(chunks.join(""));
      if (isRecord(sync) && typeof sync.nextBatch === "string" && sync.nextBatch) {
        entries.push({ cursor: sync.nextBatch, stateKey, sync });
      }
    } catch {
      continue;
    }
  }
  return entries;
}

async function readMatrixSyncCacheCursorsFromSqlite(
  params: MatrixStateIdentity & { stateDir: string },
): Promise<MatrixSyncStoreCursor[]> {
  const databasePaths = await findFilesByName({
    filename: "openclaw.sqlite",
    rootDir: params.stateDir,
    maxDepth: 10,
  });
  const cursors: MatrixSyncStoreCursor[] = [];
  for (const databasePath of databasePaths) {
    try {
      const db = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        const metadata = readMatrixStorageMetadata(db);
        if (!matchesMatrixStateIdentity(metadata, params)) {
          continue;
        }
        const rows = db
          .prepare(
            `SELECT entry_key AS entryKey, value_json AS valueJson
                 FROM plugin_state_entries
                WHERE plugin_id = ?
                  AND namespace = ?
                  AND (expires_at IS NULL OR expires_at > ?)`,
          )
          .all(MATRIX_PLUGIN_ID, MATRIX_SYNC_CACHE_NAMESPACE, Date.now()) as Array<{
          entryKey?: unknown;
          valueJson?: unknown;
        }>;
        for (const { cursor, stateKey } of readMatrixSyncCacheFromRows(rows)) {
          cursors.push({ cursor, pathname: databasePath, stateKey });
        }
      } finally {
        db.close();
      }
    } catch {
      continue;
    }
  }
  return cursors;
}

function chunkMatrixSyncCacheJson(value: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current && currentBytes + charBytes > MATRIX_SYNC_CACHE_CHUNK_BYTES) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

export async function rewriteMatrixSyncStoreCursor(params: {
  cursor: string;
  pathname: string;
  stateKey: string;
}) {
  const db = openNodeSqliteDatabase(params.pathname);
  try {
    const rows = db
      .prepare(
        `SELECT entry_key AS entryKey, value_json AS valueJson
           FROM plugin_state_entries
          WHERE plugin_id = ?
            AND namespace = ?
            AND entry_key LIKE ?`,
      )
      .all(MATRIX_PLUGIN_ID, MATRIX_SYNC_CACHE_NAMESPACE, `${params.stateKey}:%`) as Array<{
      entryKey?: unknown;
      valueJson?: unknown;
    }>;
    const meta = parsePluginStateJson(
      rows.find((row) => row.entryKey === `${params.stateKey}:meta`)?.valueJson,
    );
    if (!isRecord(meta)) {
      throw new Error("Matrix sync cache metadata row was missing");
    }
    const cursorEntry = readMatrixSyncCacheFromRows(rows).find(
      (entry) => entry.stateKey === params.stateKey,
    );
    if (!cursorEntry) {
      throw new Error("Matrix sync cache did not contain a persisted sync cursor");
    }
    const syncJson = JSON.stringify({ ...cursorEntry.sync, nextBatch: params.cursor });
    const nextGeneration = randomUUID().replaceAll("-", "");
    const nextChunks = chunkMatrixSyncCacheJson(syncJson);
    const now = Date.now();
    const upsert = db.prepare(
      `INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(plugin_id, namespace, entry_key)
       DO UPDATE SET value_json = excluded.value_json, created_at = excluded.created_at, expires_at = NULL`,
    );
    for (const [index, data] of nextChunks.entries()) {
      upsert.run(
        MATRIX_PLUGIN_ID,
        MATRIX_SYNC_CACHE_NAMESPACE,
        `${params.stateKey}:sync:${nextGeneration}:${index}`,
        JSON.stringify({ kind: "sync-chunk", index, data }),
        now,
      );
    }
    upsert.run(
      MATRIX_PLUGIN_ID,
      MATRIX_SYNC_CACHE_NAMESPACE,
      `${params.stateKey}:meta`,
      JSON.stringify({
        ...meta,
        generation: nextGeneration,
        chunkCount: nextChunks.length,
        syncDigest: createHash("sha256").update(syncJson, "utf8").digest("hex"),
      }),
      now,
    );
    db.prepare(
      `DELETE FROM plugin_state_entries
        WHERE plugin_id = ?
          AND namespace = ?
          AND entry_key LIKE ?
          AND entry_key NOT LIKE ?`,
    ).run(
      MATRIX_PLUGIN_ID,
      MATRIX_SYNC_CACHE_NAMESPACE,
      `${params.stateKey}:sync:%`,
      `${params.stateKey}:sync:${nextGeneration}:%`,
    );
  } finally {
    db.close();
  }
}

export async function deleteMatrixSyncStoreCursor(params: MatrixSyncStoreCursor) {
  const db = openNodeSqliteDatabase(params.pathname);
  try {
    db.prepare(
      `DELETE FROM plugin_state_entries
        WHERE plugin_id = ?
          AND namespace = ?
          AND (entry_key = ? OR entry_key LIKE ?)`,
    ).run(
      MATRIX_PLUGIN_ID,
      MATRIX_SYNC_CACHE_NAMESPACE,
      `${params.stateKey}:meta`,
      `${params.stateKey}:sync:%`,
    );
  } finally {
    db.close();
  }
}

function readMatrixStorageMetadata(db: ReturnType<typeof openNodeSqliteDatabase>): unknown {
  const row = db
    .prepare(
      `SELECT value_json AS valueJson FROM plugin_state_entries
          WHERE plugin_id = ? AND namespace = ? AND entry_key = ?
            AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(MATRIX_PLUGIN_ID, "storage-meta", "current", Date.now());
  return row ? parsePluginStateJson(row.valueJson) : undefined;
}

function matchesMatrixStateIdentity(metadata: unknown, identity: MatrixStateIdentity): boolean {
  return (
    isRecord(metadata) &&
    metadata.accountId === identity.accountId &&
    metadata.userId === identity.userId
  );
}

export async function waitForMatrixSyncStoreWithCursor(params: {
  accountId?: string;
  context: MatrixQaScenarioContext;
  stateDir: string;
  timeoutMs: number;
  userId?: string;
}) {
  const startedAt = Date.now();
  const identity = {
    accountId: params.accountId ?? params.context.sutAccountId ?? DEFAULT_ACCOUNT_ID,
    userId: params.userId ?? params.context.sutUserId,
  };
  while (Date.now() - startedAt < params.timeoutMs) {
    const [sqliteCursor] = await readMatrixSyncCacheCursorsFromSqlite({
      ...identity,
      stateDir: params.stateDir,
    });
    if (sqliteCursor) {
      return sqliteCursor;
    }
    await sleep(MATRIX_STATE_POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for Matrix sync store cursor under ${params.stateDir}`);
}

async function hasPersistedMatrixIngressCompletion(params: {
  accountId: string;
  eventId: string;
  stateDir: string;
}): Promise<string | null> {
  const databasePaths = await findFilesByName({
    filename: "openclaw.sqlite",
    rootDir: params.stateDir,
    maxDepth: 10,
  });
  for (const databasePath of databasePaths) {
    try {
      const db = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        const completed = db
          .prepare(
            `SELECT 1 FROM channel_ingress_events
              WHERE channel_id = ? AND account_id = ? AND event_id = ?
                AND status = 'completed'
              LIMIT 1`,
          )
          .get(MATRIX_PLUGIN_ID, params.accountId, params.eventId);
        if (completed) {
          return databasePath;
        }
      } finally {
        db.close();
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function waitForMatrixIngressCompletion(params: {
  accountId?: string;
  eventId: string;
  stateDir: string;
  timeoutMs: number;
}) {
  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const sqlitePath = await hasPersistedMatrixIngressCompletion({
      accountId,
      eventId: params.eventId,
      stateDir: params.stateDir,
    });
    if (sqlitePath) {
      return sqlitePath;
    }
    await sleep(MATRIX_STATE_POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out waiting for Matrix ingress completion for ${accountId}|${params.eventId}`,
  );
}
