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
  const backend = bindBackend(input.kind === "publication" ? input : input.publication, context);
  const db = context.database;
  const execute = (command: Parameters<typeof backend.execute>[0]) => {
    const result = backend.execute(command);
    if (result && typeof result === "object" && "ok" in result) {
      if (input.kind === "publication" && input.throwResultFailure && !result.ok) {
        throw new Error("injected result delivery failure");
      }
      const operation =
        input.kind === "cache-clear-result"
          ? "cache.clear"
          : input.kind === "cache-prune-result"
            ? "cache.prune"
            : undefined;
      if (command.type === operation && result.ok && result.value === true) {
        throw new Error(
          `injected committed cache ${operation === "cache.clear" ? "clear" : "prune"} reply failure`,
        );
      }
    }
    return result;
  };
  if (input.kind === "cache-clear-result" || input.kind === "cache-prune-result") {
    return { ...backend, execute };
  }
  if (input.kind === "cache-capacity") {
    db.exec(`
      CREATE TEMP TRIGGER reject_cache_overflow BEFORE INSERT ON memory_embedding_cache
      WHEN (SELECT COUNT(*) FROM memory_embedding_cache) >= ${input.maximum}
      BEGIN SELECT RAISE(ABORT, 'primary cache overflow'); END;
    `);
    return {
      ...backend,
      close() {
        const failures: unknown[] = [];
        for (const cleanup of [
          () => backend.close(),
          () => {
            if (db.isOpen) {
              db.exec("DROP TRIGGER temp.reject_cache_overflow");
            }
          },
        ]) {
          try {
            cleanup();
          } catch (error) {
            failures.push(error);
          }
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
  const originalExec = db.exec.bind(db);
  const originalClose = db.close.bind(db);
  db.exec = (sql) => {
    if (input.failRollback && sql === "ROLLBACK") {
      throw new Error("injected rollback failure");
    }
    originalExec(sql);
    if (sql === "BEGIN IMMEDIATE") {
      writeFileSync(input.marker, "native transaction entered");
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
    execute,
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
