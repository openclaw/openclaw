import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  asDateTimestampMs,
  parseStrictInteger,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
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
type ChatListCacheEntry = {
  list: ReadonlyArray<Record<string, unknown>>;
  expiresAt: number;
};

// Cache by the complete account transport identity so action bursts reuse one
// chat snapshot without leaking a same-path account across Messages Macs.
const CHAT_LIST_CACHE_TTL_MS = 30 * 1000;
const chatListCache = new Map<string, ChatListCacheEntry>();

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : parseStrictInteger(value);
}

function findChatGuid(
  chats: readonly Record<string, unknown>[],
  target: Extract<IMessageTarget, { kind: "chat_id" | "chat_identifier" }>,
): string | null {
  if (target.kind === "chat_id") {
    for (const chat of chats) {
      const id = numberFromUnknown(chat.id);
      const guid = stringFromUnknown(chat.guid);
      if (id === target.chatId && guid) {
        return guid;
      }
    }
    return null;
  }
  const wanted = normalizeDirectChatIdentifier(target.chatIdentifier);
  for (const chat of chats) {
    const identifier = stringFromUnknown(chat.identifier);
    const guid = stringFromUnknown(chat.guid);
    if (
      guid &&
      (identifier === target.chatIdentifier ||
        guid === target.chatIdentifier ||
        (identifier && normalizeDirectChatIdentifier(identifier) === wanted) ||
        normalizeDirectChatIdentifier(guid) === wanted)
    ) {
      return guid;
    }
  }
  return null;
}

export async function resolveIMessageActionChatGuid(params: {
  target: Extract<IMessageTarget, { kind: "chat_id" | "chat_identifier" }>;
  options: IMessageActionTransportOptions;
  conversationReadOrigin: IMessageConversationReadOrigin;
}): Promise<string | null> {
  const { cliPath, dbPath, remoteHost } = params.options;
  const key = `${cliPath}\0${dbPath ?? ""}\0${remoteHost ?? ""}`;
  const cached = chatListCache.get(key);
  const now = asDateTimestampMs(Date.now());
  if (cached && now !== undefined && cached.expiresAt > now) {
    return findChatGuid(cached.list, params.target);
  }
  chatListCache.delete(key);
  const client = await createIMessageRpcClient(params.options);
  try {
    const result = await client.request<IMessageChatListResponse>(
      "chats.list",
      { limit: 1000 },
      { timeoutMs: params.options.timeoutMs },
    );
    const list =
      isRecord(result) && Array.isArray(result.chats) ? result.chats.filter(isRecord) : [];
    const expiresAt = resolveExpiresAtMsFromDurationMs(CHAT_LIST_CACHE_TTL_MS);
    if (expiresAt !== undefined) {
      chatListCache.set(key, { list, expiresAt });
    }
    return findChatGuid(list, params.target);
  } finally {
    await client.stop();
  }
}
