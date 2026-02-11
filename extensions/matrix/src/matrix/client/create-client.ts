import type {
  ICryptoStorageProvider,
  IStorageProvider,
  MatrixClient,
} from "@vector-im/matrix-bot-sdk";
import fs from "node:fs";
import { ensureMatrixSdkLoggingConfigured } from "./logging.js";
import {
  maybeMigrateLegacyStorage,
  resolveMatrixStoragePaths,
  writeStorageMeta,
} from "./storage.js";

function sanitizeUserIdList(
  input: unknown,
  label: string,
  warn: (message: string) => void,
): string[] {
  if (input == null) {
    return [];
  }
  if (!Array.isArray(input)) {
    warn(`Expected ${label} list to be an array, got ${typeof input}`);
    return [];
  }
  const filtered = input.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  if (filtered.length !== input.length) {
    warn(`Dropping ${input.length - filtered.length} invalid ${label} entries from sync payload`);
  }
  return filtered;
}

export async function createMatrixClient(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  encryption?: boolean;
  localTimeoutMs?: number;
  accountId?: string | null;
}): Promise<MatrixClient> {
  ensureMatrixSdkLoggingConfigured();
  const env = process.env;
  const sdk = await import("@vector-im/matrix-bot-sdk");
  const { LogService, MatrixClient, SimpleFsStorageProvider, RustSdkCryptoStorageProvider } = sdk;
  const warn = (message: string, extra?: unknown) => {
    if (extra === undefined) {
      LogService.warn("MatrixClientLite", message);
    } else {
      LogService.warn("MatrixClientLite", message, extra);
    }
  };

  // Create storage provider
  const storagePaths = resolveMatrixStoragePaths({
    homeserver: params.homeserver,
    userId: params.userId,
    accessToken: params.accessToken,
    accountId: params.accountId,
    env,
  });
  maybeMigrateLegacyStorage({ storagePaths, env });
  fs.mkdirSync(storagePaths.rootDir, { recursive: true });
  const storage: IStorageProvider = new SimpleFsStorageProvider(storagePaths.storagePath);

  // Create crypto storage if encryption is enabled
  let cryptoStorage: ICryptoStorageProvider | undefined;
  if (params.encryption) {
    fs.mkdirSync(storagePaths.cryptoPath, { recursive: true });

    try {
      const { StoreType } = await import("@matrix-org/matrix-sdk-crypto-nodejs");
      cryptoStorage = new RustSdkCryptoStorageProvider(storagePaths.cryptoPath, StoreType.Sqlite);
    } catch (err) {
      warn("Failed to initialize crypto storage, E2EE disabled:", err);
    }
  }

  writeStorageMeta({
    storagePaths,
    homeserver: params.homeserver,
    userId: params.userId,
    accountId: params.accountId,
  });

  const client = new MatrixClient(params.homeserver, params.accessToken, storage, cryptoStorage);

  if (client.crypto) {
    const originalUpdateSyncData = client.crypto.updateSyncData.bind(client.crypto);
    client.crypto.updateSyncData = async (
      toDeviceMessages,
      otkCounts,
      unusedFallbackKeyAlgs,
      changedDeviceLists,
      leftDeviceLists,
    ) => {
      const safeChanged = sanitizeUserIdList(changedDeviceLists, "changed device list", warn);
      const safeLeft = sanitizeUserIdList(leftDeviceLists, "left device list", warn);
      try {
        return await originalUpdateSyncData(
          toDeviceMessages,
          otkCounts,
          unusedFallbackKeyAlgs,
          safeChanged,
          safeLeft,
        );
      } catch (err) {
        const message = typeof err === "string" ? err : err instanceof Error ? err.message : "";
        if (message.includes("Expect value to be String")) {
          warn("Ignoring malformed device list entries during crypto sync", message);
          return;
        }
        throw err;
      }
    };
  }

  return client;
}
