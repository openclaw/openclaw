import { DatabaseSync } from "node:sqlite";
import type { IMessagePayload } from "../monitor/types.js";

export const DEFAULT_SENDER = "+15550001111";

type ChatDbMessage = Required<
  Pick<IMessagePayload, "id" | "guid" | "sender" | "text" | "created_at">
>;

export function withChatDb<T>(dbPath: string, run: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(dbPath);
  try {
    return run(database);
  } finally {
    database.close();
  }
}

export function createChatDbMessage(
  id: number,
  guid: string,
  text: string,
  createdAt = new Date().toISOString(),
): ChatDbMessage {
  return { id, guid, sender: DEFAULT_SENDER, text, created_at: createdAt };
}

const CHAT_DB_SCHEMA = "CREATE TABLE message (guid TEXT, sender TEXT, text TEXT, created_at TEXT);";
const CHAT_DB_INSERT =
  "INSERT INTO message(rowid, guid, sender, text, created_at) VALUES (?, ?, ?, ?, ?)";

export function createChatDb(dbPath: string, messages: ChatDbMessage[] = []): void {
  withChatDb(dbPath, (database) => {
    database.exec(CHAT_DB_SCHEMA);
    const insert = database.prepare(CHAT_DB_INSERT);
    for (const message of messages) {
      insert.run(message.id, message.guid, message.sender, message.text, message.created_at);
    }
  });
}

export function insertChatDbMessage(dbPath: string, message: ChatDbMessage): void {
  withChatDb(dbPath, (database) => {
    database
      .prepare(CHAT_DB_INSERT)
      .run(message.id, message.guid, message.sender, message.text, message.created_at);
  });
}

export function readChatDbMessagesAfter(dbPath: string, rowid: number): IMessagePayload[] {
  return withChatDb(dbPath, (database) => {
    const messages = database
      .prepare(
        "SELECT rowid AS id, guid, sender, text, created_at FROM message WHERE rowid > ? ORDER BY rowid",
      )
      .all(rowid) as ChatDbMessage[];
    return messages.map((message) =>
      Object.assign(message, { chat_id: 123, is_from_me: false, is_group: false }),
    );
  });
}
