// Shared Matrix sync-cache persistence; no live SDK runtime is needed to migrate state.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ISyncData, IRooms, IStoredClientOpts } from "matrix-js-sdk/lib/matrix.js";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixSqliteStateEnv } from "../sqlite-state.js";

export const MATRIX_SYNC_CACHE_VERSION = 1;
const SYNC_CACHE_NAMESPACE = "sync-cache";
const SYNC_CACHE_MAX_ENTRIES = 20_000;
const SYNC_CACHE_MAX_CHUNKS = Math.floor((SYNC_CACHE_MAX_ENTRIES - 1) / 2);
const SYNC_CACHE_STATE_KEY = "current";
// PluginState serializes this string inside a row object; 24KB leaves room for JSON escaping.
const SYNC_CACHE_CHUNK_BYTES = 24_000;

// A reader must finish its generation before another local writer retires its chunks.
const syncCacheOperations = new KeyedAsyncQueue();

export type PersistedMatrixSyncStore = {
  version: number;
  savedSync: ISyncData | null;
  clientOptions?: IStoredClientOpts;
  cleanShutdown?: boolean;
};

type MatrixSyncCacheMeta = {
  kind: "meta";
  version: number;
  generation: string;
  chunkCount: number;
  syncDigest?: string;
  clientOptions?: IStoredClientOpts;
  cleanShutdown?: boolean;
};

type MatrixSyncCacheChunk = {
  kind: "sync-chunk";
  index: number;
  data: string;
};

export type MatrixSyncCacheRecord = MatrixSyncCacheMeta | MatrixSyncCacheChunk;

type MatrixSyncCacheAsyncStore = Pick<
  PluginStateKeyedStore<MatrixSyncCacheRecord>,
  "delete" | "entries" | "lookup" | "lookupMany" | "register"
>;

function normalizeRoomsData(value: unknown): IRooms | null {
  if (!isRecord(value)) {
    return null;
  }
  // These are the Matrix /sync room categories, shared by persisted SDK snapshots.
  // Keep protocol keys here without loading the live SDK for Doctor migrations.
  return {
    // SAFETY: Joined-room fields remain opaque SDK snapshot data after the record check.
    join: isRecord(value.join) ? (value.join as IRooms["join"]) : {},
    // SAFETY: Invited-room fields remain opaque SDK snapshot data after the record check.
    invite: isRecord(value.invite) ? (value.invite as IRooms["invite"]) : {},
    // SAFETY: Left-room fields remain opaque SDK snapshot data after the record check.
    leave: isRecord(value.leave) ? (value.leave as IRooms["leave"]) : {},
    // SAFETY: Knocked-room fields remain opaque SDK snapshot data after the record check.
    knock: isRecord(value.knock) ? (value.knock as IRooms["knock"]) : {},
  };
}

function toPersistedSyncData(value: unknown): ISyncData | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.nextBatch === "string" && value.nextBatch.trim()) {
    const roomsData = normalizeRoomsData(value.roomsData);
    if (!Array.isArray(value.accountData) || !roomsData) {
      return null;
    }
    return {
      nextBatch: value.nextBatch,
      accountData: value.accountData,
      roomsData,
    };
  }

  // Older Matrix state files stored the raw /sync-shaped payload directly.
  if (typeof value.next_batch === "string" && value.next_batch.trim()) {
    const roomsData = normalizeRoomsData(value.rooms);
    if (!roomsData) {
      return null;
    }
    return {
      nextBatch: value.next_batch,
      accountData:
        isRecord(value.account_data) && Array.isArray(value.account_data.events)
          ? value.account_data.events
          : [],
      roomsData,
    };
  }

  return null;
}

function normalizePersistedStore(value: unknown): PersistedMatrixSyncStore | null {
  if (!isRecord(value) || value.version !== MATRIX_SYNC_CACHE_VERSION) {
    return null;
  }
  return {
    version: MATRIX_SYNC_CACHE_VERSION,
    savedSync: toPersistedSyncData(value.savedSync),
    clientOptions: isRecord(value.clientOptions)
      ? (value.clientOptions as IStoredClientOpts) // SAFETY: SDK options remain opaque after record validation.
      : undefined,
    cleanShutdown: value.cleanShutdown === true,
  };
}

