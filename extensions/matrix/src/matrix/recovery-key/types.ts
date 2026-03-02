/** Metadata for a secret storage key (m.secret_storage.key.<keyId>). */
export type SecretStorageKeyInfo = {
  algorithm: string;
  iv?: string;
  mac?: string;
  passphrase?: {
    algorithm: string;
    iterations: number;
    salt: string;
    bits?: number;
  };
};

/** An encrypted secret stored in Matrix account data. */
export type EncryptedSecret = {
  iv: string;
  ciphertext: string;
  mac: string;
};

/** Decrypted cross-signing key material. */
export type CrossSigningKeys = {
  masterKey: Uint8Array;
  masterKeyPublic: string;
  selfSigningKey: Uint8Array;
  selfSigningKeyPublic: string;
  userSigningKey: Uint8Array;
  userSigningKeyPublic: string;
};

/** Persisted verification state shape. */
export type RecoveryKeyVerificationState = {
  verified: boolean;
  deviceId: string | null;
  verifiedAt: string | null;
  usedKeyHashes: Array<{ hash: string; usedAt: string }>;
  backupVersion: string | null;
};

/** Result returned by the recovery key handler. */
export type VerificationResult = {
  success: boolean;
  error?: string;
  deviceId?: string;
  verifiedAt?: string;
  backupVersion?: string | null;
  backupKeysRestored?: number;
};

/** Key backup metadata from the homeserver. */
export type BackupInfo = {
  version: string;
  algorithm: string;
  authData: Record<string, unknown>;
  count?: number;
  etag?: string;
};
