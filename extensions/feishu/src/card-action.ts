import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { processedCardActions, resolvedCardActionChatTypes } from "./card-action-state.js";
import { decodeFeishuCardAction } from "./card-interaction.js";
import {
  createApprovalCard,
  FEISHU_APPROVAL_CANCEL_ACTION,
  FEISHU_APPROVAL_CONFIRM_ACTION,
  FEISHU_APPROVAL_REQUEST_ACTION,
} from "./card-ux-approval.js";
import { resolveFeishuChatType } from "./chat-type.js";
import { createFeishuClient } from "./client.js";
import { sendCardFeishu, sendMessageFeishu } from "./send.js";

export type FeishuCardActionEvent = {
  operator: {
    open_id: string;
    user_id?: string;
    union_id?: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
  };
  open_message_id?: string;
  context: {
    open_message_id?: string;
    open_id?: string;
    user_id?: string;
    chat_id?: string;
  };
};

const FEISHU_APPROVAL_CARD_TTL_MS = 5 * 60_000;
const FEISHU_CARD_ACTION_TOKEN_TTL_MS = 15 * 60_000;
function pruneExpiredCardEntries(cache: Map<string, { expiresAt: number }>, now: number): void {
  const validNow = asDateTimestampMs(now);
  if (validNow === undefined) {
    cache.clear();
    return;
  }
  for (const [key, entry] of cache) {
    if (!isFutureDateTimestampMs(entry.expiresAt, { nowMs: validNow })) {
      cache.delete(key);
    }
  }
}

function refreshFeishuCardActionToken(key: string, now = Date.now()): void {
  const expiresAt = resolveExpiresAtMsFromDurationMs(FEISHU_CARD_ACTION_TOKEN_TTL_MS, {
    nowMs: now,
  });
  if (expiresAt === undefined) {
    processedCardActions.delete(key);
    return;
  }
  processedCardActions.set(key, { expiresAt });
}

function resolveCallbackTarget(event: FeishuCardActionEvent): string {
  const chatId = event.context.chat_id?.trim();
  if (chatId) {
    return `chat:${chatId}`;
  }
  return `user:${event.operator.open_id}`;
}

const CHAT_TYPE_CACHE_TTL_MS = 30 * 60_000;
const CHAT_TYPE_CACHE_MAX_SIZE = 5_000;

function cacheResolvedCardActionChatType(
  cacheKey: string,
  value: "p2p" | "group",
  now: number,
): void {
  const expiresAt = resolveExpiresAtMsFromDurationMs(CHAT_TYPE_CACHE_TTL_MS, { nowMs: now });
  resolvedCardActionChatTypes.delete(cacheKey);
  if (expiresAt !== undefined) {
    resolvedCardActionChatTypes.set(cacheKey, { value, expiresAt });
  }
}