function normalizeLegacyPersistedStore(value: unknown): PersistedMatrixSyncStore | null {
  const persisted = normalizePersistedStore(value);
  if (persisted) {
    return persisted;
  }
  return {
    version: MATRIX_SYNC_CACHE_VERSION,
    savedSync: toPersistedSyncData(value),
    cleanShutdown: false,
  };
}

export async function readPersistedStoreFromStore(params: {
  storageRootDir: string;
  store: Pick<PluginStateKeyedStore<MatrixSyncCacheRecord>, "lookup" | "lookupMany">;
}): Promise<PersistedMatrixSyncStore | null> {
  const { storageRootDir, store } = params;
  return syncCacheOperations.enqueue(path.resolve(storageRootDir), () => readPersistedStore(store));
}

async function readPersistedStore(
  store: Pick<PluginStateKeyedStore<MatrixSyncCacheRecord>, "lookup" | "lookupMany">,
): Promise<PersistedMatrixSyncStore | null> {
  const stateKey = SYNC_CACHE_STATE_KEY;
  const meta = await store.lookup(metaKey(stateKey));
  if (!isSyncCacheMeta(meta)) {
    return null;
  }
  // Preserve the published host floor where lookupMany is not yet available.
  const records = await store.lookupMany?.(
    Array.from({ length: meta.chunkCount }, (_, index) =>
      chunkKey(stateKey, meta.generation, index),
    ),
  );
  const chunks: string[] = [];
  for (let index = 0; index < meta.chunkCount; index += 1) {
    const result = records?.[index];
    if (result && !result.ok) {
      throw result.error;
    }
    const chunk = records
      ? result?.value
      : await store.lookup(chunkKey(stateKey, meta.generation, index));
    if (!isSyncCacheChunk(chunk) || chunk.index !== index) {
      return normalizePersistedStore({
        version: MATRIX_SYNC_CACHE_VERSION,
        savedSync: null,
        clientOptions: meta.clientOptions,
        cleanShutdown: false,
      });
    }
    chunks.push(chunk.data);
  }
  let savedSync: ISyncData | null = null;
  if (chunks.length > 0) {
    const syncJson = chunks.join("");
    if (meta.syncDigest !== digestText(syncJson)) {
      return normalizePersistedStore({
        version: MATRIX_SYNC_CACHE_VERSION,
        savedSync: null,
        clientOptions: meta.clientOptions,
        cleanShutdown: false,
      });
    }
    try {
      savedSync = toPersistedSyncData(JSON.parse(syncJson));
    } catch {
      savedSync = null;
    }
  }
  return normalizePersistedStore({
    version: MATRIX_SYNC_CACHE_VERSION,
    savedSync,
    clientOptions: meta.clientOptions,
    cleanShutdown: meta.cleanShutdown,
  });
}

function metaKey(stateKey: string): string {
  return `${stateKey}:meta`;
}

function chunkKeyPrefix(stateKey: string): string {
  return `${stateKey}:sync:`;
}

function chunkKey(stateKey: string, generation: string, index: number): string {
  return `${chunkKeyPrefix(stateKey)}${generation}:${index}`;
}

