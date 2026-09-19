import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import type { MemoryPublicationConnection } from "./manager-publication-task.js";
import { openExistingSqliteWorkerBackend as openBackend } from "./manager-publication.worker.js";

export type PublicationFaultInput = MemoryPublicationConnection & {
  marker: string;
  failRollback: boolean;
  failClose: boolean;
  throwResultFailure: boolean;
  failDiscard?: boolean;
};

export function openExistingSqliteWorkerBackend(
  input: PublicationFaultInput,
  context: { databasePath: string },
) {
  const exec = mock.method(DatabaseSync.prototype, "exec");
  let backend: ReturnType<typeof openBackend>;
  try {
    backend = openBackend(input, context);
  } finally {
    exec.mock.restore();
  }
  const calls = exec.mock.calls.filter((call) =>
    call.arguments[0].includes("CREATE TEMP TABLE memory_publication_input"),
  );
  const db = calls[0]?.this;
  if (!(db instanceof DatabaseSync) || calls.length !== 1) {
    throw new Error("Expected the real publication database");
  }
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
        return backend.close();
      }
    },
  };
}
