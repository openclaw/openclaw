/**
 * Type definitions for Matrix recovery key verification.
 */

/**
 * Recovery key representation at various stages of processing.
 */
export interface RecoveryKey {
  /** User-provided key (with/without spaces) */
  raw: string;
  /** Spaces removed, normalized */
  normalized: string;
  /** Base58-decoded 32 bytes (after parity verification) */
  decoded: Uint8Array;
  /** HMAC-SHA256 hash for replay protection */
  hash: string;
}

/**
 * Secret storage key metadata from Matrix account data.
 */
export interface SecretStorageKeyInfo {
  /** Algorithm name (must be "m.secret_storage.v1.aes-hmac-sha2") */
  algorithm: string;
  /** Key ID from m.secret_storage.default_key */
  keyId: string;
  /** Base64-encoded initialization vector */
  iv: string;
  /** Base64-encoded MAC for verification */
  mac: string;
  /** Optional passphrase derivation info (not supported in initial implementation) */
  passphrase?: {
    algorithm: string;
    salt: string;
    iterations: number;
  };
}

/**
 * Encrypted secret from account data.
 */
export interface EncryptedSecret {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded initialization vector */
  iv: string;
  /** Base64-encoded MAC */
  mac: string;
}

/**
 * Cross-signing key set with both public and private keys.
 */
export interface CrossSigningKeys {
  master: {
    /** Base64 ed25519 public key */
    publicKey: string;
    /** Decrypted private key (32 bytes) */
    privateKey: Uint8Array;
  };
  selfSigning: {
    /** Base64 ed25519 public key */
    publicKey: string;
    /** Decrypted private key (32 bytes) */
    privateKey: Uint8Array;
  };
  userSigning: {
    /** Base64 ed25519 public key */
    publicKey: string;
    /** Decrypted private key (32 bytes) */
    privateKey: Uint8Array;
  };
}

/**
 * Device verification state persisted to disk.
 */
export interface RecoveryKeyVerificationState {
  /** Is current device verified? */
  deviceVerified: boolean;
  /** Matrix device ID */
  deviceId: string | null;
  /** ISO timestamp of verification */
  verifiedAt: string | null;
  /** Used recovery keys for replay protection (24-hour TTL) */
  usedRecoveryKeys: Array<{
    /** HMAC-SHA256(key + deviceId) */
    keyHash: string;
    /** ISO timestamp when used */
    usedAt: string;
  }>;
  /** Active key backup version (if any) */
  keyBackupVersion: string | null;
  /** Number of Megolm sessions restored from backup */
  restoredSessionCount: number;
}

/**
 * Result of recovery key verification operation.
 */
export interface VerificationResult {
  /** Whether verification succeeded */
  success: boolean;
  /** Error message if verification failed */
  error?: string;
  /** Device ID that was verified */
  deviceId?: string;
  /** Whether key backup was restored */
  backupRestored: boolean;
  /** Number of sessions restored from backup */
  restoredSessionCount: number;
  /** Backup version used (if restored) */
  backupVersion?: string;
}

/**
 * Key backup information from homeserver.
 */
export interface BackupInfo {
  /** Backup version identifier */
  version: string;
  /** Backup algorithm (e.g., "m.megolm_backup.v1.curve25519-aes-sha2") */
  algorithm: string;
  /** Algorithm-specific authentication data */
  authData: {
    public_key?: string;
    [key: string]: unknown;
  };
}
