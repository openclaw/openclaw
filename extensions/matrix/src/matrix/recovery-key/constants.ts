/** SSSS encryption algorithm identifier. */
export const SECRET_STORAGE_ALGORITHM = "m.secret_storage.v1.aes-hmac-sha2";

/** Account data event types used for secret storage and cross-signing. */
export const ACCOUNT_DATA_TYPES = {
  defaultKey: "m.secret_storage.default_key",
  crossSigningMaster: "m.cross_signing.master",
  crossSigningSelfSigning: "m.cross_signing.self_signing",
  crossSigningUserSigning: "m.cross_signing.user_signing",
  megolmBackup: "m.megolm_backup.v1",
} as const;

/** User-facing error messages. */
export const ERROR_MESSAGES = {
  invalidKey: "Invalid recovery key: failed to decode or wrong format",
  noDefaultKey: "No default secret storage key found on this account",
  algorithmMismatch: "Secret storage key uses an unsupported algorithm",
  macMismatch: "Recovery key MAC verification failed — wrong key?",
  noSelfSigningKey: "Could not decrypt self-signing key from secret storage",
  signatureFailed: "Failed to upload device signature to homeserver",
  replayDetected: "This recovery key was already used recently for this device",
  noCryptoClient: "Matrix client has no crypto module — is E2EE enabled?",
} as const;

/** Bitcoin-style Base58 alphabet used by Matrix recovery keys. */
export const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Expected prefix bytes for a recovery key (0x8b 0x01). */
export const RECOVERY_KEY_PREFIX = new Uint8Array([0x8b, 0x01]);

/** Length of the decoded recovery key material in bytes. */
export const RECOVERY_KEY_LENGTH = 32;

/** Full decoded key length including prefix (2) + key (32) + parity (1). */
export const RECOVERY_KEY_DECODED_LENGTH = 2 + RECOVERY_KEY_LENGTH + 1;

/** TTL for replay protection entries (24 hours). */
export const RECOVERY_KEY_TTL_MS = 24 * 60 * 60 * 1000;
