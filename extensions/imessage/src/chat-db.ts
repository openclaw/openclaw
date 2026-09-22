import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  openSqliteWorkerStore,
  type SqliteWorkerCommand,
  type SqliteWorkerStore,
} from "openclaw/plugin-sdk/sqlite-runtime";
import type { IMessageTarget } from "./targets.js";

export type IMessageChatDbOperations = {
  startupWatermark: { input: undefined; output: number | null };
  messageGuid: { input: { messageId: string }; output: string | null };
  latestSentGuid: {
    input: { target: IMessageTarget; text: string; sentAfterMs?: number };
    output: string | null;
  };
};

type ReadReceiptGuid = (
  command: SqliteWorkerCommand<Pick<IMessageChatDbOperations, "messageGuid" | "latestSentGuid">>,
) => Promise<string | null>;

function openIMessageChatDbReader(databasePath: string) {
  return openSqliteWorkerStore<IMessageChatDbOperations>({
    moduleUrl: resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "chat-db.worker",
      distWorkerPath: "extensions/imessage/src/chat-db.worker.js",
      package: {
        name: "@openclaw/imessage",
        distWorkerPath: "src/chat-db.worker.js",
      },
    }),
    databasePath,
    existingOnly: true,
    input: undefined,
  });
}

export async function resolveIMessageStartupRowidWatermark(dbPath: string): Promise<number | null> {
  let store: SqliteWorkerStore<IMessageChatDbOperations> | undefined;
  try {
    store = await openIMessageChatDbReader(dbPath);
    if (!store) {
      throw new Error("Messages database is unavailable");
    }
    return await store.execute({ type: "startupWatermark", input: undefined });
  } catch (err) {
    logVerbose(`imessage: startup rowid watermark unavailable for db=${dbPath}: ${String(err)}`);
    return null;
  } finally {
    await store?.close();
  }
}

export async function withIMessageReceiptGuidReader<T>(
  databasePath: string,
  use: (read: ReadReceiptGuid) => Promise<T>,
): Promise<T> {
  let store: SqliteWorkerStore<IMessageChatDbOperations> | undefined;
  let closed = false;
  const read: ReadReceiptGuid = async (command) => {
    if (closed) {
      throw new Error("iMessage receipt lookup is closed");
    }
    try {
      store ??= await openIMessageChatDbReader(databasePath);
      return store ? await store.execute(command) : null;
    } catch {
      return null;
    }
  };
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
