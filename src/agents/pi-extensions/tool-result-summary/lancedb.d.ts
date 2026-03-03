/**
 * Type declarations for @lancedb/lancedb (optional dependency).
 * LanceDB is loaded dynamically, these types are for compile-time checking.
 */

declare module "@lancedb/lancedb" {
  /**
   * Search result row with distance score from vector search.
   */
  export interface LanceDBSearchRow<T = Record<string, unknown>> {
    _distance: number;
    [key: string]: T[keyof T] | undefined;
  }

  export interface Table {
    add(rows: unknown[]): Promise<void>;
    vectorSearch(vector: number[]): {
      limit(n: number): { toArray(): Promise<LanceDBSearchRow[]> };
    };
    query(): QueryBuilder;
    delete(condition: string): Promise<void>;
    countRows(): Promise<number>;
  }

  export interface QueryBuilder {
    select(columns: string[]): QueryBuilder;
    where(condition: string): QueryBuilder;
    toArray(): Promise<unknown[]>;
  }

  export interface Connection {
    tableNames(): Promise<string[]>;
    openTable(name: string): Promise<Table>;
    createTable(name: string, data: unknown[]): Promise<Table>;
  }

  export function connect(path: string): Promise<Connection>;
}
