import path from "node:path";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import {
  migrateLegacyMatrixRecoveryKeyFilePathToStoreAsync,
  readLegacyMatrixRecoveryKeyFile,
  readMatrixRecoveryKeyStateForPathAsync,
  writeMatrixRecoveryKeyStateForPathAsync,
  type MatrixSnapshotStateRuntime,
} from "../crypto-state-store.js";
import { formatMatrixErrorReason } from "../errors.js";
import { LogService } from "./logger.js";
import type {
  MatrixCryptoBootstrapApi,
  MatrixCryptoCallbacks,
  MatrixGeneratedSecretStorageKey,
  MatrixSecretStorageStatus,
  MatrixStoredRecoveryKey,
} from "./types.js";

export function isRepairableSecretStorageAccessError(err: unknown): boolean {
  const message = formatMatrixErrorReason(err);
  if (!message) {
    return false;
  }
  if (message.includes("getsecretstoragekey callback returned falsey")) {
    return true;
  }
  // The homeserver still has secret storage, but the local recovery key cannot
  // authenticate/decrypt a required secret. During explicit bootstrap we can
  // recreate secret storage and continue with a new local baseline.
  if (message.includes("decrypting secret") && message.includes("bad mac")) {
    return true;
  }
  return false;
}

export class MatrixRecoveryKeyStore {
  private readonly secretStorageKeyCache = new Map<string, Uint8Array>();
  private stagedRecoveryKey: MatrixStoredRecoveryKey | null = null;
  private stagedRecoveryKeyUsed = false;
  private readonly stagedCacheKeyIds = new Set<string>();
  private readonly storageRootDir?: string;
  private readonly recoveryKeyPath?: string;
  private legacyRecoveryKeyPathOnMigrationFailure?: string;

  private pendingPersistence: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly stateRuntime?: MatrixSnapshotStateRuntime;

  constructor(recoveryKeyPath?: string, stateRuntime?: MatrixSnapshotStateRuntime) {
    this.recoveryKeyPath = recoveryKeyPath;
    this.storageRootDir = recoveryKeyPath ? path.dirname(recoveryKeyPath) : undefined;
    if (recoveryKeyPath) {
      this.stateRuntime = stateRuntime ?? getMatrixRuntime().state;
      const runtime = this.stateRuntime;
      void this.enqueuePersistence(async () => {
        try {
          await migrateLegacyMatrixRecoveryKeyFilePathToStoreAsync(recoveryKeyPath, runtime);
        } catch (err) {
          this.legacyRecoveryKeyPathOnMigrationFailure = recoveryKeyPath;
          LogService.warn("MatrixClientLite", "Failed to migrate Matrix recovery key state:", err);
        }
      });
    }
  }