function resolveLegacySyncCachePath(storageRootDir: string): string {
  return path.join(storageRootDir, "bot-storage.json");
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isSyncCacheMeta(value: unknown): value is MatrixSyncCacheMeta {
  return (
    isRecord(value) &&
    value.kind === "meta" &&
    value.version === MATRIX_SYNC_CACHE_VERSION &&
    typeof value.generation === "string" &&
    value.generation.trim() !== "" &&
    typeof value.chunkCount === "number" &&
    Number.isSafeInteger(value.chunkCount) &&
    value.chunkCount >= 0 &&
    value.chunkCount <= SYNC_CACHE_MAX_CHUNKS
  );
}

function isSyncCacheChunk(value: unknown): value is MatrixSyncCacheChunk {
  return (
    isRecord(value) &&
    value.kind === "sync-chunk" &&
    typeof value.index === "number" &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    typeof value.data === "string"
  );
}

function chunkSyncCacheJson(value: string): string[] {
  const chunks: string[] = [];
  const pushChunk = (chunk: string) => {
    if (chunks.length >= SYNC_CACHE_MAX_CHUNKS) {
      throw new Error("Matrix sync cache exceeds SQLite chunk limit");
    }
    chunks.push(chunk);
  };
  let current = "";
  let currentBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current && currentBytes + charBytes > SYNC_CACHE_CHUNK_BYTES) {
      pushChunk(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) {
    pushChunk(current);
  }
  return chunks;
}

function buildSyncCacheRows(
  stateKey: string,
  payload: PersistedMatrixSyncStore,
): {
  meta: { key: string; value: MatrixSyncCacheMeta };
  chunks: { key: string; value: MatrixSyncCacheChunk }[];
  nextChunkKeys: Set<string>;
} {
  const generation = randomUUID().replaceAll("-", "");
  const syncJson = payload.savedSync ? JSON.stringify(payload.savedSync) : "";
  const chunkValues = syncJson ? chunkSyncCacheJson(syncJson) : [];
  const chunks = chunkValues.map((data, index) => ({
    key: chunkKey(stateKey, generation, index),
    value: {
      kind: "sync-chunk" as const,
      index,
      data,
    },
  }));
  return {
    chunks,
    nextChunkKeys: new Set(chunks.map((chunk) => chunk.key)),
    meta: {
      key: metaKey(stateKey),
      value: {
        kind: "meta",
        version: MATRIX_SYNC_CACHE_VERSION,
        generation,
        chunkCount: chunks.length,
        ...(syncJson ? { syncDigest: digestText(syncJson) } : {}),
        ...(payload.clientOptions ? { clientOptions: payload.clientOptions } : {}),
        cleanShutdown: payload.cleanShutdown === true,
      },
    },
  };
}

export async function readLegacyMatrixSyncCacheState(
  storageRootDir: string,
): Promise<PersistedMatrixSyncStore | null> {
  try {
    const raw = await fs.readFile(resolveLegacySyncCachePath(storageRootDir), "utf8");
    const persisted = normalizeLegacyPersistedStore(JSON.parse(raw));
    if (!persisted?.savedSync && !persisted?.clientOptions) {
      return null;
    }
    return persisted;
  } catch {
    return null;
  }
}

export async function hasMatrixSyncCacheStateInStore(params: {
  storageRootDir: string;
  store: Pick<PluginStateKeyedStore<MatrixSyncCacheRecord>, "lookup" | "lookupMany">;
}): Promise<boolean> {
  return Boolean((await readPersistedStoreFromStore(params))?.savedSync);
}

export async function writeMatrixSyncCacheStateToStore(params: {
  storageRootDir: string;
  payload: PersistedMatrixSyncStore;
  store: MatrixSyncCacheAsyncStore;
}): Promise<void> {
  const { storageRootDir, store, payload } = params;
  const stateKey = SYNC_CACHE_STATE_KEY;
  const rows = buildSyncCacheRows(stateKey, payload);
  return syncCacheOperations.enqueue(path.resolve(storageRootDir), async () => {
    for (const row of rows.chunks) {
      await store.register(row.key, row.value);
    }
    await store.register(rows.meta.key, rows.meta.value);
    for (const row of await store.entries()) {
      if (row.key.startsWith(chunkKeyPrefix(stateKey)) && !rows.nextChunkKeys.has(row.key)) {
        await store.delete(row.key);
      }
    }
  });
}

export function openMatrixSyncCacheStoreOptions(storageRootDir: string) {
  return {
    namespace: SYNC_CACHE_NAMESPACE,
    maxEntries: SYNC_CACHE_MAX_ENTRIES,
    env: resolveMatrixSqliteStateEnv({ stateDir: storageRootDir }),
  };
}

export async function deleteMatrixSyncCacheStateFromStore(params: {
  storageRootDir: string;
  store: MatrixSyncCacheAsyncStore;
}): Promise<void> {
  const { storageRootDir, store } = params;
  return syncCacheOperations.enqueue(path.resolve(storageRootDir), async () => {
    await store.delete(metaKey(SYNC_CACHE_STATE_KEY));
    for (const row of await store.entries()) {
      if (row.key.startsWith(chunkKeyPrefix(SYNC_CACHE_STATE_KEY))) {
        await store.delete(row.key);
      }
    }
    await fs.rm(resolveLegacySyncCachePath(storageRootDir), { force: true }).catch(() => undefined);
  });
}
