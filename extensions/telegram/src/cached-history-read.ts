import {
  readPositiveIntegerParam,
  readStringOrNumberParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import {
  getSessionEntry,
  resolveStorePath,
  resolveTranscriptSessionKeyBySessionId,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { listTelegramAccountIds, mergeTelegramAccountConfig } from "./accounts.js";
import { readCachedTelegramBotInfo } from "./bot-info-cache.js";
import { selectAllowedTelegramCachedContext } from "./cached-history-access.js";
import {
  resolveTelegramMessageCacheScope,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
} from "./message-cache-persistence.js";
import {
  createTelegramMessageCache,
  isTelegramSessionBoundaryCommandNode,
  type TelegramCachedMessageNode,
} from "./message-cache.js";
import {
  resolveTelegramCachedHistoryScope,
  type TelegramMessageMutationContext,
} from "./message-topic-binding.js";
import { resolveTelegramBotUserIdFromToken } from "./token-fingerprint.js";
import { resolveTelegramToken } from "./token.js";

const MAX_MESSAGES = 100;
// UTF-8 bytes bound even adversarial high-token-density text, not just message count.
const MAX_RESULT_BYTES = 32 * 1024;

type SafeMessage = Pick<
  TelegramCachedMessageNode,
  | "messageId"
  | "sender"
  | "senderId"
  | "senderUsername"
  | "timestamp"
  | "body"
  | "mediaType"
  | "mediaRef"
  | "replyToId"
  | "threadId"
> & { truncated?: true };

function projectMessage(node: TelegramCachedMessageNode): SafeMessage {
  const {
    messageId,
    sender,
    senderId,
    senderUsername,
    timestamp,
    body,
    mediaType,
    mediaRef,
    replyToId,
    threadId,
  } = node;
  return {
    messageId,
    sender,
    senderId,
    senderUsername,
    timestamp,
    body,
    mediaType,
    mediaRef,
    replyToId,
    threadId,
  };
}

export async function readTelegramCachedHistory(input: {
  params: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
  context?: TelegramMessageMutationContext;
}) {
  const { params, cfg, context } = input;
  const scope = resolveTelegramCachedHistoryScope({
    cfg,
    accountId: input.accountId,
    context,
    chatId:
      readStringOrNumberParam(params, "chatId") ??
      readStringOrNumberParam(params, "channelId") ??
      readStringOrNumberParam(params, "to"),
    threadId:
      readPositiveIntegerParam(params, "threadId") ??
      readPositiveIntegerParam(params, "messageThreadId"),
  });
  if (
    !listTelegramAccountIds(cfg).includes(scope.accountId) ||
    cfg.channels?.telegram?.enabled === false ||
    mergeTelegramAccountConfig(cfg, scope.accountId).enabled === false
  ) {
    throw new Error("Telegram cached history account is unavailable.");
  }
  const currentId = parseStrictPositiveInteger(context?.toolContext?.currentMessageId);
  const before = readPositiveIntegerParam(params, "before") ?? currentId;
  if (
    before === undefined ||
    (context?.conversationReadOrigin === "delegated" &&
      (currentId === undefined || before > currentId))
  ) {
    throw new Error(
      "Telegram cached history requires an exclusive native before ID at or before the current message.",
    );
  }
  const limit = Math.min(readPositiveIntegerParam(params, "limit") ?? 50, MAX_MESSAGES);
  const cache = createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(
      resolveStorePath(cfg.session?.store, {
        agentId: resolveTelegramAccountOwnerAgentId({ cfg, accountId: scope.accountId }),
      }),
    ),
  });
  // Scan relative to the trusted current message, not the paging cursor: paging
  // backwards must never cross a reset that occurred after the requested cursor.
  const nodes = await cache.recentBefore({
    ...scope,
    messageId: String(currentId ?? before),
    limit: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
  });
  const botToken = resolveTelegramToken(cfg, { accountId: scope.accountId }).token;
  const botInfo = await readCachedTelegramBotInfo({ accountId: scope.accountId, botToken });
  const allowedIds = await selectAllowedTelegramCachedContext({
    ...scope,
    cfg,
    telegramCfg: mergeTelegramAccountConfig(cfg, scope.accountId),
    threadSpec: { scope: scope.chatId.startsWith("-") ? "forum" : "dm", id: scope.threadId },
    nodes: nodes.filter((node) => node.sourceMessage.chat.is_direct_messages !== true),
    botId: resolveTelegramBotUserIdFromToken(botToken),
    botUsername: botInfo?.botInfo.username,
  });
  // A reset during cache or policy reads must apply before publishing this page.
  const sessionKey = context?.sessionKey?.trim();
  const sessionId = context?.sessionId?.trim();
  const agentId = sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined;
  const storePath = agentId ? resolveStorePath(cfg.session?.store, { agentId }) : undefined;
  // A DM's policy key can differ from its persisted main-session key.
  const persistedSessionKey =
    context?.conversationReadOrigin === "delegated"
      ? agentId && sessionId
        ? resolveTranscriptSessionKeyBySessionId({ agentId, sessionId, storePath })
        : undefined
      : sessionKey;
  const entry = persistedSessionKey
    ? getSessionEntry({ agentId, sessionKey: persistedSessionKey, storePath })
    : undefined;
  if (
    context?.conversationReadOrigin === "delegated" &&
    (!entry || entry.sessionId !== sessionId)
  ) {
    throw new Error("Telegram cached history requires the current host session.");
  }
  const minTimestamp =
    entry?.sessionStartedAt === undefined
      ? undefined
      : Math.floor(entry.sessionStartedAt / 1000) * 1000;
  const allowed = nodes.filter(
    (node) =>
      allowedIds.has(node.messageId) &&
      (minTimestamp === undefined ||
        (node.timestamp !== undefined && node.timestamp >= minTimestamp)),
  );
  const boundary = allowed.findLast(isTelegramSessionBoundaryCommandNode);
  const eligible = allowed.filter(
    (node) =>
      Number(node.messageId) < before &&
      (!boundary || Number(node.messageId) > Number(boundary.messageId)),
  );
  const messages: SafeMessage[] = [];
  const result: {
    ok: true;
    source: string;
    messages: SafeMessage[];
    nextBefore?: string;
    hasMore: boolean;
  } = {
    ok: true,
    source: "telegram-cache",
    messages,
    nextBefore: undefined,
    hasMore: false,
  };
  for (const node of eligible.toReversed()) {
    if (messages.length >= limit) {
      break;
    }
    const projected = projectMessage(node);
    messages.unshift(projected);
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES - 128) {
      messages.shift();
      if (messages.length === 0) {
        projected.truncated = true;
        let body = projected.body ?? "";
        do {
          body = body.slice(0, Math.floor(body.length / 2));
          projected.body = body;
        } while (
          body &&
          Buffer.byteLength(JSON.stringify(projected), "utf8") > MAX_RESULT_BYTES - 512
        );
        if (Buffer.byteLength(JSON.stringify(projected), "utf8") <= MAX_RESULT_BYTES - 512) {
          messages.push(projected);
        }
      }
      break;
    }
  }
  result.nextBefore = messages[0]?.messageId;
  result.hasMore = eligible.length > messages.length;
  return result;
}
