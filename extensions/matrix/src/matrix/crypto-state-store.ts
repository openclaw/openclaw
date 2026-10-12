import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { asSafeIntegerInRange } from "openclaw/plugin-sdk/number-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getMatrixRuntime } from "../runtime.js";
import {
  chunkMatrixStateJson,
  readMatrixStateChunks,
  writeMatrixStateChunks,
} from "./chunked-state.js";
import type { MatrixStoredRecoveryKey } from "./sdk/types.js";
import { resolveMatrixSqliteStateEnv, updateMatrixKeyedState } from "./sqlite-state.js";

const STATE_KEY = "current";
const RECOVERY_KEY_NAMESPACE = "recovery-key";
const LEGACY_CRYPTO_MIGRATION_NAMESPACE = "legacy-crypto-migration";
const IDB_SNAPSHOT_NAMESPACE = "idb-snapshot";
const SMALL_STATE_MAX_ENTRIES = 10;
const IDB_SNAPSHOT_MAX_ENTRIES = 20_000;
const IDB_SNAPSHOT_MAX_CHUNKS = Math.floor((IDB_SNAPSHOT_MAX_ENTRIES - 1) / 2);
const IDB_SNAPSHOT_CHUNK_BYTES = 24_000;

export const MATRIX_RECOVERY_KEY_FILENAME = "recovery-key.json";
export const MATRIX_IDB_SNAPSHOT_FILENAME = "crypto-idb-snapshot.json";

type MatrixIdbSnapshotMeta = {
  kind: "meta";
  version: 1;
  generation: string;
  chunkCount: number;
  digest: string;
  databaseCount: number;
  persistedAt: string;
};

type MatrixIdbSnapshotChunk = {
  kind: "snapshot-chunk";
  index: number;
  data: string;
};

type MatrixIdbSnapshotRecord = MatrixIdbSnapshotMeta | MatrixIdbSnapshotChunk;

export type MatrixSnapshotStateRuntime = Pick<PluginRuntime["state"], "openKeyedStoreV2">;

export function openMatrixRecoveryKeyStoreOptions(storageRootDir: string) {
  return {
    namespace: RECOVERY_KEY_NAMESPACE,
    maxEntries: SMALL_STATE_MAX_ENTRIES,
    env: resolveMatrixSqliteStateEnv({ stateDir: storageRootDir }),
  };
}

function openMatrixLegacyCryptoMigrationStoreOptions(storageRootDir: string) {
  return {
    namespace: LEGACY_CRYPTO_MIGRATION_NAMESPACE,
    maxEntries: SMALL_STATE_MAX_ENTRIES,
    env: resolveMatrixSqliteStateEnv({ stateDir: storageRootDir }),
  };
}

export function openMatrixIdbSnapshotStoreOptions(storageRootDir: string) {
  return {
    namespace: IDB_SNAPSHOT_NAMESPACE,
    maxEntries: IDB_SNAPSHOT_MAX_ENTRIES,
    env: resolveMatrixSqliteStateEnv({ stateDir: storageRootDir }),
  };
}

export async function readMatrixRecoveryKeyStateForPathAsync(
  recoveryKeyPath: string,
  stateRuntime: MatrixSnapshotStateRuntime,
): Promise<MatrixStoredRecoveryKey | null> {
  const store = stateRuntime.openKeyedStoreV2<MatrixStoredRecoveryKey>(
    openMatrixRecoveryKeyStoreOptions(path.dirname(recoveryKeyPath)),
  );
  return normalizeMatrixStoredRecoveryKey(
    await store.lookup(resolveRecoveryKeyStateKeyForPath(recoveryKeyPath)),
  );
}

