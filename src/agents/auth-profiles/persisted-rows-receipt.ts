import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  getOrLoadSqliteDatabaseAdmissionForPath,
  peekSqliteDatabaseAdmissionForPath,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../../infra/sqlite-database-admission.js";

// Admission retains each committed fact's identity across unrelated worker exchanges.
// The receipt carries no credentials; native transaction settlement owns invalidation.
const rowsReceipt: SqliteDatabaseAdmissionKey<object> = {
  name: "auth-profiles.rows",
  read: (value) => (isRecord(value) ? value : undefined),
};
const initialReceipt = {};

export function readAuthProfileRowsReceipt(databasePath: string, sourceIdentity?: string): object {
  // An admitted absence needs only published receipts; discovering it again is filesystem polling.
  if (sourceIdentity?.startsWith("path:")) {
    return peekSqliteDatabaseAdmissionForPath(databasePath, rowsReceipt) ?? initialReceipt;
  }
  return (
    getOrLoadSqliteDatabaseAdmissionForPath(databasePath, rowsReceipt, () => initialReceipt) ??
    initialReceipt
  );
}

export function publishAuthProfileRowsChanged(database: EngineConnection): void {
  publishSqliteDatabaseAdmission(database, rowsReceipt, {});
}
