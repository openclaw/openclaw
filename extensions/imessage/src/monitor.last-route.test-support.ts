import { DatabaseSync } from "node:sqlite";
import type { IMessagePayload } from "./monitor/types.js";
import { setCachedIMessagePrivateApiStatus } from "./private-api-status.js";

export const DEFAULT_SENDER = "+15550001111";

export async function settleNotifications(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export function setAvailablePrivateApiMethods(rpcMethods: string[]): void {
  setCachedIMessagePrivateApiStatus("imsg", {
    available: true,
    v2Ready: true,
    selectors: {},
    rpcMethods,
  });
}

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

const ANCHOR_REPAIR_GUID = "11111111-1111-4111-8111-111111111111";

type IMessageTestRequest = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
export type IMessageTestRequestResult =
  | Record<string, unknown>
  | ((params?: Record<string, unknown>) => unknown);

export function createIMessageTestRequest(
  results: Record<string, IMessageTestRequestResult>,
): IMessageTestRequest {
  return async (method, params) => {
    if (!Object.hasOwn(results, method)) {
      throw new Error(`unexpected imsg method ${method}`);
    }
    const result = results[method];
    return typeof result === "function" ? await result(params) : result;
  };
}

export function createInboundMessage(
  message: Pick<IMessagePayload, "id" | "guid" | "text"> &
    Partial<
      Pick<
        IMessagePayload,
        | "chat_id"
        | "chat_guid"
        | "chat_identifier"
        | "sender"
        | "is_from_me"
        | "is_group"
        | "created_at"
        | "destination_caller_id"
      >
    >,
): IMessagePayload {
  return {
    id: message.id,
    guid: message.guid,
    chat_id: message.chat_id ?? 123,
    chat_guid: message.chat_guid,
    chat_identifier: message.chat_identifier,
    sender: message.sender ?? DEFAULT_SENDER,
    is_from_me: message.is_from_me ?? false,
    text: message.text,
    is_group: message.is_group ?? false,
    created_at: message.created_at ?? new Date().toISOString(),
    destination_caller_id: message.destination_caller_id,
  };
}

export function createAnchorlessDirectPair(id: number, text: string, isFromMe: boolean) {
  return {
    notification: {
      id,
      guid: ANCHOR_REPAIR_GUID,
      chat_id: 0,
      chat_guid: "",
      chat_identifier: "",
      sender: "+15550000001",
      destination_caller_id: "+15550000001",
      is_from_me: false,
      is_group: false,
      service: "iMessage",
      text,
      created_at: new Date().toISOString(),
    },
    history: {
      id,
      guid: ANCHOR_REPAIR_GUID,
      chat_id: 42,
      chat_guid: "iMessage;-;+15550000002",
      chat_identifier: "+15550000002",
      sender: "+15550000002",
      destination_caller_id: "+15550000001",
      is_from_me: isFromMe,
      is_group: false,
      service: "iMessage",
    },
  };
}

export const EMPTY_DISPATCH_RESULT = {
  queuedFinal: false,
  counts: { tool: 0, block: 0, final: 0 },
} as const;

export type WatchClientParams = {
  requests?: Record<string, IMessageTestRequestResult>;
  auxiliaryRequests?: Record<string, IMessageTestRequestResult>;
  message?: IMessagePayload;
  messages?: IMessagePayload[];
  onClose?: (notify: (message: IMessagePayload) => void) => Promise<void>;
  afterNotify?: () => Promise<void>;
};

export type MonitorRunParams = {
  accountId?: string;
  imessage?: Record<string, unknown>;
  session?: Record<string, unknown>;
  messages?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  bindings?: import("openclaw/plugin-sdk/config-contracts").OpenClawConfig["bindings"];
  runtime?: import("./monitor/types.js").MonitorIMessageOpts["runtime"];
  allowlist?: boolean;
};