export async function handleFeishuCardAction(params: {
  trackTask?: (task: Promise<void>) => void;
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  channelRuntime?: PluginRuntime["channel"];
  accountId?: string;
}): Promise<void> {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;
  async function resolveCardActionChatType(chatType?: "p2p" | "group"): Promise<"p2p" | "group"> {
    if (chatType) {
      return chatType;
    }

    const chatId = event.context.chat_id?.trim();
    if (!chatId) {
      return "p2p";
    }

    const cacheKey = `${account.accountId}:${chatId}`;
    const now = Date.now();
    pruneExpiredCardEntries(resolvedCardActionChatTypes, now);
    pruneMapToMaxSize(resolvedCardActionChatTypes, CHAT_TYPE_CACHE_MAX_SIZE);
    const cached = resolvedCardActionChatTypes.get(cacheKey);
    if (cached) {
      return cached.value;
    }

    try {
      const response = (await createFeishuClient(account).im.chat.get({
        path: { chat_id: chatId },
      })) as { code?: number; data?: { chat_type?: unknown; chat_mode?: unknown } };
      if (response.code === 0) {
        const resolvedChatType = resolveFeishuChatType(response.data ?? {});
        if (resolvedChatType) {
          cacheResolvedCardActionChatType(cacheKey, resolvedChatType, now);
          return resolvedChatType;
        }
        log(
          `feishu[${account.accountId}]: card action missing chat type for chat; defaulting to p2p`,
        );
      } else {
        log(`feishu[${account.accountId}]: failed to resolve chat type; defaulting to p2p`);
      }
    } catch {
      log(`feishu[${account.accountId}]: failed to resolve chat type; defaulting to p2p`);
    }

    return "p2p";
  }

  async function dispatchSyntheticCommand(
    command: string,
    chatType?: "p2p" | "group",
  ): Promise<void> {
    const { trackTask, botOpenId, channelRuntime } = params;
    const resolvedChatType = await resolveCardActionChatType(chatType);
    function buildSyntheticMessageEvent(): FeishuMessageEvent {
      const replyTargetMessageId = event.context.open_message_id ?? event.open_message_id;
      // card-action-c-* IDs are temporary callback tokens, not valid Feishu message IDs.
      // Using them as reply targets causes "Invalid ids" errors from the streaming reply API.
      const isTemporaryCardActionId = replyTargetMessageId?.startsWith("card-action-c-");
      const validReplyTargetId =
        replyTargetMessageId && !isTemporaryCardActionId ? replyTargetMessageId : undefined;
      const normalizedBotOpenId = resolvedChatType === "group" ? botOpenId?.trim() : undefined;
      return {
        sender: {
          sender_id: {
            open_id: event.operator.open_id,
            user_id: event.operator.user_id,
            union_id: event.operator.union_id,
          },
        },
        message: {
          message_id: `card-action-${event.token}`,
          ...(validReplyTargetId ? { reply_target_message_id: validReplyTargetId } : {}),
          ...(validReplyTargetId ? { typing_target_message_id: validReplyTargetId } : {}),
          ...(!validReplyTargetId ? { suppress_reply_target: true } : {}),
          chat_id: event.context.chat_id || event.operator.open_id,
          chat_type: resolvedChatType,
          message_type: "text",
          content: JSON.stringify({ text: command }),
          ...(normalizedBotOpenId
            ? {
                mentions: [
                  {
                    key: "mention_bot",
                    id: { open_id: normalizedBotOpenId },
                    name: "bot",
                  },
                ],
              }
            : {}),
        },
      };
    }
    await handleFeishuMessage({
      trackTask,
      cfg,
      event: buildSyntheticMessageEvent(),
      botOpenId,
      runtime,
      channelRuntime,
      accountId,
    });
  }

  const sendInvalidInteractionNotice = async (
    reason: "malformed" | "stale" | "wrong_user" | "wrong_conversation",
  ): Promise<void> => {
    const reasonText =
      reason === "stale"
        ? "This card action has expired. Open a fresh launcher card and try again."
        : reason === "wrong_user"
          ? "This card action belongs to a different user."
          : reason === "wrong_conversation"
            ? "This card action belongs to a different conversation."
            : "This card action payload is invalid.";

    await sendMessageFeishu({
      cfg,
      to: resolveCallbackTarget(event),
      text: `⚠️ ${reasonText}`,
      accountId,
    });
  };
  const normalizedToken = event.token.trim();
  if (!normalizedToken) {
    log(
      `feishu[${account.accountId}]: rejected card action from ${event.operator.open_id}: missing token`,
    );
    return;
  }
  const decoded = decodeFeishuCardAction({ event });
  const now = Date.now();
  pruneExpiredCardEntries(processedCardActions, now);
  const tokenKey = `${account.accountId}:${normalizedToken}`;
  if (processedCardActions.has(tokenKey)) {
    log(`feishu[${account.accountId}]: skipping duplicate card action token`);
    return;
  }
  refreshFeishuCardActionToken(tokenKey, now);

  try {
    if (decoded.kind === "invalid") {
      log(
        `feishu[${account.accountId}]: rejected card action from ${event.operator.open_id}: ${decoded.reason}`,
      );
      await sendInvalidInteractionNotice(decoded.reason);
      return;
    }

    if (decoded.kind === "structured") {
      const { envelope } = decoded;
      log(
        `feishu[${account.accountId}]: handling structured card action ${envelope.a} from ${event.operator.open_id}`,
      );

      if (envelope.a === FEISHU_APPROVAL_REQUEST_ACTION) {
        const command = typeof envelope.m?.command === "string" ? envelope.m.command.trim() : "";
        if (!command) {
          await sendInvalidInteractionNotice("malformed");
          return;
        }
        const prompt =
          typeof envelope.m?.prompt === "string" && envelope.m.prompt.trim()
            ? envelope.m.prompt
            : `Run \`${command}\` in this Feishu conversation?`;
        const expiresAt = resolveExpiresAtMsFromDurationMs(FEISHU_APPROVAL_CARD_TTL_MS);
        if (expiresAt === undefined) {
          await sendInvalidInteractionNotice("malformed");
          return;
        }
        await sendCardFeishu({
          cfg,
          to: resolveCallbackTarget(event),
          card: createApprovalCard({
            operatorOpenId: event.operator.open_id,
            chatId: event.context.chat_id || undefined,
            command,
            prompt,
            sessionKey: envelope.c?.s,
            expiresAt,
            chatType: await resolveCardActionChatType(envelope.c?.t),
            confirmLabel: command === "/reset" ? "Reset" : "Confirm",
          }),
          accountId,
        });
        return;
      }

      if (envelope.a === FEISHU_APPROVAL_CANCEL_ACTION) {
        await sendMessageFeishu({
          cfg,
          to: resolveCallbackTarget(event),
          text: "Cancelled.",
          accountId,
        });
        return;
      }

      if (envelope.a === FEISHU_APPROVAL_CONFIRM_ACTION || envelope.k === "quick") {
        const command = envelope.q?.trim();
        if (!command) {
          await sendInvalidInteractionNotice("malformed");
          return;
        }
        await dispatchSyntheticCommand(command, envelope.c?.t);
        return;
      }

      await sendInvalidInteractionNotice("malformed");
      return;
    }

    await dispatchSyntheticCommand(decoded.text);
  } finally {
    refreshFeishuCardActionToken(tokenKey);
  }
}
