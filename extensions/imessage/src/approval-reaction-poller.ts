import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asDateTimestampMs, asPositiveFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { IMessageApprovalGatewayRuntime } from "./approval-gateway-types.js";
import {
  listPendingIMessageApprovalReactionPollTargets,
  type PendingIMessageApprovalReactionPollTarget,
} from "./approval-reaction-poll-targets.js";
import {
  handleIMessageApprovalReaction,
  registerIMessageApprovalReactionTarget,
  type IMessageApprovalConversationKey,
} from "./approval-reactions.js";
import type { IMessageRpcClient } from "./client.js";
import { normalizeIMessageGuid } from "./message-guid.js";
import type { IMessagePayload } from "./monitor/types.js";

const RECENT_CHAT_LIMIT = 50;
const PER_CHAT_HISTORY_LIMIT = 30;

type ChatListEntry = {
  id?: number | null;
};

type HistoryMessage = IMessagePayload & {
  reactions?: Array<{
    id?: number | string | null;
    sender?: string | null;
    is_from_me?: boolean | null;
    type?: string | null;
    emoji?: string | null;
    created_at?: string | null;
  }> | null;
};

function normalizeChatId(value: unknown): number | null {
  return asPositiveFiniteNumber(value) ?? null;
}

function enumerateMessageGuidCandidates(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  const normalized = normalizeIMessageGuid(trimmed);
  return [trimmed, normalized].filter(
    (candidate, index, candidates) =>
      candidate.length > 0 && candidates.indexOf(candidate) === index,
  );
}

async function listRecentChatIds(client: IMessageRpcClient): Promise<number[]> {
  const result = await client.request<{ chats?: ChatListEntry[] }>(
    "chats.list",
    { limit: RECENT_CHAT_LIMIT },
    { timeoutMs: 10_000 },
  );
  return (result.chats ?? [])
    .map((chat) => normalizeChatId(chat.id))
    .filter((chatId): chatId is number => chatId !== null);
}

export async function pollPendingIMessageApprovalReactions(params: {
  signal?: AbortSignal;
  client: IMessageRpcClient;
  cfg: OpenClawConfig;
  accountId: string;
  allowRecentChatDiscovery?: boolean;
  gatewayRuntime?: IMessageApprovalGatewayRuntime;
}): Promise<void> {
  const targets = await listPendingIMessageApprovalReactionPollTargets({
    accountId: params.accountId,
  });
  if (params.signal?.aborted || targets.length === 0) {
    return;
  }
  const pendingByMessageId = new Map<string, PendingIMessageApprovalReactionPollTarget>();
  for (const target of targets) {
    for (const candidate of enumerateMessageGuidCandidates(target.messageId)) {
      pendingByMessageId.set(candidate, target);
    }
  }
  const targetChatIds = new Set<number>();
  for (const target of targets) {
    const chatId = normalizeChatId(target.conversation.chatId);
    if (chatId !== null) {
      targetChatIds.add(chatId);
    }
  }
  const explicitChatIds = [...targetChatIds];
  // Send-side DM registration may know only a handle, not a chat id. Scan recent chats
  // for those typed GUID targets or a watch-missed tapback would silently resolve nothing.
  const shouldDiscoverRecentChats =
    params.allowRecentChatDiscovery === true &&
    targets.some((target) => normalizeChatId(target.conversation.chatId) === null);
  const chatIds = shouldDiscoverRecentChats
    ? [...new Set([...explicitChatIds, ...(await listRecentChatIds(params.client))])]
    : explicitChatIds;
  for (const chatId of chatIds) {
    if (params.signal?.aborted) {
      return;
    }
    let messages: HistoryMessage[];
    try {
      const client = params.client;
      const result = await client.request<{ messages?: unknown[] }>(
        "messages.history",
        { chat_id: chatId, limit: PER_CHAT_HISTORY_LIMIT },
        { timeoutMs: 10_000 },
      );
      messages = (result.messages ?? []).filter((message): message is HistoryMessage =>
        Boolean(message && typeof message === "object"),
      );
    } catch (err) {
      logVerbose(`imessage: approval reaction poll skipped chat_id=${chatId}: ${String(err)}`);
      continue;
    }
    for (const message of messages) {
      if (params.signal?.aborted) {
        return;
      }
      const targetGuid = message.guid?.trim();
      if (!targetGuid) {
        continue;
      }
      const target =
        pendingByMessageId.get(targetGuid) ??
        pendingByMessageId.get(normalizeIMessageGuid(targetGuid));
      if (!target) {
        continue;
      }
      await (async () => {
        const nowMs = asDateTimestampMs(Date.now());
        const expiresAtMs = asDateTimestampMs(target.expiresAtMs);
        if (nowMs === undefined || expiresAtMs === undefined || expiresAtMs <= nowMs) {
          return;
        }
        const ttlMs = expiresAtMs - nowMs;
        const conversation: IMessageApprovalConversationKey = {
          ...(message.chat_guid?.trim() ? { chatGuid: message.chat_guid.trim() } : {}),
          ...(message.chat_identifier?.trim()
            ? { chatIdentifier: message.chat_identifier.trim() }
            : {}),
          ...(normalizeChatId(message.chat_id) !== null
            ? { chatId: message.chat_id as number }
            : {}),
        };
        const messageIds = new Set([
          ...enumerateMessageGuidCandidates(target.messageId),
          ...enumerateMessageGuidCandidates(message.guid ?? ""),
        ]);
        await Promise.all(
          [...messageIds].map((messageId) =>
            registerIMessageApprovalReactionTarget({
              accountId: target.accountId,
              conversation,
              messageId,
              approvalId: target.approvalId,
              approvalKind: target.approvalKind,
              allowedDecisions: target.allowedDecisions,
              ttlMs,
            }),
          ),
        );
      })();
      for (const reaction of message.reactions ?? []) {
        if (params.signal?.aborted) {
          return;
        }
        const reactionPayload = ((): IMessagePayload | null => {
          const emoji = reaction.emoji?.trim();
          const sender = reaction.sender?.trim();
          const reactionTargetGuid = message.guid?.trim();
          if (!emoji || !sender || !reactionTargetGuid) {
            return null;
          }
          const reactionId = normalizeChatId(reaction.id);
          return {
            ...(reactionId !== null ? { id: reactionId } : {}),
            guid: `reaction:${reactionTargetGuid}:${sender}:${emoji}:${reaction.created_at ?? ""}`,
            chat_id: message.chat_id,
            chat_guid: message.chat_guid,
            chat_identifier: message.chat_identifier,
            chat_name: message.chat_name,
            participants: message.participants,
            is_group: message.is_group,
            sender,
            destination_caller_id: message.destination_caller_id,
            is_from_me: reaction.is_from_me,
            text: `${reaction.type ?? "reaction"} "${message.text ?? ""}"`,
            created_at: reaction.created_at,
            is_reaction: true,
            is_tapback: true,
            associated_message_guid: reactionTargetGuid,
            associated_message_type: 2000,
            reaction_type: reaction.type ?? undefined,
            reaction_emoji: emoji,
            is_reaction_add: true,
            reacted_to_guid: reactionTargetGuid,
          };
        })();
        if (!reactionPayload) {
          continue;
        }
        const handled = await handleIMessageApprovalReaction({
          cfg: params.cfg,
          accountId: params.accountId,
          message: reactionPayload,
          bodyText: reactionPayload.text ?? "",
          gatewayRuntime: params.gatewayRuntime,
        });
        if (handled.stopPolling) {
          return;
        }
      }
    }
  }
}
