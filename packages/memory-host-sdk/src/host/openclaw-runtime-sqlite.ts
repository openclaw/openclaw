// Narrow core bridge for shared SQLite schema migration primitives.
// Kysely-backed query helpers live in openclaw-runtime-kysely.ts so this
// bridge stays off the kysely value graph for schema/transaction consumers.

export type { SearchSchema } from "../../../../src/infra/database-engine/contract.js";

export {
  migrateSqliteSchemaToStrict,
  migrateSqliteSchemaToStrictInTransaction,
} from "../../../../src/infra/sqlite-strict.js";
export { readGeneratedSqliteCatalog } from "../../../../src/state/postgres-schema.generated/sqlite-catalogs.js";
export {
  assertSqliteSchemaContains,
  type SqliteSchemaSource,
  createSqliteTableContractReader,
  type SqliteTableContractReader,
} from "../../../../src/infra/sqlite-schema-contract.js";
export {
  canReuseSqliteSchemaInTransaction,
  getAdmittedSqliteSchemaFacts,
} from "../../../../src/infra/sqlite-schema-facts.js";
export { createSqliteSchemaEnsurer } from "../../../../src/infra/sqlite-schema-ensure.js";
export {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../../../../src/infra/sqlite-database-admission.js";
export { runSqliteImmediateTransactionSync } from "../../../../src/infra/sqlite-transaction.js";
export { stageSqliteTransactionState } from "../../../../src/infra/sqlite-post-commit.js";
export { tableExists } from "../../../../src/state/openclaw-state-db-schema-helpers.js";
export {
  sqlPublicationAnchor,
  type PostgresSqlConnection,
  type EngineConnection,
} from "../../../../src/infra/sql-connection.js";
export * from "../../../../src/infra/database-engine/sqlite-search-schema.js";
