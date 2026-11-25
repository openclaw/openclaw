export type SqliteAuthorization = {
  action: number;
  argument1: string | null;
  argument2: string | null;
  schema: string | null;
  triggerOrView: string | null;
};

export type SqliteColumnFact = {
  cid: number;
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: number;
  hidden: number;
};

export type SqliteTableFact = {
  schema: string;
  name: string;
  type: "table" | "virtual" | "shadow" | "view";
  sql: string | null;
  rootpage: number;
  columns: SqliteColumnFact[];
};

type SqliteIndexFact = {
  schema: string;
  name: string;
  table: string;
  sql: string | null;
  rootpage: number;
};

export type SqliteCatalog = { tables: SqliteTableFact[]; indexes: SqliteIndexFact[] };

export type ObservedSqliteStatement = {
  databaseId: number;
  databasePath: string | null;
  method: "exec" | "run" | "get" | "all" | "iterate";
  sql: string;
  ownerIntegrity: boolean;
  preparedAuthorizations: SqliteAuthorization[];
  executedAuthorizations: SqliteAuthorization[];
  before: SqliteCatalog;
  after: SqliteCatalog;
};

export type SqliteMigrationObservation = {
  statements: ObservedSqliteStatement[];
  integrityChecks: string[];
  coverageFailures: string[];
};

export type SqliteMigrationRange = {
  store: string;
  fromVersion: number;
  toVersion: number;
  beforeMinReader: number;
  afterMinReader: number;
};