export async function writeMatrixRecoveryKeyStateForPathAsync(params: {
  recoveryKeyPath: string;
  payload: MatrixStoredRecoveryKey;
  stateRuntime: MatrixSnapshotStateRuntime;
  preserveEncodedPrivateKey?: boolean;
}): Promise<void> {
  const payload = normalizeMatrixStoredRecoveryKey(params.payload);
  if (!payload) {
    throw new Error("Invalid Matrix recovery key state");
  }
  const store = params.stateRuntime.openKeyedStoreV2<MatrixStoredRecoveryKey>(
    openMatrixRecoveryKeyStoreOptions(path.dirname(params.recoveryKeyPath)),
  );
  const key = resolveRecoveryKeyStateKeyForPath(params.recoveryKeyPath);
  if (params.preserveEncodedPrivateKey) {
    const update = (current: MatrixStoredRecoveryKey | undefined) =>
      normalizeMatrixStoredRecoveryKey({
        ...payload,
        encodedPrivateKey: normalizeMatrixStoredRecoveryKey(current)?.encodedPrivateKey,
      }) ?? undefined;
    await updateMatrixKeyedState(store, key, update);
    return;
  }
  await store.register(key, payload);
}

export async function readMatrixIdbSnapshotJson(
  storageRootDir: string,
  stateRuntime: MatrixSnapshotStateRuntime = getMatrixRuntime().state,
): Promise<string | null> {
  const store = stateRuntime.openKeyedStoreV2<MatrixIdbSnapshotRecord>(
    openMatrixIdbSnapshotStoreOptions(storageRootDir),
  );
  const meta = await store.lookup(idbMetaKey());
  if (!isIdbSnapshotMeta(meta)) {
    return null;
  }
  const chunks = await readMatrixStateChunks(
    store,
    Array.from({ length: meta.chunkCount }, (_, index) => idbChunkKey(meta.generation, index)),
    "snapshot-chunk",
  );
  if (!chunks) {
    return null;
  }
  const snapshotJson = chunks.join("");
  return meta.digest === digestText(snapshotJson) ? snapshotJson : null;
}

async function hasMatrixIdbSnapshotState(storageRootDir: string): Promise<boolean> {
  return isIdbSnapshotMeta(
    await getMatrixRuntime()
      .state.openKeyedStoreV2<MatrixIdbSnapshotRecord>(
        openMatrixIdbSnapshotStoreOptions(storageRootDir),
      )
      .lookup(idbMetaKey()),
  );
}

export async function writeMatrixIdbSnapshotJson(params: {
  storageRootDir: string;
  snapshotJson: string;
  databaseCount: number;
  stateRuntime?: MatrixSnapshotStateRuntime;
}): Promise<void> {
  const store = (
    params.stateRuntime ?? getMatrixRuntime().state
  ).openKeyedStoreV2<MatrixIdbSnapshotRecord>(
    openMatrixIdbSnapshotStoreOptions(params.storageRootDir),
  );
  const rows = buildIdbSnapshotRows(params.snapshotJson, params.databaseCount);
  await writeMatrixStateChunks(store, rows, idbChunkKeyPrefix());
}

export async function scoreMatrixCryptoStateInStore(storageRootDir: string): Promise<number> {
  if (!matrixCryptoStateDatabaseExists(storageRootDir)) {
    return 0;
  }
  let score = 0;
  try {
    const migration = await getMatrixRuntime()
      .state.openKeyedStoreV2(openMatrixLegacyCryptoMigrationStoreOptions(storageRootDir))
      .lookup(STATE_KEY);
    if (
      isRecord(migration) &&
      migration.version === 1 &&
      typeof migration.accountId === "string" &&
      (migration.restoreStatus === "pending" ||
        migration.restoreStatus === "completed" ||
        migration.restoreStatus === "manual-action-required")
    ) {
      score += 3;
    }
  } catch {
    // Storage root scoring must stay best-effort; unreadable state should not block startup.
  }
  try {
    if (
      await readMatrixRecoveryKeyStateForPathAsync(
        path.join(storageRootDir, MATRIX_RECOVERY_KEY_FILENAME),
        getMatrixRuntime().state,
      )
    ) {
      score += 2;
    }
  } catch {
    // Storage root scoring must stay best-effort; unreadable state should not block startup.
  }
  try {
    if (await hasMatrixIdbSnapshotState(storageRootDir)) {
      score += 2;
    }
  } catch {
    // Storage root scoring must stay best-effort; unreadable state should not block startup.
  }
  return score;
}

