import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixStoragePaths } from "./types.js";

export const DEFAULT_ACCOUNT_KEY = "default";
const STORAGE_META_FILENAME = "storage-meta.json";

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
    if (url.host) return sanitizePathSegment(url.host);
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
    tokenHash,
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

export function maybeMigrateLegacyStorage(params: {
  storagePaths: MatrixStoragePaths;
  env?: NodeJS.ProcessEnv;
}): void {
  const legacy = resolveLegacyStoragePaths(params.env);
  const hasLegacyStorage = fs.existsSync(legacy.storagePath);
  const hasLegacyCrypto = fs.existsSync(legacy.cryptoPath);
  const hasNewStorage =
    fs.existsSync(params.storagePaths.storagePath) ||
    fs.existsSync(params.storagePaths.cryptoPath);

  if (!hasLegacyStorage && !hasLegacyCrypto) return;
  if (hasNewStorage) return;

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
    fs.writeFileSync(
      params.storagePaths.metaPath,
      JSON.stringify(payload, null, 2),
      "utf-8",
    );
  } catch {
    // ignore meta write failures
  }
}
