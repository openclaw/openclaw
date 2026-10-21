import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  isRecord,
  normalizeOptionalString as stringFromUnknown,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { IMessageActionTransportOptions } from "./actions-transport.js";
import { normalizeDirectChatIdentifier } from "./chat-context.js";
import { createIMessageRpcClient } from "./client.js";
import type { IMessageTarget } from "./targets.js";

type IMessageConversationReadOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

type IMessageChatListResponse = { chats?: unknown };
type IMessageChat = { id: number; guid: string; identifier?: string };
type ChatListCacheEntry = {
  list: readonly IMessageChat[];
  expiresAt: number;
};

// Cache by the complete account transport identity so routing and actions reuse one
// chat snapshot without leaking a same-path account across Messages Macs.
const CHAT_LIST_CACHE_TTL_MS = 30 * 1000;
const chatListCache = new Map<string, ChatListCacheEntry>();

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : parseStrictInteger(value);
}

function findChat(
  chats: readonly IMessageChat[],
  target: Exclude<IMessageTarget, { kind: "handle" }>,
): IMessageChat | null {
  if (target.kind === "chat_id") {
    return chats.find((chat) => chat.id === target.chatId) ?? null;
  }
  if (target.kind === "chat_guid") {
    return chats.find((chat) => chat.guid === target.chatGuid) ?? null;
  }
  const wanted = normalizeDirectChatIdentifier(target.chatIdentifier);
  for (const chat of chats) {
    const { identifier, guid } = chat;
    if (
      identifier === target.chatIdentifier ||
      guid === target.chatIdentifier ||
      (identifier && normalizeDirectChatIdentifier(identifier) === wanted) ||
      normalizeDirectChatIdentifier(guid) === wanted
    ) {
      return chat;
    }
  }
  return null;
}

export async function resolveIMessageChat(params: {
  target: Exclude<IMessageTarget, { kind: "handle" }>;
  options: IMessageActionTransportOptions;
  conversationReadOrigin: IMessageConversationReadOrigin;
}): Promise<IMessageChat | null> {
  const { cliPath, dbPath, remoteHost } = params.options;
  const key = `${cliPath}\0${dbPath ?? ""}\0${remoteHost ?? ""}`;
  const cached = chatListCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return findChat(cached.list, params.target);
  }
  chatListCache.delete(key);
  const client = await createIMessageRpcClient(params.options);
  try {
    const result = await client.request<IMessageChatListResponse>(
      "chats.list",
      { limit: 1000 },
      { timeoutMs: params.options.timeoutMs },
    );
    const list: IMessageChat[] = [];
    for (const chat of isRecord(result) && Array.isArray(result.chats) ? result.chats : []) {
      if (!isRecord(chat)) {
        continue;
      }
      const id = numberFromUnknown(chat.id);
      const guid = stringFromUnknown(chat.guid);
      if (id !== undefined && guid) {
        list.push({ id, guid, identifier: stringFromUnknown(chat.identifier) });
      }
    }
    chatListCache.set(key, { list, expiresAt: Date.now() + CHAT_LIST_CACHE_TTL_MS });
    return findChat(list, params.target);
  } finally {
    await client.stop();
  }
}
