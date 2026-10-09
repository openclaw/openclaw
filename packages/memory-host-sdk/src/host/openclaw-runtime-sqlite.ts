// Narrow core bridge for shared SQLite schema migration primitives.
// Kysely-backed query helpers live in openclaw-runtime-kysely.ts so this
// bridge stays off the kysely value graph for schema/transaction consumers.

export {
  migrateSqliteSchemaToStrict,
  migrateSqliteSchemaToStrictInTransaction,
} from "../../../../src/infra/sqlite-strict.js";
export {
  assertSqliteSchemaContains,
  createSqliteTableContractReader,
  type SqliteTableContractReader,
} from "../../../../src/infra/sqlite-schema-contract.js";
export { canReuseSqliteSchemaInTransaction } from "../../../../src/infra/sqlite-schema-facts.js";
export { runSqliteImmediateTransactionSync } from "../../../../src/infra/sqlite-transaction.js";
