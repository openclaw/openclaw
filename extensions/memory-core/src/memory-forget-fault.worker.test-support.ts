import { appendFileSync } from "node:fs";
import type { MemoryEntryOriginBinding } from "./memory-entry-origins-task.js";
import { bindSqliteWorkerBackend as bindBackend } from "./memory-entry-origins.worker.js";

export type MemoryForgetFault = {
  trigger?: { event: string; message: string; action: "ABORT" | "FAIL" };
  reportPath?: string;
  failResult?: "forget.mark" | "forget.purge";
};

export function bindSqliteWorkerBackend(
  input: MemoryForgetFault & { binding: MemoryEntryOriginBinding },
  context: Parameters<typeof bindBackend>[1],
) {
  const backend = bindBackend(input.binding, context);
  const db = context.database;
  const prepare = db.prepare.bind(db);
  const restoreStatements: Array<() => void> = [];
  const counts = { sourceDeletes: 0, tombstoneInserts: 0 };
  if (input.trigger) {
    const { event, message, action } = input.trigger;
    db.exec(
      `CREATE TEMP TRIGGER forget_fixture_failure ${event} BEGIN SELECT RAISE(${action}, '${message.replaceAll("'", "''")}'); END`,
    );
  }
  if (input.reportPath) {
    db.prepare = (sql) => {
      const statement = prepare(sql);
      const counter = sql.startsWith('delete from "memory_index_sources"')
        ? "sourceDeletes"
        : sql.startsWith('insert into "memory_session_tombstones"')
          ? "tombstoneInserts"
          : undefined;
      if (counter) {
        const run = statement.run.bind(statement);
        restoreStatements.push(() => {
          statement.run = run;
        });
        statement.run = new Proxy(run, {
          apply(target, receiver, args) {
            const result = Reflect.apply(target, receiver, args);
            counts[counter] += 1;
            return result;
          },
        });
      }
      return statement;
    };
  }
  return {
    ...backend,
    execute(command: Parameters<typeof backend.execute>[0]) {
      const result = backend.execute(command);
      if (command.type === input.failResult) {
        throw new Error(`injected committed ${command.type} reply failure`);
      }
      return result;
    },
    close() {
      const failures: unknown[] = [];
      try {
        backend.close();
      } catch (error) {
        failures.push(error);
      }
      if (input.reportPath) {
        db.prepare = prepare;
        for (const restore of restoreStatements) {
          restore();
        }
      }
      try {
        if (db.isOpen && input.trigger) {
          db.exec("DROP TRIGGER temp.forget_fixture_failure");
        }
      } catch (error) {
        failures.push(error);
      }
      try {
        if (input.reportPath) {
          appendFileSync(input.reportPath, `${JSON.stringify(counts)}\n`);
        }
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Memory Forget fixture cleanup failed");
      }
    },
  };
}
