import fs from "node:fs";
import { MatrixClient } from "../sdk.js";
import { validateMatrixHomeserverUrl } from "./config.js";
import { ensureMatrixSdkLoggingConfigured } from "./logging.js";
import {
  maybeMigrateLegacyStorage,
  resolveMatrixStoragePaths,
  writeStorageMeta,
} from "./storage.js";

export async function createMatrixClient(params: {
  homeserver: string;
  userId?: string;
  accessToken: string;
  password?: string;
  deviceId?: string;
  encryption?: boolean;
  localTimeoutMs?: number;
  initialSyncLimit?: number;
  accountId?: string | null;
  autoBootstrapCrypto?: boolean;
}): Promise<MatrixClient> {
  ensureMatrixSdkLoggingConfigured();
  const env = process.env;
  const homeserver = validateMatrixHomeserverUrl(params.homeserver);
  const userId = params.userId?.trim() || "unknown";
  const matrixClientUserId = params.userId?.trim() || undefined;

  const storagePaths = resolveMatrixStoragePaths({
    homeserver,
    userId,
    accessToken: params.accessToken,
    accountId: params.accountId,
    env,
  });
  await maybeMigrateLegacyStorage({
    storagePaths,
    env,
  });
  fs.mkdirSync(storagePaths.rootDir, { recursive: true });

  writeStorageMeta({
    storagePaths,
    homeserver,
    userId,
    accountId: params.accountId,
  });

  const cryptoDatabasePrefix = `openclaw-matrix-${storagePaths.accountKey}-${storagePaths.tokenHash}`;

  return new MatrixClient(homeserver, params.accessToken, undefined, undefined, {
    userId: matrixClientUserId,
    password: params.password,
    deviceId: params.deviceId,
    encryption: params.encryption,
    localTimeoutMs: params.localTimeoutMs,
    initialSyncLimit: params.initialSyncLimit,
    recoveryKeyPath: storagePaths.recoveryKeyPath,
    idbSnapshotPath: storagePaths.idbSnapshotPath,
    cryptoDatabasePrefix,
    autoBootstrapCrypto: params.autoBootstrapCrypto,
  });
}
