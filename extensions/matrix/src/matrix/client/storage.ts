import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { getMatrixRuntime } from "../../runtime.js";
import { resolveMatrixAccountStorageRoot } from "../../storage-paths.js";
import {
  readMatrixStorageMetadata,
  writeMatrixStorageMetadata,
  type StoredRootMetadata,
} from "./storage-meta-state.js";
import type { MatrixAuth } from "./types.js";
import type { MatrixStoragePaths } from "./types.js";

const DEFAULT_ACCOUNT_KEY = "default";
const STORAGE_META_FILENAME = "storage-meta.json";
const THREAD_BINDINGS_FILENAME = "thread-bindings.json";
const LEGACY_CRYPTO_MIGRATION_FILENAME = "legacy-crypto-migration.json";
const RECOVERY_KEY_FILENAME = "recovery-key.json";
const IDB_SNAPSHOT_FILENAME = "crypto-idb-snapshot.json";

function scoreStorageRoot(rootDir: string): number {
  let score = 0;
  if (fs.existsSync(path.join(rootDir, "bot-storage.json"))) {
    score += 8;
  }
  if (fs.existsSync(path.join(rootDir, "crypto"))) {
    score += 8;
  }
  if (fs.existsSync(path.join(rootDir, THREAD_BINDINGS_FILENAME))) {
    score += 4;
  }
  if (fs.existsSync(path.join(rootDir, LEGACY_CRYPTO_MIGRATION_FILENAME))) {
    score += 3;
  }
  if (fs.existsSync(path.join(rootDir, RECOVERY_KEY_FILENAME))) {
    score += 2;
  }
  if (fs.existsSync(path.join(rootDir, IDB_SNAPSHOT_FILENAME))) {
    score += 2;
  }
  if (Object.keys(readStoredRootMetadata(rootDir)).length > 0) {
    score += 1;
  }
  return score;
}

function resolveStorageRootMtimeMs(rootDir: string): number {
  try {
    return fs.statSync(rootDir).mtimeMs;
  } catch {
    return 0;
  }
}

function readStoredRootMetadata(rootDir: string): StoredRootMetadata {
  return readMatrixStorageMetadata(rootDir);
}

function isCompatibleStorageRoot(params: {
  candidateRootDir: string;
  homeserver: string;
  userId: string;
  accountKey: string;
  deviceId?: string | null;
  requireExplicitDeviceMatch?: boolean;
}): boolean {
  const metadata = readStoredRootMetadata(params.candidateRootDir);
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

function resolvePreferredMatrixStorageRoot(params: {
  canonicalRootDir: string;
  canonicalTokenHash: string;
  homeserver: string;
  userId: string;
  accountKey: string;
  deviceId?: string | null;
}): {
  rootDir: string;
  tokenHash: string;
} {
  const parentDir = path.dirname(params.canonicalRootDir);
  const bestCurrentScore = scoreStorageRoot(params.canonicalRootDir);
  let best = {
    rootDir: params.canonicalRootDir,
    tokenHash: params.canonicalTokenHash,
    score: bestCurrentScore,
    mtimeMs: resolveStorageRootMtimeMs(params.canonicalRootDir),
  };

  // Without a confirmed device identity, reusing a populated sibling root after
  // token rotation can silently bind this run to the wrong Matrix device state.
  if (!params.deviceId?.trim()) {
    return {
      rootDir: best.rootDir,
      tokenHash: best.tokenHash,
    };
  }

  const canonicalMetadata = readStoredRootMetadata(params.canonicalRootDir);
  if (
    canonicalMetadata.accessTokenHash === params.canonicalTokenHash &&
    canonicalMetadata.deviceId?.trim() === params.deviceId.trim() &&
    canonicalMetadata.currentTokenStateClaimed === true
  ) {
    return {
      rootDir: best.rootDir,
      tokenHash: best.tokenHash,
    };
  }

  let siblingEntries: fs.Dirent[] = [];
  try {
    siblingEntries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return {
      rootDir: best.rootDir,
      tokenHash: best.tokenHash,
    };
  }

  for (const entry of siblingEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === params.canonicalTokenHash) {
      continue;
    }
    const candidateRootDir = path.join(parentDir, entry.name);
    if (
      !isCompatibleStorageRoot({
        candidateRootDir,
        homeserver: params.homeserver,
        userId: params.userId,
        accountKey: params.accountKey,
        deviceId: params.deviceId,
        // Once auth resolves a concrete device, only sibling roots that explicitly
        // declare that same device are safe to reuse across token rotations.
        requireExplicitDeviceMatch: Boolean(params.deviceId),
      })
    ) {
      continue;
    }
    const candidateScore = scoreStorageRoot(candidateRootDir);
    if (candidateScore <= 0) {
      continue;
    }
    const candidateMtimeMs = resolveStorageRootMtimeMs(candidateRootDir);
    if (
      candidateScore > best.score ||
      (best.rootDir !== params.canonicalRootDir &&
        candidateScore === best.score &&
        candidateMtimeMs > best.mtimeMs)
    ) {
      best = {
        rootDir: candidateRootDir,
        tokenHash: entry.name,
        score: candidateScore,
        mtimeMs: candidateMtimeMs,
      };
    }
  }

  return {
    rootDir: best.rootDir,
    tokenHash: best.tokenHash,
  };
}

