import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { loadJsonFile } from "openclaw/plugin-sdk/json-store";
import { getMatrixRuntime } from "../../runtime.js";
import {
  isMatrixActiveTokenRootDirectory,
  resolveMatrixAccountStorageRoot,
} from "../../storage-paths.js";
import {
  MATRIX_IDB_SNAPSHOT_FILENAME,
  MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
  MATRIX_RECOVERY_KEY_FILENAME,
  migrateLegacyMatrixLegacyCryptoMigrationFileToStore,
  migrateLegacyMatrixRecoveryKeyFilePathToStoreAsync,
  scoreMatrixCryptoStateInStore,
} from "../crypto-state-store.js";
import {
  normalizeMatrixStorageMetadata,
  openMatrixStorageMetaStoreOptions,
  STORAGE_META_STATE_KEY,
  type MatrixStorageMetadata,
} from "./storage-metadata.js";
import type { MatrixAuth, MatrixStoragePaths } from "./types.js";

const DEFAULT_ACCOUNT_KEY = "default";
const STORAGE_META_FILENAME = "storage-meta.json";
const THREAD_BINDINGS_FILENAME = "thread-bindings.json";
type LegacyMigrationRecord = {
  sourcePath: string;
  targetDescription: string;
  label: string;
};

type LegacyArchiveRecord = {
  sourcePath: string;
  label: string;
};

function openStorageMetaStore(rootDir: string) {
  return getMatrixRuntime().state.openKeyedStore<MatrixStorageMetadata>(
    openMatrixStorageMetaStoreOptions(rootDir),
  );
}

async function scoreStorageRoot(rootDir: string, metadata: MatrixStorageMetadata): Promise<number> {
  let score = 0;
  if (Object.keys(metadata).length > 0) {
    score += 1;
  }
  if (metadata.currentTokenStateClaimed === true) {
    score += 8;
  }
  if (fs.existsSync(path.join(rootDir, "crypto"))) {
    score += 8;
  }
  if (fs.existsSync(path.join(rootDir, THREAD_BINDINGS_FILENAME))) {
    score += 4;
  }
  if (fs.existsSync(path.join(rootDir, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME))) {
    score += 3;
  }
  if (fs.existsSync(path.join(rootDir, MATRIX_RECOVERY_KEY_FILENAME))) {
    score += 2;
  }
  if (fs.existsSync(path.join(rootDir, MATRIX_IDB_SNAPSHOT_FILENAME))) {
    score += 2;
  }
  score += await scoreMatrixCryptoStateInStore(rootDir);
  return score;
}

function resolveStorageRootMtimeMs(rootDir: string): number {
  try {
    return fs.statSync(rootDir).mtimeMs;
  } catch {
    return 0;
  }
}

type PopulatedMatrixStorageRoot = {
  tokenHash: string;
  rootDir: string;
  score: number;
  mtimeMs: number;
};

async function readStoredRootMetadata(rootDir: string): Promise<MatrixStorageMetadata> {
  if (fs.existsSync(path.join(rootDir, "state", "openclaw.sqlite"))) {
    try {
      const stored = normalizeMatrixStorageMetadata(
        await openStorageMetaStore(rootDir).lookup(STORAGE_META_STATE_KEY),
      );
      if (stored) {
        return stored;
      }
    } catch {
      // Root selection remains best-effort; a write path will surface SQLite failures.
    }
  }
  return (
    normalizeMatrixStorageMetadata(loadJsonFile(path.join(rootDir, STORAGE_META_FILENAME))) ?? {}
  );
}

function isCompatibleStorageRoot(params: {
  metadata: MatrixStorageMetadata;
  homeserver: string;
  userId: string;
  accountKey: string;
  deviceId?: string | null;
  requireExplicitDeviceMatch?: boolean;
}): boolean {
  const { metadata } = params;
  if (metadata.homeserver && metadata.homeserver !== params.homeserver) {
    return false;
  }
  if (metadata.userId && metadata.userId !== params.userId) {
    return false;
  }
  if (
    metadata.accountId &&
    normalizeAccountId(metadata.accountId) !== normalizeAccountId(params.accountKey)
  ) {
    return false;
  }
  if (
    params.deviceId &&
    metadata.deviceId &&
    metadata.deviceId.trim() &&
    metadata.deviceId.trim() !== params.deviceId.trim()
  ) {
    return false;
  }
  if (
    params.requireExplicitDeviceMatch &&
    params.deviceId &&
    (!metadata.deviceId || metadata.deviceId.trim() !== params.deviceId.trim())
  ) {
    return false;
  }
  return true;
}

