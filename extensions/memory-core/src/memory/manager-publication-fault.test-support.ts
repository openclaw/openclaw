import { writeFileSync } from "node:fs";
import type { MemoryPublicationConnection } from "./manager-publication-task.js";
import { bindSqliteWorkerBackend as bindBackend } from "./manager-publication.worker.js";

export type PublicationFaultInput = MemoryPublicationConnection & {
  kind: "publication";
  marker: string;
  failRollback: boolean;
  failClose: boolean;
  throwResultFailure: boolean;
  failBindingClose?: boolean;
};

export function bindSqliteWorkerBackend(
  input:
    | PublicationFaultInput
    | {
        kind: "cache-capacity";
        publication: MemoryPublicationConnection;
        maximum: number;
      }
    | { kind: "cache-clear-result"; publication: MemoryPublicationConnection }
    | { kind: "cache-prune-result"; publication: MemoryPublicationConnection },
  context: Parameters<typeof bindBackend>[1],
) {
  if (input.kind === "cache-clear-result" || input.kind === "cache-prune-result") {
    const backend = bindBackend(input.publication, context);
    const operation = input.kind === "cache-clear-result" ? "cache.clear" : "cache.prune";
    return {
      ...backend,
      execute(command: Parameters<typeof backend.execute>[0]) {
        const result = backend.execute(command);
        if (
          command.type === operation &&
          result &&
          typeof result === "object" &&
          "ok" in result &&
          result.ok &&
          result.value === true
        ) {
          throw new Error(
            input.kind === "cache-clear-result"
              ? "injected committed cache clear reply failure"
              : "injected committed cache prune reply failure",
          );
        }
        return result;
      },
    };
  }
  if (input.kind === "cache-capacity") {
    const backend = bindBackend(input.publication, context);
    const db = context.database;
    db.exec(`
      CREATE TEMP TRIGGER reject_cache_overflow BEFORE INSERT ON memory_embedding_cache
      WHEN (SELECT COUNT(*) FROM memory_embedding_cache) >= ${input.maximum}
      BEGIN SELECT RAISE(ABORT, 'primary cache overflow'); END;
    `);
    return {
      ...backend,
      close() {
        const failures: unknown[] = [];
        try {
          backend.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          if (db.isOpen) {
            db.exec("DROP TRIGGER temp.reject_cache_overflow");
          }
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "Publication and capacity fixture cleanup failed");
        }
      },
    };
  }
  const backend = bindBackend(input, context);
  const db = context.database;
  const originalExec = db.exec.bind(db);
  const originalClose = db.close.bind(db);
  db.exec = (sql) => {
    if (input.failRollback && sql === "ROLLBACK") {
      throw new Error("injected rollback failure");
    }
    originalExec(sql);
    if (sql === "BEGIN IMMEDIATE") {
      writeFileSync(input.marker, "native transaction entered");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  };
  db.close = () => {
    if (input.failClose) {
      throw new Error("injected native close failure");
    }
    originalClose();
  };
  return {
    ...backend,
    execute(command: Parameters<typeof backend.execute>[0]) {
      const result = backend.execute(command);
      if (
        input.throwResultFailure &&
        result &&
        typeof result === "object" &&
        "ok" in result &&
        !result.ok
      ) {
        throw new Error("injected result delivery failure");
      }
      return result;
    },
    close() {
      db.exec = originalExec;
      db.close = originalClose;
      if (db.isOpen) {
        backend.close();
        if (input.failBindingClose) {
          throw new Error("injected binding cleanup failure");
        }
      }
    },
  };
}
