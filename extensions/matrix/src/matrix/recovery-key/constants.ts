/**
 * Constants for Matrix recovery key verification.
 */

/**
 * Matrix secret storage algorithm name.
 */
export const SECRET_STORAGE_ALGORITHM = "m.secret_storage.v1.aes-hmac-sha2";

/**
 * Expected length of Base58-encoded recovery key (excluding whitespace).
 * Note: Natural Base58 encoding of 35 bytes typically results in ~48 characters.
 * Some implementations may pad to 58 characters, but this is not required by the spec.
 */
export const RECOVERY_KEY_BASE58_LENGTH = 48;

/**
 * Expected length of decoded recovery key (2-byte prefix + 32-byte key + 1 parity byte).
 * Format: [0x8b, 0x01, ...32 key bytes..., parity]
 */
export const RECOVERY_KEY_DECODED_LENGTH = 35;

/**
 * Expected length of AES-256 key (32 bytes).
 */
export const AES_KEY_LENGTH = 32;

/**
 * Expected length of ed25519 private key (32 bytes).
 */
export const ED25519_KEY_LENGTH = 32;

/**
 * Time-to-live for used recovery keys (24 hours in milliseconds).
 */
export const RECOVERY_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Bitcoin Base58 alphabet (used by Matrix recovery keys).
 */
export const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Matrix account data event types.
 */
export const ACCOUNT_DATA_TYPES = {
  SECRET_STORAGE_DEFAULT_KEY: "m.secret_storage.default_key",
  SECRET_STORAGE_KEY_PREFIX: "m.secret_storage.key.",
  CROSS_SIGNING_MASTER: "m.cross_signing.master",
  CROSS_SIGNING_SELF_SIGNING: "m.cross_signing.self_signing",
  CROSS_SIGNING_USER_SIGNING: "m.cross_signing.user_signing",
  MEGOLM_BACKUP_V1: "m.megolm_backup.v1",
} as const;

/**
 * Error messages for user-facing errors.
 */
export const ERROR_MESSAGES = {
  INVALID_KEY_FORMAT: "Invalid recovery key format",
  INVALID_KEY_CHARACTERS: "Recovery key contains invalid characters",
  INVALID_PARITY: "Recovery key parity check failed (corrupted key)",
  SECRET_STORAGE_NOT_CONFIGURED: "Secret storage not configured on this account",
  SECRET_STORAGE_KEY_NOT_FOUND: "Secret storage key metadata not found",
  INVALID_ALGORITHM: `Expected algorithm ${SECRET_STORAGE_ALGORITHM}`,
  MAC_VERIFICATION_FAILED: "Recovery key incorrect or secret corrupted",
  CROSS_SIGNING_NOT_CONFIGURED: "Cross-signing keys not found in account data",
  MASTER_KEY_MISSING: "Master cross-signing key not found",
  SELF_SIGNING_KEY_MISSING: "Self-signing key not found",
  USER_SIGNING_KEY_MISSING: "User-signing key not found",
  INVALID_KEY_LENGTH: "Decrypted key has invalid length",
  RECOVERY_KEY_ALREADY_USED: "Recovery key has been used recently (24-hour replay protection)",
  CRYPTO_ENGINE_UNAVAILABLE: "Matrix crypto engine not available",
} as const;
