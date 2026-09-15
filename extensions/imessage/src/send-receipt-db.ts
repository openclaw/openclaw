import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import type { IMessageTarget } from "./targets.js";

export type IMessageReceiptDbOperations = {
  messageGuid: { input: { messageId: string }; output: string | null };
  latestSentGuid: {
    input: { target: IMessageTarget; text: string; sentAfterMs?: number };
    output: string | null;
  };
  maxRowid: { input: Record<string, never>; output: number | null };
};

export async function withIMessageReceiptGuidReader<T>(
  databasePath: string,
  use: (
    read: <Key extends keyof IMessageReceiptDbOperations>(command: {
      type: Key;
      input: IMessageReceiptDbOperations[Key]["input"];
    }) => Promise<IMessageReceiptDbOperations[Key]["output"] | null>,
  ) => Promise<T>,
): Promise<T> {
  let store: SqliteWorkerStore<IMessageReceiptDbOperations> | undefined;
  let closed = false;
  async function read<Key extends keyof IMessageReceiptDbOperations>(command: {
    type: Key;
    input: IMessageReceiptDbOperations[Key]["input"];
  }): Promise<IMessageReceiptDbOperations[Key]["output"] | null> {
    if (closed) {
      throw new Error("iMessage receipt lookup is closed");
    }
    try {
      store ??= await openSqliteWorkerStore<IMessageReceiptDbOperations>({
        moduleUrl: resolveRuntimeWorkerUrl({
          currentModuleUrl: import.meta.url,
          sourceWorkerName: "send-receipt-db.worker",
          distWorkerPath: "extensions/imessage/src/send-receipt-db.worker.js",
          package: {
            name: "@openclaw/imessage",
            distWorkerPath: "src/send-receipt-db.worker.js",
          },
        }),
        databasePath,
        existingOnly: true,
        input: undefined,
      });
      return store ? await store.execute(command) : null;
    } catch {
      return null;
    }
  }
  try {
    return await use(read);
  } finally {
    closed = true;
    try {
      await store?.close();
    } catch {
      // Receipt recovery remains best effort after a successful native send.
    }
  }
}
