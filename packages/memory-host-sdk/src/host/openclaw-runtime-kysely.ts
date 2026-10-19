// Narrow core bridge for Kysely-backed sync query helpers. Split from
// openclaw-runtime-sqlite so schema/transaction consumers stay off the kysely
// value graph, which doctor/setup control-plane paths must not cold-load.
export { admitStoreSearch } from "../../../../src/infra/database-engine/search-admission.js";
export {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  sqliteStringSet,
} from "../../../../src/infra/kysely-sync.js";
export {
  isPostgresSqlConnection,
  type EngineConnection,
} from "../../../../src/infra/sql-connection.js";
