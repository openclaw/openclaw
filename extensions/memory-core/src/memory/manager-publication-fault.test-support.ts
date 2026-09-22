import { writeFileSync } from "node:fs";
import type { MemoryPublicationConnection } from "./manager-publication-task.js";
import { bindSqliteWorkerBackend as bindBackend } from "./manager-publication.worker.js";

export type PublicationFaultInput = MemoryPublicationConnection & {
  marker: string;
  failRollback: boolean;
  failClose: boolean;
  throwResultFailure: boolean;
  failDiscard?: boolean;
  failBindingClose?: boolean;
};

export function bindSqliteWorkerBackend(
  input: PublicationFaultInput,
  context: Parameters<typeof bindBackend>[1],
) {
  const backend = bindBackend(input, context);
  const db = context.database;
  const originalExec = db.exec.bind(db);
  const originalClose = db.close.bind(db);
  db.exec = (sql) => {
    if (input.failDiscard && sql === "DELETE FROM temp.memory_publication_input") {
      throw new Error("injected staging discard failure");
    }
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
      if (input.throwResultFailure && result && !result.ok) {
        throw new Error("injected result delivery failure");
      }
      return result;
    },
    close() {
      db.exec = originalExec;
      db.close = originalClose;
      if (db.isOpen) {
        const closed = backend.close();
        if (input.failBindingClose) {
          throw new Error("injected binding cleanup failure");
        }
        return closed;
      }
    },
  };
}
