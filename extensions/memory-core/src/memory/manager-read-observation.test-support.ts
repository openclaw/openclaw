import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";

export function observeDatabaseReads(db: DatabaseSync) {
  let milliseconds = 0;
  let statements = 0;
  const sql: string[] = [];
  const reads: Array<{ sql: string; rows: number }> = [];
  const timed = <T>(run: () => T): T => {
    const started = performance.now();
    try {
      return run();
    } finally {
      milliseconds += performance.now() - started;
    }
  };
  const prepare = db.prepare.bind(db);
  const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((query) => {
    sql.push(query);
    const statement = timed(() => prepare(query));
    return new Proxy(statement, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          if (!["all", "get", "run", "iterate"].includes(String(key))) {
            return Reflect.apply(value, target, args);
          }
          statements += 1;
          if (key === "iterate") {
            const iterator: ReturnType<typeof statement.iterate> = timed(() =>
              Reflect.apply(value, target, args),
            );
            const read = { sql: query, rows: 0 };
            let observed = false;
            return {
              [Symbol.iterator]() {
                return this;
              },
              next: () => {
                if (!observed) {
                  reads.push(read);
                  observed = true;
                }
                const result = timed(() => iterator.next());
                if (!result.done) {
                  read.rows += 1;
                }
                return result;
              },
              return: () => timed(() => iterator.return?.() ?? { done: true, value: undefined }),
            };
          }
          const result: unknown = timed(() => Reflect.apply(value, target, args));
          if (key !== "run") {
            reads.push({
              sql: query,
              rows: Array.isArray(result) ? result.length : result ? 1 : 0,
            });
          }
          return result;
        };
      },
    });
  });
  const exec = db.exec.bind(db);
  const execSpy = vi.spyOn(db, "exec").mockImplementation((query) => {
    statements += 1;
    sql.push(query);
    return timed(() => exec(query));
  });
  return {
    reads,
    read: () => ({ milliseconds, statements, sql }),
    reset: () => {
      milliseconds = 0;
      statements = 0;
      sql.length = 0;
      reads.length = 0;
    },
    restore: () => {
      prepareSpy.mockRestore();
      execSpy.mockRestore();
    },
  };
}