function matrixCryptoStateDatabaseExists(storageRootDir: string): boolean {
  return fs.existsSync(path.join(storageRootDir, "state", "openclaw.sqlite"));
}

function resolveRecoveryKeyStateKeyForPath(recoveryKeyPath: string): string {
  const basename = path.basename(recoveryKeyPath);
  if (basename === MATRIX_RECOVERY_KEY_FILENAME) {
    return STATE_KEY;
  }
  return `file:${createHash("sha256").update(basename, "utf8").digest("hex").slice(0, 32)}`;
}

function normalizeMatrixStoredRecoveryKey(value: unknown): MatrixStoredRecoveryKey | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.createdAt !== "string" ||
    typeof value.privateKeyBase64 !== "string" ||
    !value.privateKeyBase64.trim()
  ) {
    return null;
  }
  return {
    version: 1,
    createdAt: value.createdAt,
    keyId: typeof value.keyId === "string" ? value.keyId : null,
    ...(typeof value.encodedPrivateKey === "string"
      ? { encodedPrivateKey: value.encodedPrivateKey }
      : {}),
    privateKeyBase64: value.privateKeyBase64,
    ...(isRecord(value.keyInfo)
      ? {
          keyInfo: {
            ...(value.keyInfo.passphrase !== undefined
              ? { passphrase: value.keyInfo.passphrase }
              : {}),
            ...(typeof value.keyInfo.name === "string" ? { name: value.keyInfo.name } : {}),
          },
        }
      : {}),
  };
}

function buildIdbSnapshotRows(
  snapshotJson: string,
  databaseCount: number,
): {
  meta: { key: string; value: MatrixIdbSnapshotMeta };
  chunks: { key: string; value: MatrixIdbSnapshotChunk }[];
} {
  const generation = randomUUID().replaceAll("-", "");
  const chunks = chunkMatrixStateJson(
    snapshotJson,
    IDB_SNAPSHOT_CHUNK_BYTES,
    IDB_SNAPSHOT_MAX_CHUNKS,
    "Matrix IndexedDB snapshot exceeds SQLite chunk limit",
  ).map((data, index) => ({
    key: idbChunkKey(generation, index),
    value: {
      kind: "snapshot-chunk" as const,
      index,
      data,
    },
  }));
  return {
    chunks,
    meta: {
      key: idbMetaKey(),
      value: {
        kind: "meta",
        version: 1,
        generation,
        chunkCount: chunks.length,
        digest: digestText(snapshotJson),
        databaseCount,
        persistedAt: new Date().toISOString(),
      },
    },
  };
}

function idbMetaKey(): string {
  return `${STATE_KEY}:meta`;
}

function idbChunkKeyPrefix(): string {
  return `${STATE_KEY}:snapshot:`;
}

function idbChunkKey(generation: string, index: number): string {
  return `${idbChunkKeyPrefix()}${generation}:${index}`;
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isIdbSnapshotMeta(value: unknown): value is MatrixIdbSnapshotMeta {
  return (
    isRecord(value) &&
    value.kind === "meta" &&
    value.version === 1 &&
    typeof value.generation === "string" &&
    value.generation.trim() !== "" &&
    asSafeIntegerInRange(value.chunkCount, { min: 0, max: IDB_SNAPSHOT_MAX_CHUNKS }) !==
      undefined &&
    typeof value.digest === "string" &&
    asSafeIntegerInRange(value.databaseCount, { min: 0 }) !== undefined &&
    typeof value.persistedAt === "string"
  );
}
