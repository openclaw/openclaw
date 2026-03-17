import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixStoragePaths } from "./types.js";

export const DEFAULT_ACCOUNT_KEY = "default";
const STORAGE_META_FILENAME = "storage-meta.json";

/** Fixed segment so storage (and E2EE device keys) persists across access token changes. */
const STORAGE_DIR_NAME = "store";

function sanitizePathSegment(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

function resolveHomeserverKey(homeserver: string): string {
  try {
    const url = new URL(homeserver);
    if (url.host) {
      return sanitizePathSegment(url.host);
    }
  } catch {
    // fall through
  }
  return sanitizePathSegment(homeserver);
}

function hashAccessToken(accessToken: string): string {
  return crypto.createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

function resolveLegacyStoragePaths(env: NodeJS.ProcessEnv = process.env): {
  storagePath: string;
  cryptoPath: string;
} {
  const stateDir = getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  return {
    storagePath: path.join(stateDir, "matrix", "bot-storage.json"),
    cryptoPath: path.join(stateDir, "matrix", "crypto"),
  };
}

export function resolveMatrixStoragePaths(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): MatrixStoragePaths {
  const env = params.env ?? process.env;
  const stateDir = getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  const accountKey = sanitizePathSegment(params.accountId ?? DEFAULT_ACCOUNT_KEY);
  const userKey = sanitizePathSegment(params.userId);
  const serverKey = resolveHomeserverKey(params.homeserver);
  const tokenHash = hashAccessToken(params.accessToken);
  const rootDir = path.join(
    stateDir,
    "matrix",
    "accounts",
    accountKey,
    `${serverKey}__${userKey}`,
    STORAGE_DIR_NAME,
  );
  return {
    rootDir,
    storagePath: path.join(rootDir, "bot-storage.json"),
    cryptoPath: path.join(rootDir, "crypto"),
    metaPath: path.join(rootDir, STORAGE_META_FILENAME),
    accountKey,
    tokenHash,
  };
}

/** 16-char hex pattern used for legacy per-token storage dirs. */
const TOKEN_HASH_DIR_PATTERN = /^[a-f0-9]{16}$/;

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function migrateFromLegacyDir(oldRoot: string, storagePaths: MatrixStoragePaths): boolean {
  const oldCrypto = path.join(oldRoot, "crypto");
  const oldStorage = path.join(oldRoot, "bot-storage.json");
  const hasOldCrypto = fs.existsSync(oldCrypto);
  const hasOldStorage = fs.existsSync(oldStorage);
  if (!hasOldCrypto && !hasOldStorage) {
    return false;
  }

  fs.mkdirSync(storagePaths.rootDir, { recursive: true });
  try {
    if (hasOldCrypto && !fs.existsSync(storagePaths.cryptoPath)) {
      copyDirRecursive(oldCrypto, storagePaths.cryptoPath);
    }
    if (hasOldStorage && !fs.existsSync(storagePaths.storagePath)) {
      fs.copyFileSync(oldStorage, storagePaths.storagePath);
    }
  } catch {
    return false;
  }

  try {
    fs.rmSync(oldRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only; ignore failures.
  }

  return true;
}

/**
 * Migrate crypto and bot-storage from legacy tokenHash subdirs into the stable store dir.
 * Ensures device keys persist across access token changes (fixes #48749).
 */
export function maybeMigrateFromTokenHashDirs(params: { storagePaths: MatrixStoragePaths }): void {
  const accountBaseDir = path.dirname(params.storagePaths.rootDir);
  if (!fs.existsSync(accountBaseDir)) {
    return;
  }
  if (
    fs.existsSync(params.storagePaths.cryptoPath) &&
    fs.existsSync(params.storagePaths.storagePath)
  ) {
    return;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(accountBaseDir);
  } catch {
    return;
  }

  const tokenHashDirs = entries
    .filter((name) => name !== STORAGE_DIR_NAME && TOKEN_HASH_DIR_PATTERN.test(name))
    .sort((a, b) => {
      try {
        const mtimeA = fs.statSync(path.join(accountBaseDir, a)).mtimeMs;
        const mtimeB = fs.statSync(path.join(accountBaseDir, b)).mtimeMs;
        return mtimeB - mtimeA; // newest first
      } catch {
        return 0;
      }
    });

  // First pass: prefer dirs that have both crypto and bot-storage.
  for (const dir of tokenHashDirs) {
    const oldRoot = path.join(accountBaseDir, dir);
    const hasCrypto = fs.existsSync(path.join(oldRoot, "crypto"));
    const hasStorage = fs.existsSync(path.join(oldRoot, "bot-storage.json"));
    if (hasCrypto && hasStorage && migrateFromLegacyDir(oldRoot, params.storagePaths)) {
      return;
    }
  }

  // Second pass: accept partial dirs (crypto only or storage only) as a fallback.
  for (const dir of tokenHashDirs) {
    const oldRoot = path.join(accountBaseDir, dir);
    if (migrateFromLegacyDir(oldRoot, params.storagePaths)) {
      return;
    }
  }
}

export function maybeMigrateLegacyStorage(params: {
  storagePaths: MatrixStoragePaths;
  env?: NodeJS.ProcessEnv;
}): void {
  const legacy = resolveLegacyStoragePaths(params.env);
  const hasLegacyStorage = fs.existsSync(legacy.storagePath);
  const hasLegacyCrypto = fs.existsSync(legacy.cryptoPath);
  const hasNewStorage =
    fs.existsSync(params.storagePaths.storagePath) || fs.existsSync(params.storagePaths.cryptoPath);

  if (!hasLegacyStorage && !hasLegacyCrypto) {
    return;
  }
  if (hasNewStorage) {
    return;
  }

  fs.mkdirSync(params.storagePaths.rootDir, { recursive: true });
  if (hasLegacyStorage) {
    try {
      fs.renameSync(legacy.storagePath, params.storagePaths.storagePath);
    } catch {
      // Ignore migration failures; new store will be created.
    }
  }
  if (hasLegacyCrypto) {
    try {
      fs.renameSync(legacy.cryptoPath, params.storagePaths.cryptoPath);
    } catch {
      // Ignore migration failures; new store will be created.
    }
  }
}

export function writeStorageMeta(params: {
  storagePaths: MatrixStoragePaths;
  homeserver: string;
  userId: string;
  accountId?: string | null;
}): void {
  try {
    const payload = {
      homeserver: params.homeserver,
      userId: params.userId,
      accountId: params.accountId ?? DEFAULT_ACCOUNT_KEY,
      accessTokenHash: params.storagePaths.tokenHash,
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(params.storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(params.storagePaths.metaPath, JSON.stringify(payload, null, 2), "utf-8");
  } catch {
    // ignore meta write failures
  }
}
