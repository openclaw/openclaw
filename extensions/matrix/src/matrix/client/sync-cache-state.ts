// Shared Matrix sync-cache persistence; no live SDK runtime is needed to migrate state.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ISyncData, IRooms, IStoredClientOpts } from "matrix-js-sdk/lib/matrix.js";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { asSafeIntegerInRange } from "openclaw/plugin-sdk/number-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  chunkMatrixStateJson,
  readMatrixStateChunks,
  writeMatrixStateChunks,
} from "../chunked-state.js";
import { resolveMatrixSqliteStateEnv } from "../sqlite-state.js";

export const MATRIX_SYNC_CACHE_VERSION = 1;
const SYNC_CACHE_NAMESPACE = "sync-cache";
const SYNC_CACHE_MAX_ENTRIES = 20_000;
const SYNC_CACHE_MAX_CHUNKS = Math.floor((SYNC_CACHE_MAX_ENTRIES - 1) / 2);
const SYNC_CACHE_META_KEY = "current:meta";
const SYNC_CACHE_CHUNK_PREFIX = "current:sync:";
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
  const meta = await store.lookup(SYNC_CACHE_META_KEY);
  if (!isSyncCacheMeta(meta)) {
    return null;
  }
  const chunks = await readMatrixStateChunks(
    store,
    Array.from({ length: meta.chunkCount }, (_, index) => chunkKey(meta.generation, index)),
    "sync-chunk",
  );
  const syncJson = chunks?.join("") ?? "";
  const intact =
    chunks !== null && (chunks.length === 0 || meta.syncDigest === digestText(syncJson));
  let savedSync: unknown = null;
  if (intact && chunks.length > 0) {
    try {
      savedSync = JSON.parse(syncJson);
    } catch {
      savedSync = null;
    }
  }
  return normalizePersistedStore({
    version: MATRIX_SYNC_CACHE_VERSION,
    savedSync,
    clientOptions: meta.clientOptions,
    cleanShutdown: intact && meta.cleanShutdown,
  });
}

function chunkKey(generation: string, index: number): string {
  return `${SYNC_CACHE_CHUNK_PREFIX}${generation}:${index}`;
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
    asSafeIntegerInRange(value.chunkCount, { min: 0, max: SYNC_CACHE_MAX_CHUNKS }) !== undefined
  );
}

function buildSyncCacheRows(payload: PersistedMatrixSyncStore): {
  meta: { key: string; value: MatrixSyncCacheMeta };
  chunks: { key: string; value: MatrixSyncCacheChunk }[];
} {
  const generation = randomUUID().replaceAll("-", "");
  const syncJson = payload.savedSync ? JSON.stringify(payload.savedSync) : "";
  const chunkValues = chunkMatrixStateJson(
    syncJson,
    SYNC_CACHE_CHUNK_BYTES,
    SYNC_CACHE_MAX_CHUNKS,
    "Matrix sync cache exceeds SQLite chunk limit",
  );
  const chunks = chunkValues.map((data, index) => ({
    key: chunkKey(generation, index),
    value: {
      kind: "sync-chunk" as const,
      index,
      data,
    },
  }));
  return {
    chunks,
    meta: {
      key: SYNC_CACHE_META_KEY,
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
  const rows = buildSyncCacheRows(payload);
  return syncCacheOperations.enqueue(path.resolve(storageRootDir), () =>
    writeMatrixStateChunks(store, rows, SYNC_CACHE_CHUNK_PREFIX),
  );
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
    await store.delete(SYNC_CACHE_META_KEY);
    for (const row of await store.entries()) {
      if (row.key.startsWith(SYNC_CACHE_CHUNK_PREFIX)) {
        await store.delete(row.key);
      }
    }
    await fs.rm(resolveLegacySyncCachePath(storageRootDir), { force: true }).catch(() => undefined);
  });
}
