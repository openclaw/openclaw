import { createHash } from "node:crypto";
import path from "node:path";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { withMatrixSqliteStateEnv } from "../sqlite-state.js";

export const MATRIX_STORAGE_META_NAMESPACE = "storage-meta";

export type StoredRootMetadata = {
  rootDir?: string;
  homeserver?: string;
  userId?: string;
  accountId?: string;
  accessTokenHash?: string;
  deviceId?: string | null;
  currentTokenStateClaimed?: boolean;
  createdAt?: string;
};

const STORAGE_META_STORE = createPluginStateSyncKeyedStore<StoredRootMetadata>("matrix", {
  namespace: MATRIX_STORAGE_META_NAMESPACE,
  maxEntries: 10_000,
});

export function resolveMatrixStorageMetaKey(rootDir: string): string {
  return createHash("sha256").update(path.resolve(rootDir), "utf8").digest("hex").slice(0, 32);
}

function resolveStateDirFromMatrixStorageRoot(rootDir: string): string | undefined {
  const parts = path.resolve(rootDir).split(path.sep);
  const matrixIndex = parts.lastIndexOf("matrix");
  if (matrixIndex <= 0) {
    return undefined;
  }
  return parts.slice(0, matrixIndex).join(path.sep) || path.sep;
}

export function normalizeStoredRootMetadata(raw: unknown): StoredRootMetadata {
  const parsed =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Partial<StoredRootMetadata>)
      : {};
  const metadata: StoredRootMetadata = {};
  if (typeof parsed.rootDir === "string" && parsed.rootDir.trim()) {
    metadata.rootDir = path.resolve(parsed.rootDir.trim());
  }
  if (typeof parsed.homeserver === "string" && parsed.homeserver.trim()) {
    metadata.homeserver = parsed.homeserver.trim();
  }
  if (typeof parsed.userId === "string" && parsed.userId.trim()) {
    metadata.userId = parsed.userId.trim();
  }
  if (typeof parsed.accountId === "string" && parsed.accountId.trim()) {
    metadata.accountId = parsed.accountId.trim();
  }
  if (typeof parsed.accessTokenHash === "string" && parsed.accessTokenHash.trim()) {
    metadata.accessTokenHash = parsed.accessTokenHash.trim();
  }
  if (typeof parsed.deviceId === "string" && parsed.deviceId.trim()) {
    metadata.deviceId = parsed.deviceId.trim();
  } else if (parsed.deviceId === null) {
    metadata.deviceId = null;
  }
  if (parsed.currentTokenStateClaimed === true) {
    metadata.currentTokenStateClaimed = true;
  }
  if (typeof parsed.createdAt === "string" && parsed.createdAt.trim()) {
    metadata.createdAt = parsed.createdAt.trim();
  }
  return metadata;
}

export function readMatrixStorageMetadata(rootDir: string): StoredRootMetadata {
  const stateDir = resolveStateDirFromMatrixStorageRoot(rootDir);
  return withMatrixSqliteStateEnv(stateDir ? { stateDir } : undefined, () =>
    normalizeStoredRootMetadata(
      STORAGE_META_STORE.lookup(resolveMatrixStorageMetaKey(rootDir)) ?? {},
    ),
  );
}

export function writeMatrixStorageMetadata(rootDir: string, payload: StoredRootMetadata): boolean {
  try {
    const metadata = normalizeStoredRootMetadata(payload);
    metadata.rootDir = path.resolve(rootDir);
    const stateDir = resolveStateDirFromMatrixStorageRoot(rootDir);
    withMatrixSqliteStateEnv(stateDir ? { stateDir } : undefined, () => {
      STORAGE_META_STORE.register(resolveMatrixStorageMetaKey(rootDir), metadata);
    });
    return true;
  } catch {
    return false;
  }
}
