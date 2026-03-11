import pg from "pg";
const { Pool } = pg;
let pool = null;
export function getErpPgPool() {
    if (!pool) {
        pool = new Pool({
            host: process.env.MABOS_PG_HOST ?? "localhost",
            port: parseInt(process.env.MABOS_PG_PORT ?? "5432", 10),
            database: process.env.MABOS_PG_DATABASE ?? "mabos_erp",
            user: process.env.MABOS_PG_USER ?? "mabos",
            password: process.env.MABOS_PG_PASSWORD ?? "",
            max: 20,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 5_000,
        });
    }
    return pool;
}
export async function query(client, sql, values) {
    const result = await client.query(sql, values);
    return result.rows;
}
export async function queryOne(client, sql, values) {
    const rows = await query(client, sql, values);
    return rows[0] ?? null;
}
export async function transaction(client, fn) {
    const conn = await client.connect();
    try {
        await conn.query("BEGIN");
        const result = await fn(conn);
        await conn.query("COMMIT");
        return result;
    }
    catch (err) {
        await conn.query("ROLLBACK");
        throw err;
    }
    finally {
        conn.release();
    }
}
export async function closeErpPgPool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}
//# sourceMappingURL=postgres.js.map