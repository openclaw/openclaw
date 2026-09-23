// Matrix plugin module owns SQLite-backed crypto state sidecars.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getMatrixRuntime } from "../runtime.js";
import type { MatrixStoredRecoveryKey } from "./sdk/types.js";
import { resolveMatrixSqliteStateEnv } from "./sqlite-state.js";

const STATE_KEY = "current";
const RECOVERY_KEY_NAMESPACE = "recovery-key";
const LEGACY_CRYPTO_MIGRATION_NAMESPACE = "legacy-crypto-migration";
const IDB_SNAPSHOT_NAMESPACE = "idb-snapshot";
const SMALL_STATE_MAX_ENTRIES = 10;
const IDB_SNAPSHOT_MAX_ENTRIES = 20_000;
const IDB_SNAPSHOT_MAX_CHUNKS = Math.floor((IDB_SNAPSHOT_MAX_ENTRIES - 1) / 2);
const IDB_SNAPSHOT_CHUNK_BYTES = 24_000;

export const MATRIX_RECOVERY_KEY_FILENAME = "recovery-key.json";
export const MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME = "legacy-crypto-migration.json";
export const MATRIX_IDB_SNAPSHOT_FILENAME = "crypto-idb-snapshot.json";

type MatrixLegacyCryptoCounts = {
  total: number;
  backedUp: number;
};

export type MatrixLegacyCryptoMigrationState = {
  version: 1;
  source?: "matrix-bot-sdk-rust";
  accountId: string;
  deviceId?: string | null;
  roomKeyCounts: MatrixLegacyCryptoCounts | null;
  backupVersion?: string | null;
  decryptionKeyImported?: boolean;
  restoreStatus: "pending" | "completed" | "manual-action-required";
  detectedAt?: string;
  restoredAt?: string;
  importedCount?: number;
  totalCount?: number;
  lastError?: string | null;
};

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

export type MatrixIdbSnapshotRecord = MatrixIdbSnapshotMeta | MatrixIdbSnapshotChunk;

type AsyncStore<T> = Pick<
  PluginStateKeyedStore<T>,
  "delete" | "entries" | "lookup" | "lookupMany" | "register"
>;
export type MatrixSnapshotStateRuntime = Pick<PluginRuntime["state"], "openKeyedStore">;

export function openMatrixRecoveryKeyStoreOptions(storageRootDir: string) {
  return {
    namespace: RECOVERY_KEY_NAMESPACE,
    maxEntries: SMALL_STATE_MAX_ENTRIES,
    env: resolveMatrixSqliteStateEnv({ stateDir: storageRootDir }),
  };
}

