import { getEnvironmentData } from "node:worker_threads";
import {
  openNodeSqliteDatabase,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { IMessageChatDbOperations } from "./chat-db.js";

export const CHAT_DB_ADMISSION_GATE = "openclaw.test.imessageChatDbAdmission";
export type AdmissionGate = { gate: SharedArrayBuffer; phase: "open" | "read" };
export type StorageOperations = {
  append: { input: string; output: undefined };
  read: { input: undefined; output: Record<string, unknown>[] };
};

export function createSqliteWorkerBackend(
  _input: undefined,
  { databasePath }: { databasePath: string },
): SqliteWorkerBackend<StorageOperations> {
  const db = openNodeSqliteDatabase(databasePath);
  db.exec("CREATE TABLE entries (value TEXT NOT NULL)");
  return {
    execute(command) {
      if (command.type === "append") {
        db.prepare("INSERT INTO entries (value) VALUES (?)").run(command.input);
        return undefined;
      }
      return db.prepare("SELECT value FROM entries").all();
    },
    close() {
      db.close();
    },
  };
}

export function openExistingSqliteWorkerBackend(): SqliteWorkerBackend<
  Pick<IMessageChatDbOperations, "startupWatermark">
> {
  // The test host publishes this exact structured-cloned gate before creating workers.
  const fixture = getEnvironmentData(CHAT_DB_ADMISSION_GATE) as AdmissionGate;
  const gate = new Int32Array(fixture.gate);
  const block = () => {
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
    Atomics.wait(gate, 0, 0);
  };
  if (fixture.phase === "open") {
    block();
  }
  return {
    execute() {
      if (fixture.phase === "read") {
        block();
      }
      return 17;
    },
    close() {},
  };
}