export function resolveMatrixStoragePaths(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  accountId?: string | null;
  deviceId?: string | null;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): MatrixStoragePaths {
  const env = params.env ?? process.env;
  const stateDir = params.stateDir ?? getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  const canonical = resolveMatrixAccountStorageRoot({
    stateDir,
    homeserver: params.homeserver,
    userId: params.userId,
    accessToken: params.accessToken,
    accountId: params.accountId,
  });
  const { rootDir, tokenHash } = resolvePreferredMatrixStorageRoot({
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
    metaPath: path.join(rootDir, STORAGE_META_FILENAME),
    recoveryKeyPath: path.join(rootDir, "recovery-key.json"),
    idbSnapshotPath: path.join(rootDir, IDB_SNAPSHOT_FILENAME),
    accountKey: canonical.accountKey,
    tokenHash,
  };
}

export function resolveMatrixStateFilePath(params: {
  auth: MatrixAuth;
  filename: string;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): string {
  const storagePaths = resolveMatrixStoragePaths({
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

function writeStoredRootMetadata(
  rootDir: string,
  payload: {
    homeserver?: string;
    userId?: string;
    accountId: string;
    accessTokenHash?: string;
    deviceId: string | null;
    currentTokenStateClaimed: boolean;
    createdAt: string;
  },
): boolean {
  return writeMatrixStorageMetadata(rootDir, payload);
}

export function writeStorageMeta(params: {
  storagePaths: MatrixStoragePaths;
  homeserver: string;
  userId: string;
  accountId?: string | null;
  deviceId?: string | null;
  currentTokenStateClaimed?: boolean;
}): boolean {
  const existing = readStoredRootMetadata(params.storagePaths.rootDir);
  return writeStoredRootMetadata(params.storagePaths.rootDir, {
    homeserver: params.homeserver,
    userId: params.userId,
    accountId: params.accountId ?? DEFAULT_ACCOUNT_KEY,
    accessTokenHash: params.storagePaths.tokenHash,
    deviceId: params.deviceId ?? null,
    currentTokenStateClaimed:
      params.currentTokenStateClaimed ?? existing.currentTokenStateClaimed === true,
    createdAt: existing.createdAt ?? new Date().toISOString(),
  });
}

export function claimCurrentTokenStorageState(params: { rootDir: string }): boolean {
  const metadata = readStoredRootMetadata(params.rootDir);
  if (!metadata.accessTokenHash?.trim()) {
    return false;
  }
  return writeStoredRootMetadata(params.rootDir, {
    homeserver: metadata.homeserver,
    userId: metadata.userId,
    accountId: metadata.accountId ?? DEFAULT_ACCOUNT_KEY,
    accessTokenHash: metadata.accessTokenHash,
    deviceId: metadata.deviceId ?? null,
    currentTokenStateClaimed: true,
    createdAt: metadata.createdAt ?? new Date().toISOString(),
  });
}

export function repairCurrentTokenStorageMetaDeviceId(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  accountId?: string | null;
  deviceId: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): boolean {
  const storagePaths = resolveMatrixStoragePaths({
    homeserver: params.homeserver,
    userId: params.userId,
    accessToken: params.accessToken,
    accountId: params.accountId,
    env: params.env,
    stateDir: params.stateDir,
  });
  return writeStorageMeta({
    storagePaths,
    homeserver: params.homeserver,
    userId: params.userId,
    accountId: params.accountId,
    deviceId: params.deviceId,
  });
}
