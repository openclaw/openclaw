import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/dingtalk";
import {
  createScopedPairingAccess,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/dingtalk";
import { resolveDingtalkAccount } from "./accounts.js";
import { createDingtalkReplyDispatcher } from "./reply-dispatcher.js";
import { getDingtalkRuntime } from "./runtime.js";
import { sendTextMessage } from "./send.js";
import type {
  DingtalkRobotMessage,
  DingtalkMessageContext,
  ResolvedDingtalkAccount,
  DingtalkConfig,
} from "./types.js";

/**
 * 解析钉钉消息事件为统一上下文 / Parse DingTalk message event into unified context
 */
function parseDingtalkMessageEvent(msg: DingtalkRobotMessage): DingtalkMessageContext {
  // 提取文本内容 / Extract text content
  let content = "";
  let contentType = msg.msgtype ?? "text";

  if (msg.msgtype === "text" && msg.text?.content) {
    content = msg.text.content.trim();
  } else if (msg.content) {
    // 非文本消息（图片/富文本等），content 是 JSON 字符串 / Non-text messages, content is JSON string
    content = msg.content;
  }

  // 判断是否 @了机器人 / Check if bot was mentioned
  const mentionedBot = msg.conversationType === "1" || msg.isInAtList === true;

  return {
    conversationId: msg.conversationId,
    messageId: msg.msgId,
    senderId: msg.senderId,
    senderStaffId: msg.senderStaffId,
    senderNick: msg.senderNick,
    conversationType: msg.conversationType,
    mentionedBot,
    content,
    contentType,
    sessionWebhook: msg.sessionWebhook,
    sessionWebhookExpiredTime: msg.sessionWebhookExpiredTime,
    robotCode: msg.robotCode,
    chatbotUserId: msg.chatbotUserId,
    conversationTitle: msg.conversationTitle,
  };
}

/**
 * 检查群组是否在白名单中 / Check if group is in allowlist
 */
function isGroupAllowed(params: {
  groupPolicy: string;
  allowFrom: Array<string | number>;
  groupId: string;
}): boolean {
  const { groupPolicy, allowFrom, groupId } = params;
  if (groupPolicy === "open") return true;
  if (groupPolicy === "disabled") return false;
  return allowFrom.some((entry) => String(entry).trim() === groupId);
}

/**
 * 处理钉钉消息的主入口 / Main entry for handling DingTalk messages
 */
export async function handleDingtalkMessage(params: {
  cfg: ClawdbotConfig;
  account: ResolvedDingtalkAccount;
  msg: DingtalkRobotMessage;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const { cfg, account, msg, runtime } = params;
  const dingtalkCfg = account.config;
  const log = runtime?.log ?? console.log;
  const core = getDingtalkRuntime();

  const ctx = parseDingtalkMessageEvent(msg);
  const isDirect = ctx.conversationType === "1";
  const isGroup = ctx.conversationType === "2";

  log(
    `dingtalk[${account.accountId}]: received ${isDirect ? "DM" : "group"} message from ${ctx.senderStaffId} (${ctx.senderNick})`,
  );

  // --- 群组策略检查 / Group policy check ---
  if (isGroup) {
    const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
    const { groupPolicy, providerMissingFallbackApplied } =
      resolveOpenProviderRuntimeGroupPolicy({
        providerConfigPresent: cfg.channels?.dingtalk !== undefined,
        groupPolicy: dingtalkCfg?.groupPolicy,
        defaultGroupPolicy,
      });
    warnMissingProviderGroupPolicyFallbackOnce({
      providerMissingFallbackApplied,
      providerKey: "dingtalk",
      accountId: account.accountId,
      log,
    });

    const groupAllowFrom = dingtalkCfg?.groupAllowFrom ?? [];
    const groupAllowed = isGroupAllowed({
      groupPolicy,
      allowFrom: groupAllowFrom,
      groupId: ctx.conversationId,
    });

    if (!groupAllowed) {
      log(`dingtalk[${account.accountId}]: group ${ctx.conversationId} not allowed`);
      return;
    }

    // 群聊中检查 @机器人要求 / Check mention requirement in group chat
    const requireMention = dingtalkCfg?.requireMention ?? true;
    if (requireMention && !ctx.mentionedBot) {
      log(`dingtalk[${account.accountId}]: message in group did not mention bot, skipping`);
      return;
    }
  }

  // --- DM 策略检查 / DM policy check ---
  if (isDirect) {
    const dmPolicy = dingtalkCfg?.dmPolicy ?? "pairing";
    const configAllowFrom = dingtalkCfg?.allowFrom ?? [];

    if (dmPolicy === "disabled") {
      log(`dingtalk[${account.accountId}]: DMs are disabled`);
      return;
    }

    if (dmPolicy === "allowlist") {
      const allowed = configAllowFrom.some(
        (entry) =>
          String(entry).trim() === ctx.senderStaffId ||
          String(entry).trim() === "*",
      );
      if (!allowed) {
        log(`dingtalk[${account.accountId}]: sender ${ctx.senderStaffId} not in allowlist`);
        return;
      }
    }

    if (dmPolicy === "pairing") {
      const pairing = createScopedPairingAccess({
        core,
        channel: "dingtalk",
        accountId: account.accountId,
      });
      const storeAllowFrom = await pairing.readAllowFromStore().catch(() => []);
      const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
      const allowed = effectiveAllowFrom.some(
        (entry) =>
          String(entry).trim() === ctx.senderStaffId ||
          String(entry).trim() === "*",
      );
      if (!allowed) {
        log(
          `dingtalk[${account.accountId}]: sender ${ctx.senderStaffId} not paired, requesting pairing`,
        );
        const { code, created } = await pairing.upsertPairingRequest({
          id: ctx.senderStaffId,
          meta: { name: ctx.senderNick },
        });
        if (created) {
          log(
            `dingtalk[${account.accountId}]: pairing code ${code} for ${ctx.senderStaffId}`,
          );
          try {
            await sendTextMessage({
              account,
              conversationType: "1",
              conversationId: "",
              senderStaffId: ctx.senderStaffId,
              text: core.channel.pairing.buildPairingReply({
                channel: "dingtalk",
                idLine: `Your DingTalk user id: ${ctx.senderStaffId}`,
                code,
              }),
            });
          } catch (err) {
            log(
              `dingtalk[${account.accountId}]: failed to send pairing reply: ${err}`,
            );
          }
        }
        return;
      }
    }
  }

  // --- 构建消息体并分发给 agent / Build message body and dispatch to agent ---
  const messageBody = buildMessageBody(ctx);

  const dingtalkFrom = `dingtalk:${ctx.senderStaffId}`;
  const dingtalkTo = isGroup ? `chat:${ctx.conversationId}` : `user:${ctx.senderStaffId}`;
  const peerId = isGroup ? ctx.conversationId : ctx.senderStaffId;

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "dingtalk",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: messageBody,
    BodyForAgent: messageBody,
    RawBody: ctx.content,
    CommandBody: ctx.content,
    From: dingtalkFrom,
    To: dingtalkTo,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    GroupSubject: isGroup ? ctx.conversationId : undefined,
    SenderName: ctx.senderNick,
    SenderId: ctx.senderStaffId,
    Provider: "dingtalk" as const,
    Surface: "dingtalk" as const,
    MessageSid: ctx.messageId,
    Timestamp: Date.now(),
    WasMentioned: ctx.mentionedBot,
    OriginatingChannel: "dingtalk" as const,
    OriginatingTo: dingtalkTo,
  });

  const { dispatcher, replyOptions, markDispatchIdle } = createDingtalkReplyDispatcher({
    cfg,
    account,
    ctx,
    log,
  });

  log(`dingtalk[${account.accountId}]: dispatching to agent (session=${route.sessionKey})`);

  await core.channel.reply.withReplyDispatcher({
    dispatcher,
    onSettled: () => markDispatchIdle(),
    run: () =>
      core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions,
      }),
  });
}

/**
 * 构建消息体 / Build message body for agent
 */
function buildMessageBody(ctx: DingtalkMessageContext): string {
  if (ctx.contentType !== "text") {
    return `[${ctx.contentType} message] ${ctx.content}`;
  }
  return ctx.content;
}
