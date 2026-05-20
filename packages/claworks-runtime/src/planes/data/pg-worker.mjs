import { parentPort } from "node:worker_threads";
import pg from "pg";

/** @type {import('pg').Pool | null} */
let pool = null;

parentPort.once("message", (msg) => {
  const port = msg.port;
  if (!port) {
    throw new Error("pg-worker: missing MessagePort");
  }

  port.on("message", async (inner) => {
    try {
      if (inner.type === "init") {
        pool = new pg.Pool({ connectionString: inner.connectionString });
        await pool.query("SELECT 1");
        port.postMessage({ id: inner.id, ok: true });
        return;
      }
      if (inner.type === "exec") {
        if (!pool) {
          throw new Error("pg worker not initialized");
        }
        await pool.query(inner.sql);
        port.postMessage({ id: inner.id, ok: true });
        return;
      }
      if (inner.type === "query") {
        if (!pool) {
          throw new Error("pg worker not initialized");
        }
        const res = await pool.query(inner.sql, inner.params ?? []);
        port.postMessage({ id: inner.id, rows: res.rows, rowCount: res.rowCount });
        return;
      }
      if (inner.type === "close") {
        if (pool) {
          await pool.end();
          pool = null;
        }
        port.postMessage({ id: inner.id, ok: true });
        return;
      }
      port.postMessage({ id: inner.id, error: `unknown type: ${inner.type}` });
    } catch (err) {
      port.postMessage({
        id: inner.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
});
