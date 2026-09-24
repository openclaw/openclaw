import fs from "node:fs";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import {
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixClient } from "../sdk.js";
import { resolveValidatedMatrixHomeserverUrl } from "./config.js";
import {
  maybeMigrateLegacyStorage,
  resolveMatrixStoragePaths,
  writeStorageMeta,
} from "./storage.js";

const loadMatrixCreateClientRuntimeDeps = createLazyRuntimeModule(() =>
  Promise.all([import("../sdk.js"), import("./logging.js"), import("./file-sync-store.js")]).then(
    ([sdkModule, loggingModule, syncStoreModule]) => ({
      MatrixClient: sdkModule.MatrixClient,
      SqliteBackedMatrixSyncStore: syncStoreModule.SqliteBackedMatrixSyncStore,
      ensureMatrixSdkLoggingConfigured: loggingModule.ensureMatrixSdkLoggingConfigured,
    }),
  ),
);

export async function createMatrixClient(params: {
  homeserver: string;
  userId?: string;
  accessToken: string;
  password?: string;
  deviceId?: string;
  persistStorage?: boolean;
  encryption?: boolean;
  localTimeoutMs?: number;
  initialSyncLimit?: number;
  accountId?: string | null;
  autoBootstrapCrypto?: boolean;
  allowPrivateNetwork?: boolean;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}): Promise<MatrixClient> {
  const { MatrixClient, SqliteBackedMatrixSyncStore, ensureMatrixSdkLoggingConfigured } =
    await loadMatrixCreateClientRuntimeDeps();
  ensureMatrixSdkLoggingConfigured();
  const homeserver = await resolveValidatedMatrixHomeserverUrl(params.homeserver, {
    dangerouslyAllowPrivateNetwork: params.allowPrivateNetwork,
  });
  const matrixClientUserId = normalizeOptionalString(params.userId);
  const userId = matrixClientUserId ?? "unknown";
  const persistStorage = params.persistStorage !== false;
  const storagePaths = persistStorage
    ? await resolveMatrixStoragePaths({
        homeserver,
        userId,
        accessToken: params.accessToken,
        accountId: params.accountId,
        deviceId: params.deviceId,
        env: process.env,
      })
    : null;

  if (storagePaths) {
    await maybeMigrateLegacyStorage({
      storagePaths,
      env: process.env,
    });
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    await writeStorageMeta({
      storagePaths,
      homeserver,
      userId,
      accountId: params.accountId,
      deviceId: params.deviceId,
    });
  }

  const cryptoDatabasePrefix = storagePaths
    ? `openclaw-matrix-${storagePaths.accountKey}-${storagePaths.tokenHash}`
    : undefined;

  const syncStore = storagePaths
    ? await SqliteBackedMatrixSyncStore.create(storagePaths.rootDir)
    : undefined;

  return new MatrixClient(homeserver, params.accessToken, {
    userId: matrixClientUserId,
    password: params.password,
    deviceId: params.deviceId,
    encryption: params.encryption,
    localTimeoutMs: params.localTimeoutMs,
    initialSyncLimit: params.initialSyncLimit,
    syncStore,
    recoveryKeyPath: storagePaths?.recoveryKeyPath,
    idbSnapshotPath: storagePaths?.idbSnapshotPath,
    cryptoDatabasePrefix,
    autoBootstrapCrypto: params.autoBootstrapCrypto,
    ssrfPolicy:
      params.ssrfPolicy ?? ssrfPolicyFromDangerouslyAllowPrivateNetwork(params.allowPrivateNetwork),
    dispatcherPolicy: params.dispatcherPolicy,
    stateRuntime: getMatrixRuntime().state,
  });
}
