import { normalizeTelegramLookupTarget, parseTelegramTarget } from "./targets.js";
import { buildTelegramConversationId, resolveTelegramTargetThread } from "./topic-conversation.js";

const TELEGRAM_PREFIX_RE = /^(telegram|tg):/i;

export function normalizeTelegramMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  const prefixStripped = trimmed.replace(TELEGRAM_PREFIX_RE, "").trim();
  const identity = resolveTelegramTargetIdentity(trimmed);
  if (!identity) {
    return undefined;
  }

  const body = buildTelegramConversationId({
    chatId: identity.chatId,
    thread: resolveTelegramTargetThread(identity),
  });
  return `telegram:${/^group:/i.test(prefixStripped) ? "group:" : ""}${body}`;
}

function resolveTelegramTargetIdentity(raw: string) {
  const parsed = parseTelegramTarget(raw);
  const chatId = normalizeTelegramLookupTarget(parsed.chatId);
  if (!chatId) {
    return undefined;
  }
  return {
    chatId: chatId.toLowerCase(),
    messageThreadId: parsed.messageThreadId,
    directMessagesTopicId: parsed.directMessagesTopicId,
  };
}

export function looksLikeTelegramTargetId(raw: string): boolean {
  return resolveTelegramTargetIdentity(raw) !== undefined;
}

export function telegramMessagingTargetsMatch(target: string, currentTarget: string): boolean {
  const targetIdentity = resolveTelegramTargetIdentity(target);
  const currentIdentity = resolveTelegramTargetIdentity(currentTarget);
  return (
    targetIdentity !== undefined &&
    currentIdentity !== undefined &&
    targetIdentity.chatId === currentIdentity.chatId &&
    targetIdentity.messageThreadId === currentIdentity.messageThreadId &&
    targetIdentity.directMessagesTopicId === currentIdentity.directMessagesTopicId
  );
}