export function openMatrixLegacyCryptoMigrationStoreOptions(storageRootDir: string) {
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
  const store = stateRuntime.openKeyedStore<MatrixStoredRecoveryKey>(
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
  if (params.preserveEncodedPrivateKey) {
    await updateMatrixRecoveryKeyState(
      params,
      (current) =>
        normalizeMatrixStoredRecoveryKey({
          ...payload,
          encodedPrivateKey: normalizeMatrixStoredRecoveryKey(current)?.encodedPrivateKey,
        }) ?? undefined,
    );
    return;
  }
  await params.stateRuntime
    .openKeyedStore<MatrixStoredRecoveryKey>(
      openMatrixRecoveryKeyStoreOptions(path.dirname(params.recoveryKeyPath)),
    )
    .register(resolveRecoveryKeyStateKeyForPath(params.recoveryKeyPath), payload);
}

async function updateMatrixRecoveryKeyState(
  params: { recoveryKeyPath: string; stateRuntime: MatrixSnapshotStateRuntime },
  update: (current: MatrixStoredRecoveryKey | undefined) => MatrixStoredRecoveryKey | undefined,
): Promise<void> {
  const store = params.stateRuntime.openKeyedStore<MatrixStoredRecoveryKey>(
    openMatrixRecoveryKeyStoreOptions(path.dirname(params.recoveryKeyPath)),
  );
  const key = resolveRecoveryKeyStateKeyForPath(params.recoveryKeyPath);
  if (!store.observe || !store.compareAndApply) {
    // The published >=2026.9.4 host floor supplies callback updates, before data-only CAS.
    if (!store.update) {
      throw new Error("Matrix recovery key store does not support atomic updates");
    }
    await store.update(key, update);
    return;
  }
  let observation = await store.observe(key);
  for (;;) {
    const value = update(observation.value);
    const result = await store.compareAndApply(
      key,
      observation.comparison,
      value === undefined
        ? { operation: "update", action: "keep" }
        : { operation: "update", action: "set", value },
    );
    if (result.status !== "conflict") {
      return;
    }
    observation = result.current;
  }
}

export async function hasMatrixRecoveryKeyStateInStore(params: {
  store: Pick<PluginStateKeyedStore<MatrixStoredRecoveryKey>, "lookup">;
}): Promise<boolean> {
  return normalizeMatrixStoredRecoveryKey(await params.store.lookup(STATE_KEY)) !== null;
}

export async function writeMatrixRecoveryKeyStateToStore(params: {
  payload: MatrixStoredRecoveryKey;
  store: Pick<PluginStateKeyedStore<MatrixStoredRecoveryKey>, "register">;
}): Promise<void> {
  const payload = normalizeMatrixStoredRecoveryKey(params.payload);
  if (!payload) {
    throw new Error("Invalid Matrix recovery key state");
  }
  await params.store.register(STATE_KEY, payload);
}

async function readMatrixLegacyCryptoMigrationState(
  storageRootDir: string,
): Promise<MatrixLegacyCryptoMigrationState | null> {
  return normalizeMatrixLegacyCryptoMigrationState(
    await getMatrixRuntime()
      .state.openKeyedStore<MatrixLegacyCryptoMigrationState>(
        openMatrixLegacyCryptoMigrationStoreOptions(storageRootDir),
      )
      .lookup(STATE_KEY),
  );
}

export async function hasMatrixLegacyCryptoMigrationStateInStore(params: {
  store: Pick<PluginStateKeyedStore<MatrixLegacyCryptoMigrationState>, "lookup">;
}): Promise<boolean> {
  return normalizeMatrixLegacyCryptoMigrationState(await params.store.lookup(STATE_KEY)) !== null;
}

export async function writeMatrixLegacyCryptoMigrationStateToStore(params: {
  state: MatrixLegacyCryptoMigrationState;
  store: Pick<PluginStateKeyedStore<MatrixLegacyCryptoMigrationState>, "register">;
}): Promise<void> {
  const state = normalizeMatrixLegacyCryptoMigrationState(params.state);
  if (!state) {
    throw new Error("Invalid Matrix legacy crypto migration state");
  }
  await params.store.register(STATE_KEY, state);
}

export async function readMatrixIdbSnapshotJson(
  storageRootDir: string,
  stateRuntime: MatrixSnapshotStateRuntime = getMatrixRuntime().state,
): Promise<string | null> {
  return await readMatrixIdbSnapshotJsonFromStore({
    store: stateRuntime.openKeyedStore<MatrixIdbSnapshotRecord>(
      openMatrixIdbSnapshotStoreOptions(storageRootDir),
    ),
  });
}

async function hasMatrixIdbSnapshotState(storageRootDir: string): Promise<boolean> {
  return isIdbSnapshotMeta(
    await getMatrixRuntime()
      .state.openKeyedStore<MatrixIdbSnapshotRecord>(
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
  await writeMatrixIdbSnapshotJsonToStore({
    snapshotJson: params.snapshotJson,
    databaseCount: params.databaseCount,
    store: (
      params.stateRuntime ?? getMatrixRuntime().state
    ).openKeyedStore<MatrixIdbSnapshotRecord>(
      openMatrixIdbSnapshotStoreOptions(params.storageRootDir),
    ),
  });
}

export async function readMatrixIdbSnapshotJsonFromStore(params: {
  store: Pick<PluginStateKeyedStore<MatrixIdbSnapshotRecord>, "lookup" | "lookupMany">;
}): Promise<string | null> {
  return await readIdbSnapshotJsonFromAsyncStore(params.store);
}

export async function writeMatrixIdbSnapshotJsonToStore(params: {
  snapshotJson: string;
  databaseCount: number;
  store: AsyncStore<MatrixIdbSnapshotRecord>;
}): Promise<void> {
  const rows = buildIdbSnapshotRows(params.snapshotJson, params.databaseCount);
  for (const row of rows.chunks) {
    await params.store.register(row.key, row.value);
  }
  await params.store.register(rows.meta.key, rows.meta.value);
  for (const row of await params.store.entries()) {
    if (row.key.startsWith(idbChunkKeyPrefix()) && !rows.nextChunkKeys.has(row.key)) {
      await params.store.delete(row.key);
    }
  }
}

export async function migrateLegacyMatrixRecoveryKeyFilePathToStoreAsync(
  recoveryKeyPath: string,
  stateRuntime: MatrixSnapshotStateRuntime,
): Promise<boolean> {
  const legacy = readLegacyMatrixRecoveryKeyFile(recoveryKeyPath);
  if (legacy) {
    await updateMatrixRecoveryKeyState({ recoveryKeyPath, stateRuntime }, (current) =>
      normalizeMatrixStoredRecoveryKey(current) ? undefined : legacy,
    );
  } else {
    await readMatrixRecoveryKeyStateForPathAsync(recoveryKeyPath, stateRuntime);
  }
  return archiveLegacyStateFileIfPossible(recoveryKeyPath);
}

export async function migrateLegacyMatrixLegacyCryptoMigrationFileToStore(
  storageRootDir: string,
): Promise<boolean> {
  const options = openMatrixLegacyCryptoMigrationStoreOptions(storageRootDir);
  const store = getMatrixRuntime().state.openKeyedStore<MatrixLegacyCryptoMigrationState>(options);
  const legacy = readLegacyMatrixLegacyCryptoMigrationState(storageRootDir);
  if (!legacy) {
    await store.lookup(STATE_KEY);
  } else if (!store.observe || !store.compareAndApply) {
    // Keep the synchronous import decision for hosts before data-only comparisons.
    const legacyStore = openSyncStore<MatrixLegacyCryptoMigrationState>(options);
    if (!normalizeMatrixLegacyCryptoMigrationState(legacyStore.lookup(STATE_KEY))) {
      legacyStore.register(STATE_KEY, legacy);
    }
  } else {
    let observation = await store.observe(STATE_KEY);
    for (;;) {
      if (normalizeMatrixLegacyCryptoMigrationState(observation.value)) {
        break;
      }
      const result = await store.compareAndApply(STATE_KEY, observation.comparison, {
        operation: "update",
        action: "set",
        value: legacy,
      });
      if (result.status !== "conflict") {
        break;
      }
      observation = result.current;
    }
  }
  return archiveLegacyStateFileIfPossible(
    path.join(storageRootDir, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME),
  );
}

export function readLegacyMatrixRecoveryKeyState(
  storageRootDir: string,
): MatrixStoredRecoveryKey | null {
  return readLegacyMatrixRecoveryKeyFile(path.join(storageRootDir, MATRIX_RECOVERY_KEY_FILENAME));
}

export function readLegacyMatrixRecoveryKeyFile(filePath: string): MatrixStoredRecoveryKey | null {
  return readJsonFileSync(filePath, normalizeMatrixStoredRecoveryKey);
}

export function readLegacyMatrixLegacyCryptoMigrationState(
  storageRootDir: string,
): MatrixLegacyCryptoMigrationState | null {
  return readJsonFileSync(
    path.join(storageRootDir, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME),
    normalizeMatrixLegacyCryptoMigrationState,
  );
}

export async function scoreMatrixCryptoStateInStore(storageRootDir: string): Promise<number> {
  if (!matrixCryptoStateDatabaseExists(storageRootDir)) {
    return 0;
  }
  let score = 0;
  try {
    if (await readMatrixLegacyCryptoMigrationState(storageRootDir)) {
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

function normalizeMatrixLegacyCryptoMigrationState(
  value: unknown,
): MatrixLegacyCryptoMigrationState | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.accountId !== "string") {
    return null;
  }
  if (
    value.restoreStatus !== "pending" &&
    value.restoreStatus !== "completed" &&
    value.restoreStatus !== "manual-action-required"
  ) {
    return null;
  }
  const roomKeyCounts =
    isRecord(value.roomKeyCounts) &&
    typeof value.roomKeyCounts.total === "number" &&
    typeof value.roomKeyCounts.backedUp === "number"
      ? {
          total: value.roomKeyCounts.total,
          backedUp: value.roomKeyCounts.backedUp,
        }
      : null;
  return {
    version: 1,
    ...(value.source === "matrix-bot-sdk-rust" ? { source: value.source } : {}),
    accountId: value.accountId,
    ...(typeof value.deviceId === "string" || value.deviceId === null
      ? { deviceId: value.deviceId }
      : {}),
    roomKeyCounts,
    ...(typeof value.backupVersion === "string" || value.backupVersion === null
      ? { backupVersion: value.backupVersion }
      : {}),
    ...(typeof value.decryptionKeyImported === "boolean"
      ? { decryptionKeyImported: value.decryptionKeyImported }
      : {}),
    restoreStatus: value.restoreStatus,
    ...(typeof value.detectedAt === "string" ? { detectedAt: value.detectedAt } : {}),
    ...(typeof value.restoredAt === "string" ? { restoredAt: value.restoredAt } : {}),
    ...(typeof value.importedCount === "number" ? { importedCount: value.importedCount } : {}),
    ...(typeof value.totalCount === "number" ? { totalCount: value.totalCount } : {}),
    ...(typeof value.lastError === "string" || value.lastError === null
      ? { lastError: value.lastError }
      : {}),
  };
}

function openSyncStore<T>(options: {
  namespace: string;
  maxEntries: number;
  env?: NodeJS.ProcessEnv;
}): PluginStateSyncKeyedStore<T> {
  return getMatrixRuntime().state.openSyncKeyedStore<T>(options);
}

function readJsonFileSync<T>(filePath: string, normalize: (value: unknown) => T | null): T | null {
  try {
    return normalize(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function archiveLegacyStateFileIfPossible(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const archivedPath = `${filePath}.migrated`;
  if (fs.existsSync(archivedPath)) {
    return false;
  }
  fs.renameSync(filePath, archivedPath);
  return true;
}

async function readIdbSnapshotJsonFromAsyncStore(
  store: Pick<PluginStateKeyedStore<MatrixIdbSnapshotRecord>, "lookup" | "lookupMany">,
): Promise<string | null> {
  const meta = await store.lookup(idbMetaKey());
  if (!isIdbSnapshotMeta(meta)) {
    return null;
  }
  const chunks = await readIdbSnapshotChunksAsync(meta, store);
  return chunks ? chunks.join("") : null;
}

async function readIdbSnapshotChunksAsync(
  meta: MatrixIdbSnapshotMeta,
  store: Pick<PluginStateKeyedStore<MatrixIdbSnapshotRecord>, "lookup" | "lookupMany">,
): Promise<string[] | null> {
  const records = await store.lookupMany?.(
    Array.from({ length: meta.chunkCount }, (_, index) => idbChunkKey(meta.generation, index)),
  );
  const chunks: string[] = [];
  for (let index = 0; index < meta.chunkCount; index += 1) {
    const result = records?.[index];
    if (result && !result.ok) {
      throw result.error;
    }
    const chunk = records ? result?.value : await store.lookup(idbChunkKey(meta.generation, index));
    if (!isIdbSnapshotChunk(chunk) || chunk.index !== index) {
      return null;
    }
    chunks.push(chunk.data);
  }
  const snapshotJson = chunks.join("");
  if (meta.digest !== digestText(snapshotJson)) {
    return null;
  }
  return chunks;
}

function buildIdbSnapshotRows(
  snapshotJson: string,
  databaseCount: number,
): {
  meta: { key: string; value: MatrixIdbSnapshotMeta };
  chunks: { key: string; value: MatrixIdbSnapshotChunk }[];
  nextChunkKeys: Set<string>;
} {
  const generation = randomUUID().replaceAll("-", "");
  const chunks = chunkText(snapshotJson).map((data, index) => ({
    key: idbChunkKey(generation, index),
    value: {
      kind: "snapshot-chunk" as const,
      index,
      data,
    },
  }));
  return {
    chunks,
    nextChunkKeys: new Set(chunks.map((chunk) => chunk.key)),
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

function chunkText(value: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current && currentBytes + charBytes > IDB_SNAPSHOT_CHUNK_BYTES) {
      pushChunk(chunks, current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) {
    pushChunk(chunks, current);
  }
  return chunks;
}

function pushChunk(chunks: string[], chunk: string): void {
  if (chunks.length >= IDB_SNAPSHOT_MAX_CHUNKS) {
    throw new Error("Matrix IndexedDB snapshot exceeds SQLite chunk limit");
  }
  chunks.push(chunk);
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
    typeof value.chunkCount === "number" &&
    Number.isSafeInteger(value.chunkCount) &&
    value.chunkCount >= 0 &&
    value.chunkCount <= IDB_SNAPSHOT_MAX_CHUNKS &&
    typeof value.digest === "string" &&
    typeof value.databaseCount === "number" &&
    Number.isSafeInteger(value.databaseCount) &&
    value.databaseCount >= 0 &&
    typeof value.persistedAt === "string"
  );
}

function isIdbSnapshotChunk(value: unknown): value is MatrixIdbSnapshotChunk {
  return (
    isRecord(value) &&
    value.kind === "snapshot-chunk" &&
    typeof value.index === "number" &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    typeof value.data === "string"
  );
}