async function resolvePreferredMatrixStorageRoot(params: {
  canonicalRootDir: string;
  canonicalTokenHash: string;
  homeserver: string;
  userId: string;
  accountKey: string;
  deviceId?: string | null;
}): Promise<{
  rootDir: string;
  tokenHash: string;
}> {
  const canonical = {
    rootDir: params.canonicalRootDir,
    tokenHash: params.canonicalTokenHash,
  };
  const deviceId = params.deviceId?.trim();

  // Without a confirmed device identity, reusing a populated sibling root after
  // token rotation can silently bind this run to the wrong Matrix device state.
  if (!deviceId) {
    return canonical;
  }

  const canonicalMetadata = await readStoredRootMetadata(params.canonicalRootDir);
  const canonicalRootOwnsCurrentToken =
    canonicalMetadata.accessTokenHash === params.canonicalTokenHash &&
    canonicalMetadata.deviceId?.trim() === deviceId &&
    canonicalMetadata.currentTokenStateClaimed === true;

  // A claimed canonical root is authoritative. Scanning token-history siblings
  // would synchronously open and retain every per-root SQLite store during startup.
  if (canonicalRootOwnsCurrentToken) {
    return canonical;
  }

  const parentDir = path.dirname(params.canonicalRootDir);
  const bestCurrentScore = await scoreStorageRoot(params.canonicalRootDir, canonicalMetadata);
  const bestCurrentMtimeMs = resolveStorageRootMtimeMs(params.canonicalRootDir);
  let best = {
    rootDir: params.canonicalRootDir,
    tokenHash: params.canonicalTokenHash,
    score: bestCurrentScore,
    mtimeMs: bestCurrentMtimeMs,
  };

  let siblingEntries: fs.Dirent[];
  try {
    siblingEntries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return {
      rootDir: best.rootDir,
      tokenHash: best.tokenHash,
    };
  }

  const compatiblePopulatedSiblings: PopulatedMatrixStorageRoot[] = [];
  const populatedTokenHashes = bestCurrentScore > 0 ? [params.canonicalTokenHash] : [];
  for (const entry of siblingEntries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === params.canonicalTokenHash) {
      continue;
    }
    // Sibling reuse is only defined for exact token-hash roots. Filtering here
    // keeps archived SQLite state out of compatibility checks and scoring.
    if (!isMatrixActiveTokenRootDirectory(entry.name)) {
      continue;
    }
    const candidateRootDir = path.join(parentDir, entry.name);
    const metadata = await readStoredRootMetadata(candidateRootDir);
    if (
      !isCompatibleStorageRoot({
        metadata,
        homeserver: params.homeserver,
        userId: params.userId,
        accountKey: params.accountKey,
        deviceId,
        // Once auth resolves a concrete device, only sibling roots that explicitly
        // declare that same device are safe to reuse across token rotations.
        requireExplicitDeviceMatch: true,
      })
    ) {
      continue;
    }
    const candidateScore = await scoreStorageRoot(candidateRootDir, metadata);
    if (candidateScore <= 0) {
      continue;
    }
    populatedTokenHashes.push(entry.name);
    compatiblePopulatedSiblings.push({
      rootDir: candidateRootDir,
      tokenHash: entry.name,
      score: candidateScore,
      mtimeMs: resolveStorageRootMtimeMs(candidateRootDir),
    });
  }

  for (const candidate of compatiblePopulatedSiblings) {
    if (
      candidate.score > best.score ||
      (best.rootDir !== params.canonicalRootDir &&
        candidate.score === best.score &&
        candidate.mtimeMs > best.mtimeMs)
    ) {
      best = {
        rootDir: candidate.rootDir,
        tokenHash: candidate.tokenHash,
        score: candidate.score,
        mtimeMs: candidate.mtimeMs,
      };
    }
  }

  if (populatedTokenHashes.length > 1) {
    getMatrixRuntime()
      .logging.getChildLogger({ module: "matrix-storage" })
      .warn("matrix: multiple populated token-hash storage roots detected", {
        parentDir,
        canonicalTokenHash: params.canonicalTokenHash,
        selectedTokenHash: best.tokenHash,
        populatedTokenHashes,
        populatedSiblingTokenHashes: compatiblePopulatedSiblings.map((root) => root.tokenHash),
        populatedRootCount: populatedTokenHashes.length,
      });
  }

  return {
    rootDir: best.rootDir,
    tokenHash: best.tokenHash,
  };
}

