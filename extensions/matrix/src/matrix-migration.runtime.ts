export { detectLegacyMatrixState } from "./legacy-state.js";
export { detectLegacyMatrixCrypto } from "./legacy-crypto.js";
export {
  hasActionableMatrixMigration,
  hasPendingMatrixMigration,
  resolveMatrixMigrationStatus,
  type MatrixMigrationStatus,
} from "./migration-snapshot.js";
export { maybeCreateMatrixMigrationSnapshot } from "./migration-snapshot-backup.js";
