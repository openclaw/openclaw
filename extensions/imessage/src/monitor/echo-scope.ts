import { formatIMessageChatTarget } from "../targets.js";
import type { SentMessageCache } from "./echo-cache.js";

/**
 * Strict reflected-reply probe.
 *
 * Direct replies are dispatched with the provider's exact chat-id target and persisted
 * under that scope, so the probe has to consult every scope the conversation can be
 * keyed by. Scopes are probed in order and short-circuit on the first hit, which keeps
 * the common `imessage:<handle>` case to a single cache read.
 */
export async function hasReflectedReplyEcho(params: {
  echoCache: Pick<SentMessageCache, "has">;
  scopes: readonly string[];
  text: string;
  messageId: string;
}): Promise<boolean> {
  for (const scope of params.scopes) {
    if (
      await params.echoCache.has(
        scope,
        { text: params.text, messageId: params.messageId },
        { requireMessageIdTextMatch: true },
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Build every echo-cache scope this conversation's outbound messages can be
 * persisted under (see `resolveOutboundEchoScope` in send.ts).
 *
 * Inbound messages carry chat_id, chat_guid, and chat_identifier when
 * available, but the outbound side only writes one of them — whichever shape
 * the caller used. Returning all candidates lets echo lookups cross-check, so a
 * chat_guid-keyed send is suppressed even when chat.db annotates the inbound
 * row with chat_id+chat_identifier (or any other permutation).
 *
 * Direct replies are dispatched with the provider's exact chat-id target
 * (`replyTarget` in inbound-processing picks `chat_id:<n>` whenever the inbound
 * row has one, which real chat.db rows almost always do), and the generic
 * scope only mirrors that shape for group chats. Strict callers that must match
 * a reflected direct reply opt in with `includeDirectChatIdScope` so the probe
 * covers what the send side actually persisted.
 */
export function buildIMessageEchoScope(params: {
  accountId: string;
  isGroup: boolean;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  sender: string;
  includeDirectChatIdScope?: boolean;
}): string[] {
  const scopes: string[] = [];
  if (!params.isGroup) {
    scopes.push(`${params.accountId}:imessage:${params.sender}`);
  }
  if (params.isGroup || params.includeDirectChatIdScope) {
    const chatIdScope = formatIMessageChatTarget(params.chatId);
    if (chatIdScope) {
      scopes.push(`${params.accountId}:${chatIdScope}`);
    }
  }
  if (params.chatGuid) {
    scopes.push(`${params.accountId}:chat_guid:${params.chatGuid}`);
  }
  if (params.chatIdentifier) {
    scopes.push(`${params.accountId}:chat_identifier:${params.chatIdentifier}`);
  }
  return scopes;
}
