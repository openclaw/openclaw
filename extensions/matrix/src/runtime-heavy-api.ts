export { autoPrepareLegacyMatrixCrypto, detectLegacyMatrixCrypto } from "./legacy-crypto.js";
export { autoMigrateLegacyMatrixState, detectLegacyMatrixState } from "./legacy-state.js";
export {
  hasActionableMatrixMigration,
  hasPendingMatrixMigration,
  maybeCreateMatrixMigrationSnapshot,
} from "./migration-snapshot.js";
