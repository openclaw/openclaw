import pg from "pg";
export type PgClient = pg.Pool;
export type PgQueryResult = pg.QueryResult;
export declare function getErpPgPool(): PgClient;
export declare function query<T extends pg.QueryResultRow = pg.QueryResultRow>(client: PgClient, sql: string, values?: unknown[]): Promise<T[]>;
export declare function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(client: PgClient, sql: string, values?: unknown[]): Promise<T | null>;
export declare function transaction<T>(client: PgClient, fn: (conn: pg.PoolClient) => Promise<T>): Promise<T>;
export declare function closeErpPgPool(): Promise<void>;
