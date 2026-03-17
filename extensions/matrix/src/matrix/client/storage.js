import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMatrixRuntime } from "../../runtime.js";
const DEFAULT_ACCOUNT_KEY = "default";
const STORAGE_META_FILENAME = "storage-meta.json";
function sanitizePathSegment(value) {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}
function resolveHomeserverKey(homeserver) {
  try {
    const url = new URL(homeserver);
    if (url.host) {
      return sanitizePathSegment(url.host);
    }
  } catch {
  }
  return sanitizePathSegment(homeserver);
}
function hashAccessToken(accessToken) {
  return crypto.createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}
function resolveLegacyStoragePaths(env = process.env) {
  const stateDir = getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  return {
    storagePath: path.join(stateDir, "matrix", "bot-storage.json"),
    cryptoPath: path.join(stateDir, "matrix", "crypto")
  };
}
function resolveMatrixStoragePaths(params) {
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
    tokenHash
  );
  return {
    rootDir,
    storagePath: path.join(rootDir, "bot-storage.json"),
    cryptoPath: path.join(rootDir, "crypto"),
    metaPath: path.join(rootDir, STORAGE_META_FILENAME),
    accountKey,
    tokenHash
  };
}
function maybeMigrateLegacyStorage(params) {
  const legacy = resolveLegacyStoragePaths(params.env);
  const hasLegacyStorage = fs.existsSync(legacy.storagePath);
  const hasLegacyCrypto = fs.existsSync(legacy.cryptoPath);
  const hasNewStorage = fs.existsSync(params.storagePaths.storagePath) || fs.existsSync(params.storagePaths.cryptoPath);
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
    }
  }
  if (hasLegacyCrypto) {
    try {
      fs.renameSync(legacy.cryptoPath, params.storagePaths.cryptoPath);
    } catch {
    }
  }
}
function writeStorageMeta(params) {
  try {
    const payload = {
      homeserver: params.homeserver,
      userId: params.userId,
      accountId: params.accountId ?? DEFAULT_ACCOUNT_KEY,
      accessTokenHash: params.storagePaths.tokenHash,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    fs.mkdirSync(params.storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(params.storagePaths.metaPath, JSON.stringify(payload, null, 2), "utf-8");
  } catch {
  }
}
export {
  DEFAULT_ACCOUNT_KEY,
  maybeMigrateLegacyStorage,
  resolveMatrixStoragePaths,
  writeStorageMeta
};
