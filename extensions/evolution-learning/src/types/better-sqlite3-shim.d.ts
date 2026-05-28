declare module "better-sqlite3" {
  namespace Database {
    type UnknownFn = (...args: unknown[]) => unknown;

    interface RunResult {
      changes: number;
      lastInsertRowid: number | bigint;
    }

    interface Statement<Result = unknown> {
      run(...params: unknown[]): RunResult;
      get(...params: unknown[]): Result;
      all(...params: unknown[]): Result[];
      iterate(...params: unknown[]): IterableIterator<Result>;
      pluck(toggle?: boolean): Statement<Result>;
      raw(toggle?: boolean): Statement<Result>;
    }

    interface Transaction<T extends UnknownFn> {
      (...args: Parameters<T>): ReturnType<T>;
      deferred: Transaction<T>;
      immediate: Transaction<T>;
      exclusive: Transaction<T>;
    }

    interface Database {
      prepare<Result = unknown>(sql: string): Statement<Result>;
      transaction<T extends UnknownFn>(fn: T): Transaction<T>;
      pragma(sql: string, options?: Record<string, unknown>): unknown;
      exec(sql: string): this;
      loadExtension(path: string): void;
      close(): void;
    }
  }

  class Database implements Database.Database {
    constructor(filename: string, options?: Record<string, unknown>);
    prepare<Result = unknown>(sql: string): Database.Statement<Result>;
    transaction<T extends Database.UnknownFn>(fn: T): Database.Transaction<T>;
    pragma(sql: string, options?: Record<string, unknown>): unknown;
    exec(sql: string): this;
    loadExtension(path: string): void;
    close(): void;
  }

  export = Database;
}