  private enqueuePersistence<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Matrix recovery key store is closed"));
    }
    const pending = this.pendingPersistence.then(run);
    this.pendingPersistence = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }

  private async afterPersistence<T>(read: () => T | Promise<T>): Promise<T> {
    for (;;) {
      const pending = this.pendingPersistence;
      await pending;
      if (pending === this.pendingPersistence) {
        return read();
      }
    }
  }

  async drainPendingPersistence(): Promise<void> {
    await this.afterPersistence(() => {});
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.drainPendingPersistence();
  }

  buildCryptoCallbacks(): MatrixCryptoCallbacks {
    const getSecretStorageKey = ({
      keys,
    }: Parameters<NonNullable<MatrixCryptoCallbacks["getSecretStorageKey"]>>[0]): Promise<
      [string, Uint8Array] | null
    > =>
      this.afterPersistence(async () => {
        if (this.closed) {
          return null;
        }
        const requestedKeyIds = Object.keys(keys ?? {});
        if (requestedKeyIds.length === 0) {
          return null;
        }

        const staged = this.resolveStagedSecretStorageKey(requestedKeyIds);
        if (staged) {
          return staged;
        }

        for (const keyId of requestedKeyIds) {
          const cached = this.secretStorageKeyCache.get(keyId);
          if (cached) {
            return [keyId, new Uint8Array(cached)];
          }
        }

        const pending = this.pendingPersistence;
        const stored = await this.loadStoredRecoveryKey();
        if (this.closed) {
          return null;
        }
        if (pending !== this.pendingPersistence) {
          return getSecretStorageKey({ keys });
        }
        if (!stored?.privateKeyBase64) {
          return null;
        }
        const privateKey = new Uint8Array(Buffer.from(stored.privateKeyBase64, "base64"));
        if (privateKey.length === 0) {
          return null;
        }

        if (stored.keyId && requestedKeyIds.includes(stored.keyId)) {
          this.rememberSecretStorageKey(stored.keyId, privateKey);
          return [stored.keyId, privateKey];
        }

        const firstRequestedKeyId = requestedKeyIds[0];
        if (!firstRequestedKeyId) {
          return null;
        }
        this.rememberSecretStorageKey(firstRequestedKeyId, privateKey);
        return [firstRequestedKeyId, privateKey];
      });
    return {
      getSecretStorageKey,
      cacheSecretStorageKey: (keyId, keyInfo, key) => {
        if (this.closed) {
          return;
        }
        const privateKey = new Uint8Array(key);
        const normalizedKeyInfo: MatrixStoredRecoveryKey["keyInfo"] = {
          passphrase: keyInfo?.passphrase,
          name: typeof keyInfo?.name === "string" ? keyInfo.name : undefined,
        };
        this.rememberSecretStorageKey(keyId, privateKey);

        // The SDK's void callback admits a write; getters and dispatch join it.
        void this.saveRecoveryKeyToDisk({ keyId, keyInfo: normalizedKeyInfo, privateKey }, true);
      },
    };
  }

  async getRecoveryKeySummary(): Promise<{
    encodedPrivateKey?: string;
    keyId?: string | null;
    createdAt?: string;
  } | null> {
    const stored = await this.afterPersistence(() => this.loadStoredRecoveryKey());
    if (!stored) {
      return null;
    }
    return {
      encodedPrivateKey: stored.encodedPrivateKey,
      keyId: stored.keyId,
      createdAt: stored.createdAt,
    };
  }

  getSecretStorageKeyCandidate(keyId: string): Promise<Uint8Array | null> {
    return this.afterPersistence(async () => {
      if (this.closed) {
        return null;
      }
      const normalizedKeyId = keyId.trim();
      if (!normalizedKeyId) {
        return null;
      }
      const staged = this.resolveStagedSecretStorageKey([normalizedKeyId]);
      if (staged) {
        return staged[1];
      }
      const pending = this.pendingPersistence;
      const stored = await this.loadStoredRecoveryKey();
      if (this.closed) {
        return null;
      }
      if (pending !== this.pendingPersistence) {
        return this.getSecretStorageKeyCandidate(keyId);
      }
      if (!stored?.privateKeyBase64) {
        return null;
      }
      const privateKey = new Uint8Array(Buffer.from(stored.privateKeyBase64, "base64"));
      if (privateKey.length === 0) {
        return null;
      }
      this.rememberSecretStorageKey(normalizedKeyId, privateKey);
      return privateKey;
    });
  }

  private resolveEncodedRecoveryKeyInput(params: {
    encodedPrivateKey: string;
    keyId?: string | null;
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"];
  }): {
    encodedPrivateKey: string;
    privateKey: Uint8Array;
    keyId: string | null;
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"];
  } {
    const encodedPrivateKey = params.encodedPrivateKey.trim();
    if (!encodedPrivateKey) {
      throw new Error("Matrix recovery key is required");
    }
    let privateKey: Uint8Array;
    try {
      privateKey = decodeRecoveryKey(encodedPrivateKey);
    } catch (err) {
      throw new Error(`Invalid Matrix recovery key: ${formatErrorMessage(err)}`, {
        cause: err,
      });
    }
    const keyId =
      typeof params.keyId === "string" && params.keyId.trim() ? params.keyId.trim() : null;
    return {
      encodedPrivateKey,
      privateKey,
      keyId,
      keyInfo: params.keyInfo,
    };
  }

  stageEncodedRecoveryKey(params: {
    encodedPrivateKey: string;
    keyId?: string | null;
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"];
  }): Promise<void> {
    const prepared = this.resolveEncodedRecoveryKeyInput(params);
    return this.enqueuePersistence(async () => {
      const keyInfo = prepared.keyInfo ?? (await this.loadStoredRecoveryKey())?.keyInfo;
      this.clearStagedCache();
      this.stagedRecoveryKey = {
        version: 1,
        createdAt: new Date().toISOString(),
        keyId: prepared.keyId,
        encodedPrivateKey: prepared.encodedPrivateKey,
        privateKeyBase64: Buffer.from(prepared.privateKey).toString("base64"),
        keyInfo,
      };
    });
  }

  hasStagedRecoveryKeyBeenUsed(): boolean {
    return this.stagedRecoveryKeyUsed;
  }

  async commitStagedRecoveryKey(params?: {
    keyId?: string | null;
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"];
  }): Promise<{
    encodedPrivateKey?: string;
    keyId?: string | null;
    createdAt?: string;
  } | null> {
    await this.enqueuePersistence(async () => {
      if (!this.stagedRecoveryKey) {
        return;
      }
      const staged = this.stagedRecoveryKey;
      const privateKey = new Uint8Array(Buffer.from(staged.privateKeyBase64, "base64"));
      const keyId =
        typeof params?.keyId === "string" && params.keyId.trim()
          ? params.keyId.trim()
          : staged.keyId;
      await this.persistRecoveryKey({
        keyId,
        keyInfo: params?.keyInfo ?? staged.keyInfo,
        privateKey,
        encodedPrivateKey: staged.encodedPrivateKey,
      });
      this.clearStagedRecoveryKeyTracking();
    });
    return this.getRecoveryKeySummary();
  }

  discardStagedRecoveryKey(): Promise<void> {
    return this.enqueuePersistence(async () => this.clearStagedCache());
  }

  private clearStagedCache(): void {
    for (const keyId of this.stagedCacheKeyIds) {
      this.secretStorageKeyCache.delete(keyId);
    }
    this.clearStagedRecoveryKeyTracking();
  }

  async bootstrapSecretStorageWithRecoveryKey(
    crypto: MatrixCryptoBootstrapApi,
    options: {
      setupNewKeyBackup?: boolean;
      allowSecretStorageRecreateWithoutRecoveryKey?: boolean;
      forceNewSecretStorage?: boolean;
      forceNewRecoveryKey?: boolean;
    } = {},
  ): Promise<void> {
    await this.drainPendingPersistence();
    let status: MatrixSecretStorageStatus | null = null;
    const getSecretStorageStatus = crypto.getSecretStorageStatus; // pragma: allowlist secret
    if (typeof getSecretStorageStatus === "function") {
      try {
        status = await getSecretStorageStatus.call(crypto);
      } catch (err) {
        LogService.warn("MatrixClientLite", "Failed to read secret storage status:", err);
      }
    }

    const hasDefaultSecretStorageKey = Boolean(status?.defaultKeyId);
    const hasKnownInvalidSecrets = Object.values(status?.secretStorageKeyValidityMap ?? {}).some(
      (valid) => !valid,
    );
    let generatedRecoveryKey = false;
    const storedRecovery = await this.afterPersistence(() => this.loadStoredRecoveryKey());
    const stagedRecovery = this.stagedRecoveryKey;
    const sourceRecovery =
      options.forceNewRecoveryKey === true ? null : (stagedRecovery ?? storedRecovery);
    let recoveryKey: MatrixGeneratedSecretStorageKey | null = sourceRecovery
      ? {
          keyInfo: sourceRecovery.keyInfo,
          privateKey: new Uint8Array(Buffer.from(sourceRecovery.privateKeyBase64, "base64")),
          encodedPrivateKey: sourceRecovery.encodedPrivateKey,
        }
      : null;

    if (recoveryKey && status?.defaultKeyId) {
      const defaultKeyId = status.defaultKeyId;
      if (!stagedRecovery) {
        this.rememberSecretStorageKey(defaultKeyId, recoveryKey.privateKey);
        if (storedRecovery && storedRecovery.keyId !== defaultKeyId) {
          await this.saveRecoveryKeyToDisk({
            keyId: defaultKeyId,
            keyInfo: recoveryKey.keyInfo,
            privateKey: recoveryKey.privateKey,
            encodedPrivateKey: recoveryKey.encodedPrivateKey,
          });
        }
      }
    }

    const ensureRecoveryKey = async (): Promise<MatrixGeneratedSecretStorageKey> => {
      if (recoveryKey) {
        if (stagedRecovery) {
          this.stagedRecoveryKeyUsed = true;
        }
        return recoveryKey;
      }
      if (typeof crypto.createRecoveryKeyFromPassphrase !== "function") {
        throw new Error(
          "Matrix crypto backend does not support recovery key generation (createRecoveryKeyFromPassphrase missing)",
        );
      }
      recoveryKey = await crypto.createRecoveryKeyFromPassphrase();
      await this.saveRecoveryKeyToDisk(recoveryKey);
      generatedRecoveryKey = true;
      return recoveryKey;
    };

    const shouldRecreateSecretStorage =
      options.forceNewSecretStorage === true ||
      !hasDefaultSecretStorageKey ||
      (!recoveryKey && status?.ready === false) ||
      hasKnownInvalidSecrets;

    if (hasKnownInvalidSecrets) {
      // Existing secret storage keys can't decrypt required secrets. Generate a fresh recovery key.
      recoveryKey = null;
    }

    const secretStorageOptions: {
      createSecretStorageKey?: () => Promise<MatrixGeneratedSecretStorageKey>;
      setupNewSecretStorage?: boolean;
      setupNewKeyBackup?: boolean;
    } = {
      setupNewKeyBackup: options.setupNewKeyBackup === true,
    };

    if (shouldRecreateSecretStorage) {
      secretStorageOptions.setupNewSecretStorage = true;
      secretStorageOptions.createSecretStorageKey = ensureRecoveryKey;
    }

    try {
      try {
        await crypto.bootstrapSecretStorage(secretStorageOptions);
      } finally {
        await this.drainPendingPersistence();
      }
    } catch (err) {
      const shouldRecreateWithoutRecoveryKey =
        options.allowSecretStorageRecreateWithoutRecoveryKey === true &&
        hasDefaultSecretStorageKey &&
        isRepairableSecretStorageAccessError(err);
      if (!shouldRecreateWithoutRecoveryKey) {
        throw err;
      }

      recoveryKey = null;
      LogService.warn(
        "MatrixClientLite",
        "Secret storage exists on the server but local recovery material cannot unlock it; recreating secret storage during explicit bootstrap.",
      );
      try {
        await crypto.bootstrapSecretStorage({
          setupNewSecretStorage: true,
          setupNewKeyBackup: options.setupNewKeyBackup === true,
          createSecretStorageKey: ensureRecoveryKey,
        });
      } finally {
        await this.drainPendingPersistence();
      }
    }

    if (generatedRecoveryKey && this.storageRootDir) {
      LogService.warn(
        "MatrixClientLite",
        "Generated Matrix recovery key and saved it to Matrix SQLite state. Keep the displayed recovery key secure.",
      );
    }
  }

  private clearStagedRecoveryKeyTracking(): void {
    this.stagedRecoveryKey = null;
    this.stagedRecoveryKeyUsed = false;
    this.stagedCacheKeyIds.clear();
  }

  private resolveStagedSecretStorageKey(requestedKeyIds: string[]): [string, Uint8Array] | null {
    const staged = this.stagedRecoveryKey;
    if (!staged?.privateKeyBase64) {
      return null;
    }
    const privateKey = new Uint8Array(Buffer.from(staged.privateKeyBase64, "base64"));
    if (privateKey.length === 0) {
      return null;
    }
    const keyId =
      staged.keyId && requestedKeyIds.includes(staged.keyId) ? staged.keyId : requestedKeyIds[0];
    if (!keyId) {
      return null;
    }
    this.stagedRecoveryKeyUsed = true;
    this.rememberSecretStorageKey(keyId, privateKey);
    this.stagedCacheKeyIds.add(keyId);
    return [keyId, privateKey];
  }

  private rememberSecretStorageKey(keyId: string, key: Uint8Array): void {
    if (!keyId.trim()) {
      return;
    }
    this.secretStorageKeyCache.set(keyId, new Uint8Array(key));
  }

  private async loadStoredRecoveryKey(): Promise<MatrixStoredRecoveryKey | null> {
    if (!this.recoveryKeyPath || !this.stateRuntime) {
      return null;
    }
    try {
      const stored = await readMatrixRecoveryKeyStateForPathAsync(
        this.recoveryKeyPath,
        this.stateRuntime,
      );
      if (stored) {
        return stored;
      }
    } catch {
      // If the SQLite migration failed during construction, keep the readable
      // legacy file usable for this run and leave it unarchived for retry.
    }
    if (this.legacyRecoveryKeyPathOnMigrationFailure) {
      return readLegacyMatrixRecoveryKeyFile(this.legacyRecoveryKeyPathOnMigrationFailure);
    }
    return null;
  }

  private saveRecoveryKeyToDisk(
    params: MatrixGeneratedSecretStorageKey,
    preserveEncodedPrivateKey = false,
  ): Promise<void> {
    return this.enqueuePersistence(() =>
      this.persistRecoveryKey(params, preserveEncodedPrivateKey),
    );
  }

  private async persistRecoveryKey(
    params: MatrixGeneratedSecretStorageKey,
    preserveEncodedPrivateKey = false,
  ): Promise<void> {
    if (!this.recoveryKeyPath || !this.stateRuntime) {
      return;
    }
    try {
      const payload: MatrixStoredRecoveryKey = {
        version: 1,
        createdAt: new Date().toISOString(),
        keyId: typeof params.keyId === "string" ? params.keyId : null,
        encodedPrivateKey: params.encodedPrivateKey,
        privateKeyBase64: Buffer.from(params.privateKey).toString("base64"),
        keyInfo: params.keyInfo
          ? {
              passphrase: params.keyInfo.passphrase,
              name: params.keyInfo.name,
            }
          : undefined,
      };
      await writeMatrixRecoveryKeyStateForPathAsync({
        recoveryKeyPath: this.recoveryKeyPath,
        payload,
        stateRuntime: this.stateRuntime,
        preserveEncodedPrivateKey,
      });
    } catch (err) {
      LogService.warn("MatrixClientLite", "Failed to persist recovery key:", err);
    }
  }
}
