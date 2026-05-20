/**
 * SQLite-compatible sync database surface used by ClaWorks planes (ObjectStore, PlaybookEngine, Outbox).
 */
export type CwPreparedStatement = {
  run(...params: unknown[]): void;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

export type CwDatabase = {
  exec(sql: string): void;
  prepare(sql: string): CwPreparedStatement;
  close(): void;
};
