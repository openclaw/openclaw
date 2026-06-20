// Telegram plugin module implements session conversation behavior.
import { parseAgentSessionKey, parseThreadSessionSuffix } from "openclaw/plugin-sdk/routing";
import { parseTelegramThreadId } from "./outbound-params.js";
import { normalizeTelegramChatId, normalizeTelegramLookupTarget } from "./targets.js";
import { parseTelegramTopicConversation } from "./topic-conversation.js";

export type ParsedTelegramDirectSessionKey = {
  agentId?: string;
  accountId?: string;
  baseSessionKey: string;
  chatId: string;
  messageThreadId?: number;
  threadId?: string;
};

const TELEGRAM_DIRECT_SESSION_RE =
  /^telegram:(?:(?<accountId>[a-z0-9][a-z0-9_-]{0,63}):)?direct:(?<chatId>-?\d+)$/i;

export function resolveTelegramSessionConversation(params: {
  kind: "group" | "channel";
  rawId: string;
}) {
  const parsed = parseTelegramTopicConversation({ conversationId: params.rawId });
  if (!parsed) {
    return null;
  }
  return {
    id: parsed.chatId,
    threadId: parsed.topicId,
    baseConversationId: parsed.chatId,
    parentConversationCandidates: [parsed.chatId],
  };
}

export function parseTelegramDirectSessionKey(
  sessionKey: string | undefined | null,
): ParsedTelegramDirectSessionKey | null {
  const parsedAgent = parseAgentSessionKey(sessionKey);
  const rest = parsedAgent?.rest ?? sessionKey?.trim();
  if (!rest) {
    return null;
  }
  const thread = parseThreadSessionSuffix(rest);
  const baseRest = thread.baseSessionKey ?? rest;
  const match = TELEGRAM_DIRECT_SESSION_RE.exec(baseRest);
  const chatId = match?.groups?.chatId;
  if (!chatId) {
    return null;
  }
  const messageThreadId = thread.threadId ? parseTelegramThreadId(thread.threadId) : undefined;
  return {
    ...(parsedAgent ? { agentId: parsedAgent.agentId } : {}),
    ...(match.groups?.accountId ? { accountId: match.groups.accountId } : {}),
    baseSessionKey: parsedAgent ? `agent:${parsedAgent.agentId}:${baseRest}` : baseRest,
    chatId,
    ...(thread.threadId ? { threadId: thread.threadId } : {}),
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
  };
}

export function resolveTelegramSessionTarget(params: { kind: "group" | "channel"; id: string }) {
  const raw = params.kind === "group" ? `telegram:group:${params.id}` : `telegram:${params.id}`;
  return normalizeTelegramChatId(raw) ?? normalizeTelegramLookupTarget(raw);
}
