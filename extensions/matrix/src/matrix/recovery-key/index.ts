/**
 * Matrix recovery key device verification module.
 */

export { RecoveryKeyHandler } from "./handler.js";
export { RecoveryKeyStore } from "./store.js";
export {
  registerMatrixRecoveryKeyHandler,
  getMatrixRecoveryKeyHandler,
  unregisterMatrixRecoveryKeyHandler,
  getMatrixVerificationStore,
} from "./registry.js";
export type {
  RecoveryKey,
  SecretStorageKeyInfo,
  CrossSigningKeys,
  RecoveryKeyVerificationState,
  VerificationResult,
  BackupInfo,
} from "./types.js";
