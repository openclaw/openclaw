import { writeFileSync } from "node:fs";
import { countMemoryEmbeddingCache } from "./manager-embedding-cache.js";
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
    return bindBackend(input.publication, {
      ...context,
      admit(stage) {
        context.admit(stage);
        if (stage === "commit" && countMemoryEmbeddingCache(context.database) > input.maximum) {
          throw new Error("primary cache overflow");
        }
      },
    });
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
