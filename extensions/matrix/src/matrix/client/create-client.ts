import fs from "node:fs";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/infra-runtime";
import type { SsrFPolicy } from "../../runtime-api.js";
import type { MatrixClient } from "../sdk.js";
import { resolveValidatedMatrixHomeserverUrl } from "./config.js";
import {
  maybeMigrateLegacyStorage,
  resolveMatrixStoragePaths,
  writeStorageMeta,
} from "./storage.js";

type MatrixCreateClientRuntimeDeps = {
  MatrixClient: typeof import("../sdk.js").MatrixClient;
  ensureMatrixSdkLoggingConfigured: typeof import("./logging.js").ensureMatrixSdkLoggingConfigured;
};

let matrixCreateClientRuntimeDepsPromise: Promise<MatrixCreateClientRuntimeDeps> | undefined;

async function loadMatrixCreateClientRuntimeDeps(): Promise<MatrixCreateClientRuntimeDeps> {
  matrixCreateClientRuntimeDepsPromise ??= Promise.all([
    import("../sdk.js"),
    import("./logging.js"),
  ]).then(([sdkModule, loggingModule]) => ({
    MatrixClient: sdkModule.MatrixClient,
    ensureMatrixSdkLoggingConfigured: loggingModule.ensureMatrixSdkLoggingConfigured,
  }));
  return await matrixCreateClientRuntimeDepsPromise;
}

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
  allowPrivateNetwork?: boolean;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}): Promise<MatrixClient> {
  const { MatrixClient, ensureMatrixSdkLoggingConfigured } =
    await loadMatrixCreateClientRuntimeDeps();
  ensureMatrixSdkLoggingConfigured();
  const env = process.env;
  const homeserver = await resolveValidatedMatrixHomeserverUrl(params.homeserver, {
    allowPrivateNetwork: params.allowPrivateNetwork,
  });
  const userId = params.userId?.trim() || "unknown";
  const matrixClientUserId = params.userId?.trim() || undefined;

  const storagePaths = resolveMatrixStoragePaths({
    homeserver,
    userId,
    accessToken: params.accessToken,
    accountId: params.accountId,
    deviceId: params.deviceId,
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
    deviceId: params.deviceId,
  });

  const cryptoDatabasePrefix = `openclaw-matrix-${storagePaths.accountKey}-${storagePaths.tokenHash}`;

  return new MatrixClient(homeserver, params.accessToken, {
    userId: matrixClientUserId,
    password: params.password,
    deviceId: params.deviceId,
    encryption: params.encryption,
    localTimeoutMs: params.localTimeoutMs,
    initialSyncLimit: params.initialSyncLimit,
    storagePath: storagePaths.storagePath,
    recoveryKeyPath: storagePaths.recoveryKeyPath,
    idbSnapshotPath: storagePaths.idbSnapshotPath,
    cryptoDatabasePrefix,
    autoBootstrapCrypto: params.autoBootstrapCrypto,
    ssrfPolicy: params.ssrfPolicy,
    dispatcherPolicy: params.dispatcherPolicy,
  });
}
