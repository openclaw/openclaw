import type { IMessageRpcClient } from "../client.js";
import type { IMessagePayload } from "./types.js";

/**
 * An anchorless payload lacks every reliable conversation identifier: no valid
 * chat_id (positive integer), no non-empty chat_guid, and no non-empty
 * chat_identifier. When imsg watch.subscribe ships a group link-preview row
 * with chat_id=0 and empty string fields, the message passes type validation
 * but cannot be safely routed — it must not fall back to sender-DM routing.
 */
export function isIMessageAnchorless(message: IMessagePayload): boolean {
  const chatId = message.chat_id;
  const chatGuid = message.chat_guid?.trim();
  const chatIdentifier = message.chat_identifier?.trim();

  const hasValidChatId = typeof chatId === "number" && chatId > 0 && Number.isFinite(chatId);
  const hasValidChatGuid = chatGuid !== undefined && chatGuid !== "";
  const hasValidChatIdentifier = chatIdentifier !== undefined && chatIdentifier !== "";

  return !hasValidChatId && !hasValidChatGuid && !hasValidChatIdentifier;
}

type ChatsListEntry = {
  id?: number | null;
  last_message_at?: string | null;
};

type MessagesHistoryResult = {
  messages?: unknown[];
};

type RuntimeLogger = {
  log?: (msg: string) => void;
  error?: (msg: string) => void;
};

export type RepairIMessageConversationAnchorParams = {
  message: IMessagePayload;
  client: IMessageRpcClient;
  runtime?: RuntimeLogger;
  /** Override for tests. */
  chatsLimit?: number;
  /** Override for tests. */
  perChatHistoryLimit?: number;
  /** Override for tests. */
  rpcTimeoutMs?: number;
};

const DEFAULT_CHATS_LIMIT = 20;
const DEFAULT_PER_CHAT_HISTORY_LIMIT = 50;
const DEFAULT_RPC_TIMEOUT_MS = 5_000;

/**
 * If the payload is anchorless, attempt to recover the real conversation by
 * searching recent chats via `chats.list` + `messages.history` for the message
 * GUID. Returns the repaired payload on success, or `null` to signal a
 * fail-closed drop. Non-anchorless payloads pass through unchanged.
 */
export async function repairIMessageConversationAnchor(
  params: RepairIMessageConversationAnchorParams,
): Promise<IMessagePayload | null> {
  const { message, client, runtime } = params;

  if (!isIMessageAnchorless(message)) {
    return message;
  }

  const guid = message.guid?.trim();
  if (!guid) {
    runtime?.error?.("imessage: dropping anchorless message without GUID (no recovery possible)");
    return null;
  }

  runtime?.log?.(
    `imessage: anchorless payload detected for GUID=${guid}, attempting conversation recovery`,
  );

  const chatsLimit = params.chatsLimit ?? DEFAULT_CHATS_LIMIT;
  const perChatLimit = params.perChatHistoryLimit ?? DEFAULT_PER_CHAT_HISTORY_LIMIT;
  const timeoutMs = params.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

  let chatsResult: { chats?: ChatsListEntry[] } | undefined;
  try {
    chatsResult = await client.request<{ chats?: ChatsListEntry[] }>(
      "chats.list",
      { limit: chatsLimit },
      { timeoutMs },
    );
  } catch (err) {
    runtime?.error?.(`imessage: conversation recovery failed (chats.list error): ${String(err)}`);
    return null;
  }

  const chats = chatsResult?.chats ?? [];

  for (const chat of chats) {
    const chatId = typeof chat.id === "number" && Number.isFinite(chat.id) ? chat.id : null;
    if (chatId === null) {
      continue;
    }

    let historyResult: MessagesHistoryResult | undefined;
    try {
      historyResult = await client.request<MessagesHistoryResult>(
        "messages.history",
        {
          chat_id: chatId,
          limit: perChatLimit,
          attachments: false,
        },
        { timeoutMs },
      );
    } catch {
      continue;
    }

    const messages = Array.isArray(historyResult?.messages) ? historyResult.messages : [];

    for (const raw of messages) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const entry = raw as Record<string, unknown>;
      if (entry.guid !== guid) {
        continue;
      }

      // Found the message. Extract conversation metadata from the history
      // entry and overlay onto the original payload.
      const repaired = { ...message };
      if (
        typeof entry.chat_id === "number" &&
        Number.isFinite(entry.chat_id) &&
        entry.chat_id > 0
      ) {
        repaired.chat_id = entry.chat_id;
      }
      if (typeof entry.chat_guid === "string" && entry.chat_guid) {
        repaired.chat_guid = entry.chat_guid;
      }
      if (typeof entry.chat_identifier === "string" && entry.chat_identifier) {
        repaired.chat_identifier = entry.chat_identifier;
      }
      if (typeof entry.is_group === "boolean") {
        repaired.is_group = entry.is_group;
      }
      if (typeof entry.chat_name === "string") {
        repaired.chat_name = entry.chat_name;
      }
      if (
        Array.isArray(entry.participants) &&
        entry.participants.every((p) => typeof p === "string")
      ) {
        repaired.participants = entry.participants as string[];
      }

      if (isIMessageAnchorless(repaired)) {
        runtime?.error?.(
          `imessage: dropping anchorless message GUID=${guid} (found in history but no valid anchor fields recovered)`,
        );
        return null;
      }

      runtime?.log?.(
        `imessage: recovered conversation for GUID=${guid}: chat_id=${repaired.chat_id}, is_group=${repaired.is_group}`,
      );
      return repaired;
    }
  }

  runtime?.error?.(
    `imessage: dropping anchorless message GUID=${guid} (not found in recent chat history)`,
  );
  return null;
}
