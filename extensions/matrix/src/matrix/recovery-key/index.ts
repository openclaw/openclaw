export { RecoveryKeyHandler } from "./handler.js";
export { RecoveryKeyStore } from "./store.js";
export {
  registerMatrixRecoveryKeyHandler,
  getMatrixRecoveryKeyHandler,
  unregisterMatrixRecoveryKeyHandler,
  registerMatrixVerificationStore,
  getMatrixVerificationStore,
} from "./registry.js";
export type { VerificationResult, RecoveryKeyVerificationState } from "./types.js";
