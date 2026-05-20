import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import type { CwDatabase, CwPreparedStatement } from "./db-types.js";

let nextId = 1;

export function convertPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

type WorkerReply = {
  id: number;
  ok?: boolean;
  rows?: unknown[];
  rowCount?: number;
  error?: string;
};

export function openPostgresDatabase(connectionString: string): {
  db: CwDatabase;
  close: () => void;
} {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL("./pg-worker.mjs", import.meta.url), {
    env: { ...process.env },
  });

  worker.postMessage({ port: port2 }, [port2]);

  let ready = false;

  function callWorker(type: string, payload: Record<string, unknown>): WorkerReply {
    const id = nextId++;
    port1.postMessage({ id, type, ...payload });
    const received = receiveMessageOnPort(port1) as WorkerReply | undefined;
    if (!received || received.id !== id) {
      throw new Error("PostgreSQL worker: unexpected reply");
    }
    if (received.error) {
      throw new Error(received.error);
    }
    return received;
  }

  callWorker("init", { connectionString });
  ready = true;

  const db: CwDatabase = {
    exec(sql: string) {
      if (!ready) {
        throw new Error("PostgreSQL database not ready");
      }
      callWorker("exec", { sql: convertPlaceholders(sql) });
    },

    prepare(sql: string): CwPreparedStatement {
      const pgSql = convertPlaceholders(sql);
      return {
        run(...params: unknown[]) {
          callWorker("query", { sql: pgSql, params });
        },
        get(...params: unknown[]) {
          const res = callWorker("query", { sql: pgSql, params });
          return res.rows?.[0];
        },
        all(...params: unknown[]) {
          const res = callWorker("query", { sql: pgSql, params });
          return res.rows ?? [];
        },
      };
    },

    close() {
      if (!ready) {
        return;
      }
      try {
        callWorker("close", {});
      } finally {
        ready = false;
        worker.terminate();
      }
    },
  };

  return { db, close: () => db.close() };
}

export function isPostgresDatabaseUrl(url: string): boolean {
  const trimmed = url.trim();
  return trimmed.startsWith("postgresql://") || trimmed.startsWith("postgres://");
}
