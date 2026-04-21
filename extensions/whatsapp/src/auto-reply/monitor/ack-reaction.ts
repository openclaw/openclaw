import {
  createAckReactionHandle,
  shouldAckReactionForWhatsApp,
  type AckReactionHandle,
} from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getSenderIdentity } from "../../identity.js";
import { resolveWhatsAppReactionLevel } from "../../reaction-level.js";
import {
  bodyLooksLikeWhatsAppWorkIntake,
  resolveWhatsAppWorkIntakeReaction,
} from "../../reaction-policy.js";
import { sendReactionWhatsApp } from "../../send.js";
import { formatError } from "../../session.js";
import type { WebInboundMsg } from "../types.js";
import { resolveGroupActivationFor } from "./group-activation.js";

const workIntakeReactionLastSentAt = new Map<string, number>();

function shouldSendWorkIntakeReaction(params: {
  msg: WebInboundMsg;
  activation: "always" | "mention" | "never" | null;
  directEnabled: boolean;
  groupMode: "always" | "mentions" | "never";
}) {
  if (params.msg.chatType === "direct") {
    return params.directEnabled;
  }
  if (params.msg.chatType !== "group") {
    return false;
  }
  if (params.groupMode === "never") {
    return false;
  }
  if (params.groupMode === "always") {
    return true;
  }
  return params.msg.wasMentioned === true || params.activation === "always";
}

function markWorkIntakeReactionSent(params: {
  accountId?: string;
  chatId: string;
  senderId?: string | null;
  cooldownMs: number;
  now: number;
}) {
  if (params.cooldownMs <= 0) {
    return true;
  }
  const key = [params.accountId ?? "default", params.chatId, params.senderId ?? "unknown"].join(
    ":",
  );
  const lastSentAt = workIntakeReactionLastSentAt.get(key);
  if (lastSentAt != null && params.now - lastSentAt < params.cooldownMs) {
    return false;
  }
  workIntakeReactionLastSentAt.set(key, params.now);
  for (const [entryKey, sentAt] of workIntakeReactionLastSentAt) {
    if (params.now - sentAt > Math.max(params.cooldownMs * 4, 300000)) {
      workIntakeReactionLastSentAt.delete(entryKey);
    }
  }
  return true;
}

export async function maybeSendAckReaction(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMsg;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  verbose: boolean;
  accountId?: string;
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}): Promise<AckReactionHandle | null> {
  if (!params.msg.id) {
    return null;
  }
  const messageId = params.msg.id;

  // Keep ackReaction as the emoji/scope control, while letting reactionLevel
  // suppress all automatic reactions when it is explicitly set to "off".
  const reactionLevel = resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (reactionLevel.level === "off") {
    return null;
  }

  const workIntakeConfig = resolveWhatsAppWorkIntakeReaction({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const ackConfig = params.cfg.channels?.whatsapp?.ackReaction;
  const emoji = (ackConfig?.emoji ?? "").trim();
  const directEnabled = ackConfig?.direct ?? true;
  const groupMode = ackConfig?.group ?? "mentions";
  const conversationIdForCheck = params.msg.conversationId ?? params.msg.from;

  const activation =
    params.msg.chatType === "group"
      ? await resolveGroupActivationFor({
          cfg: params.cfg,
          accountId: params.accountId,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          conversationId: conversationIdForCheck,
        })
      : null;
  const sender = getSenderIdentity(params.msg);
  if (
    workIntakeConfig &&
    shouldSendWorkIntakeReaction({
      msg: params.msg,
      activation,
      directEnabled: workIntakeConfig.direct ?? true,
      groupMode: workIntakeConfig.group ?? "mentions",
    }) &&
    bodyLooksLikeWhatsAppWorkIntake({
      body: params.msg.body,
      mediaType: params.msg.mediaType,
      config: workIntakeConfig,
    }) &&
    markWorkIntakeReactionSent({
      accountId: params.accountId,
      chatId: params.msg.chatId,
      senderId: sender.jid ?? sender.e164 ?? params.msg.from,
      cooldownMs: workIntakeConfig.cooldownMs ?? 120000,
      now: Date.now(),
    })
  ) {
    params.info(
      { chatId: params.msg.chatId, messageId, emoji: workIntakeConfig.emoji },
      "sending work-intake reaction",
    );
    sendReactionWhatsApp(params.msg.chatId, messageId, workIntakeConfig.emoji, {
      verbose: params.verbose,
      fromMe: false,
      participant: sender.jid ?? undefined,
      accountId: params.accountId,
    }).catch((err) => {
      params.warn(
        {
          error: formatError(err),
          chatId: params.msg.chatId,
          messageId,
        },
        "failed to send work-intake reaction",
      );
      logVerbose(
        `WhatsApp work-intake reaction failed for chat ${params.msg.chatId}: ${formatError(err)}`,
      );
    });
    return null;
  }

  const shouldSendReaction = () =>
    shouldAckReactionForWhatsApp({
      emoji,
      isDirect: params.msg.chatType === "direct",
      isGroup: params.msg.chatType === "group",
      directEnabled,
      groupMode,
      wasMentioned: params.msg.wasMentioned === true,
      groupActivated: activation === "always",
    });

  if (!shouldSendReaction()) {
    return null;
  }

  params.info({ chatId: params.msg.chatId, messageId, emoji }, "sending ack reaction");
  const reactionOptions = {
    verbose: params.verbose,
    fromMe: false,
    ...(sender.jid ? { participant: sender.jid } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    cfg: params.cfg,
  };
  return createAckReactionHandle({
    ackReactionValue: emoji,
    send: () => sendReactionWhatsApp(params.msg.chatId, messageId, emoji, reactionOptions),
    remove: () => sendReactionWhatsApp(params.msg.chatId, messageId, "", reactionOptions),
    onSendError: (err) => {
      params.warn(
        {
          error: formatError(err),
          chatId: params.msg.chatId,
          messageId,
        },
        "failed to send ack reaction",
      );
      logVerbose(`WhatsApp ack reaction failed for chat ${params.msg.chatId}: ${formatError(err)}`);
    },
  });
}
