export type SqliteCapabilities = {
  available: boolean;
  version: string | null;
  text: boolean;
  blob: boolean;
  json: boolean;
  error?: string;
};
export type SqliteCapabilityDatabase = {
  prepare(sql: string): {
    get(): Record<string, unknown> | undefined;
    run(text: string, bytes: Uint8Array, json: string): unknown;
  };
  exec(sql: string): unknown;
  close(): void;
};
export type SqliteCapabilityDatabaseConstructor = new (
  location: string,
) => SqliteCapabilityDatabase;
export function probeSqlite(DatabaseSync: SqliteCapabilityDatabaseConstructor): SqliteCapabilities;
export function isSqliteWalResetSafeVersion(value: string): boolean;