export async function resolveMatrixStoragePaths(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  accountId?: string | null;
  deviceId?: string | null;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<MatrixStoragePaths> {
  const env = params.env ?? process.env;
  const stateDir = params.stateDir ?? getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  const canonical = resolveMatrixAccountStorageRoot({
    stateDir,
    homeserver: params.homeserver,
    userId: params.userId,
    accessToken: params.accessToken,
    accountId: params.accountId,
  });
  const { rootDir, tokenHash } = await resolvePreferredMatrixStorageRoot({
    canonicalRootDir: canonical.rootDir,
    canonicalTokenHash: canonical.tokenHash,
    homeserver: params.homeserver,
    userId: params.userId,
    accountKey: canonical.accountKey,
    deviceId: params.deviceId,
  });
  return {
    rootDir,
    storagePath: path.join(rootDir, "bot-storage.json"),
    cryptoPath: path.join(rootDir, "crypto"),
    recoveryKeyPath: path.join(rootDir, MATRIX_RECOVERY_KEY_FILENAME),
    idbSnapshotPath: path.join(rootDir, MATRIX_IDB_SNAPSHOT_FILENAME),
    accountKey: canonical.accountKey,
    tokenHash,
  };
}

export async function resolveMatrixStateFilePath(params: {
  auth: MatrixAuth;
  filename: string;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<string> {
  const storagePaths = await resolveMatrixStoragePaths({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    accountId: params.accountId ?? params.auth.accountId,
    deviceId: params.auth.deviceId,
    env: params.env,
    stateDir: params.stateDir,
  });
  return path.join(storagePaths.rootDir, params.filename);
}

export async function maybeMigrateLegacyStorage(params: {
  storagePaths: MatrixStoragePaths;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const hasAccountScopedLegacyStorageFile = fs.existsSync(params.storagePaths.storagePath);
  const syncCache = hasAccountScopedLegacyStorageFile
    ? await import("./sync-cache-state.js")
    : null;
  const hasAccountScopedLegacyStorage =
    hasAccountScopedLegacyStorageFile &&
    (await syncCache?.readLegacyMatrixSyncCacheState(params.storagePaths.rootDir)) !== null;
  const hasAccountScopedRecoveryKey = fs.existsSync(params.storagePaths.recoveryKeyPath);
  const hasAccountScopedLegacyCryptoMigration = fs.existsSync(
    path.join(params.storagePaths.rootDir, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME),
  );
  if (
    !hasAccountScopedLegacyStorage &&
    !hasAccountScopedRecoveryKey &&
    !hasAccountScopedLegacyCryptoMigration
  ) {
    return;
  }

  const logger = getMatrixRuntime().logging.getChildLogger({ module: "matrix-storage" });
  fs.mkdirSync(params.storagePaths.rootDir, { recursive: true });
  const migrations: LegacyMigrationRecord[] = [];
  const pendingArchives: LegacyArchiveRecord[] = [];
  const skippedExistingTargets: string[] = [];
  try {
    if (hasAccountScopedLegacyStorage) {
      await migrateLegacySyncCacheToSqlite({
        sourceRootDir: params.storagePaths.rootDir,
        sourcePath: params.storagePaths.storagePath,
        targetRootDir: params.storagePaths.rootDir,
        label: "account sync cache",
        migrations,
        pendingArchives,
      });
    }
    if (hasAccountScopedRecoveryKey) {
      await migrateLegacyMatrixRecoveryKeyFilePathToStoreAsync(
        params.storagePaths.recoveryKeyPath,
        getMatrixRuntime().state,
      );
      migrations.push({
        sourcePath: params.storagePaths.recoveryKeyPath,
        targetDescription: `${params.storagePaths.rootDir} SQLite recovery key state`,
        label: "recovery key",
      });
    }
    if (hasAccountScopedLegacyCryptoMigration) {
      await migrateLegacyMatrixLegacyCryptoMigrationFileToStore(params.storagePaths.rootDir);
      migrations.push({
        sourcePath: path.join(params.storagePaths.rootDir, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME),
        targetDescription: `${params.storagePaths.rootDir} SQLite legacy crypto migration state`,
        label: "legacy crypto migration",
      });
    }
  } catch (err) {
    throw new Error(`Failed migrating legacy Matrix client storage: ${String(err)}`, {
      cause: err,
    });
  }
  for (const archive of pendingArchives) {
    archiveLegacyStoragePath({
      ...archive,
      skippedExistingTargets,
    });
  }
  if (migrations.length > 0) {
    logger.info(
      `matrix: migrated legacy client storage into ${params.storagePaths.rootDir}\n${migrations
        .map((entry) => `- ${entry.label}: ${entry.sourcePath} -> ${entry.targetDescription}`)
        .join("\n")}`,
    );
  }
  if (skippedExistingTargets.length > 0) {
    logger.warn?.(
      `matrix: legacy client storage files were left in place because their migrated targets already existed.\n${skippedExistingTargets.join("\n")}`,
    );
  }
}

async function migrateLegacySyncCacheToSqlite(params: {
  sourceRootDir: string;
  sourcePath: string;
  targetRootDir: string;
  label: string;
  migrations: LegacyMigrationRecord[];
  pendingArchives: LegacyArchiveRecord[];
}): Promise<void> {
  const syncCache = await import("./sync-cache-state.js");
  const persisted = await syncCache.readLegacyMatrixSyncCacheState(params.sourceRootDir);
  if (!persisted) {
    return;
  }
  const store = getMatrixRuntime().state.openKeyedStore<
    import("./sync-cache-state.js").MatrixSyncCacheRecord
  >(syncCache.openMatrixSyncCacheStoreOptions(params.targetRootDir));
  if (
    !(await syncCache.hasMatrixSyncCacheStateInStore({
      storageRootDir: params.targetRootDir,
      store,
    }))
  ) {
    await syncCache.writeMatrixSyncCacheStateToStore({
      storageRootDir: params.targetRootDir,
      payload: persisted,
      store,
    });
    await claimCurrentTokenStorageState({
      rootDir: params.targetRootDir,
    });
    params.migrations.push({
      sourcePath: params.sourcePath,
      targetDescription: `${params.targetRootDir} SQLite sync cache`,
      label: params.label,
    });
  }
  params.pendingArchives.push({
    sourcePath: params.sourcePath,
    label: params.label,
  });
}

function archiveLegacyStoragePath(params: {
  sourcePath: string;
  label: string;
  skippedExistingTargets: string[];
}): void {
  const archivedLegacyStoragePath = `${params.sourcePath}.migrated`;
  if (fs.existsSync(archivedLegacyStoragePath)) {
    params.skippedExistingTargets.push(
      `- ${params.label} remains at ${params.sourcePath} because ${archivedLegacyStoragePath} already exists`,
    );
    return;
  }
  fs.renameSync(params.sourcePath, archivedLegacyStoragePath);
}

type StorageMetaMutation =
  | { kind: "initialize"; metadata: MatrixStorageMetadata }
  | { kind: "device"; deviceId: string }
  | { kind: "claim" };

function prepareStorageMetaMutation(
  metadata: MatrixStorageMetadata,
  mutation: StorageMetaMutation,
): MatrixStorageMetadata | null {
  if (mutation.kind !== "initialize" && !metadata.accessTokenHash?.trim()) {
    return null;
  }
  return normalizeMatrixStorageMetadata({
    ...(mutation.kind === "initialize" ? mutation.metadata : metadata),
    accountId:
      mutation.kind === "initialize"
        ? mutation.metadata.accountId
        : (metadata.accountId ?? DEFAULT_ACCOUNT_KEY),
    // Initialization without an identity must not erase a device learned during a CAS wait.
    deviceId:
      mutation.kind === "device"
        ? mutation.deviceId
        : mutation.kind === "initialize"
          ? (mutation.metadata.deviceId ?? metadata.deviceId)
          : metadata.deviceId,
    currentTokenStateClaimed:
      mutation.kind === "claim" ||
      (mutation.kind === "initialize"
        ? (mutation.metadata.currentTokenStateClaimed ?? metadata.currentTokenStateClaimed === true)
        : metadata.currentTokenStateClaimed === true),
    createdAt: metadata.createdAt ?? new Date().toISOString(),
  });
}

async function mutateStorageMeta(rootDir: string, mutation: StorageMetaMutation): Promise<boolean> {
  try {
    const store = openStorageMetaStore(rootDir);
    const decode = (value: unknown) =>
      normalizeMatrixStorageMetadata(value) ??
      normalizeMatrixStorageMetadata(loadJsonFile(path.join(rootDir, STORAGE_META_FILENAME))) ??
      {};
    if (!store.observe || !store.compareAndApply) {
      // The published >=2026.9.4 host floor predates data-only comparisons.
      const legacyStore = getMatrixRuntime().state.openSyncKeyedStore<MatrixStorageMetadata>(
        openMatrixStorageMetaStoreOptions(rootDir),
      );
      const next = prepareStorageMetaMutation(
        decode(legacyStore.lookup(STORAGE_META_STATE_KEY)),
        mutation,
      );
      if (!next) {
        return false;
      }
      legacyStore.register(STORAGE_META_STATE_KEY, next);
      return true;
    }
    let observation = await store.observe(STORAGE_META_STATE_KEY);
    for (;;) {
      const next = prepareStorageMetaMutation(decode(observation.value), mutation);
      if (!next) {
        return false;
      }
      const result = await store.compareAndApply(STORAGE_META_STATE_KEY, observation.comparison, {
        operation: "update",
        action: "set",
        value: next,
      });
      if (result.status !== "conflict") {
        return true;
      }
      observation = result.current;
    }
  } catch {
    return false;
  }
}

export async function writeStorageMeta(params: {
  storagePaths: MatrixStoragePaths;
  homeserver: string;
  userId: string;
  accountId?: string | null;
  deviceId?: string | null;
  currentTokenStateClaimed?: boolean;
}): Promise<boolean> {
  return mutateStorageMeta(params.storagePaths.rootDir, {
    kind: "initialize",
    metadata: {
      homeserver: params.homeserver,
      userId: params.userId,
      accountId: params.accountId ?? DEFAULT_ACCOUNT_KEY,
      accessTokenHash: params.storagePaths.tokenHash,
      deviceId: params.deviceId ?? null,
      currentTokenStateClaimed: params.currentTokenStateClaimed,
    },
  });
}

export async function claimCurrentTokenStorageState(params: { rootDir: string }): Promise<boolean> {
  return mutateStorageMeta(params.rootDir, { kind: "claim" });
}

export async function recordCurrentStorageMetaDeviceId(params: {
  rootDir: string;
  deviceId: string;
}): Promise<boolean> {
  const rootDir = params.rootDir;
  const deviceId = params.deviceId.trim();
  if (!deviceId || !(await readStoredRootMetadata(rootDir)).accessTokenHash?.trim()) {
    return false;
  }
  return mutateStorageMeta(rootDir, { kind: "device", deviceId });
}

export async function repairCurrentTokenStorageMetaDeviceId(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  accountId?: string | null;
  deviceId: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<boolean> {
  const { homeserver, userId, accessToken, accountId, deviceId, env, stateDir } = params;
  const storagePaths = await resolveMatrixStoragePaths({
    homeserver,
    userId,
    accessToken,
    accountId,
    env,
    stateDir,
  });
  return writeStorageMeta({
    storagePaths,
    homeserver,
    userId,
    accountId,
    deviceId,
  });
}
