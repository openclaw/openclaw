// Matrix plugin module implements crypto runtime behavior.
import "fake-indexeddb/auto";
<<<<<<< HEAD
import { installFakeIndexedDbTransactionPruner } from "./fake-indexeddb-prune.js";

installFakeIndexedDbTransactionPruner();
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

export { MatrixCryptoBootstrapper } from "./crypto-bootstrap.js";
export type { MatrixCryptoBootstrapResult } from "./crypto-bootstrap.js";
export { createMatrixCryptoFacade } from "./crypto-facade.js";
export type { MatrixCryptoFacade } from "./crypto-facade.js";
export { MatrixDecryptBridge } from "./decrypt-bridge.js";
export { persistIdbToDisk, restoreIdbFromDisk } from "./idb-persistence.js";
export { MatrixVerificationManager } from "./verification-manager.js";
export type { MatrixVerificationSummary } from "./verification-manager.js";
export {
  isMatrixDeviceOwnerVerified,
  isMatrixDeviceVerifiedInCurrentClient,
} from "./verification-status.js";
