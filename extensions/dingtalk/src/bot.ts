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
  DingtalkNonTextContent,
  DingtalkAudioContent,
  DingtalkRichTextContent,
  DingtalkFileContent,
  ResolvedDingtalkAccount,
  DingtalkConfig,
  DingtalkGroupConfig,
} from "./types.js";

/**
 * Safely resolve non-text content — handles both pre-parsed objects and JSON strings.
 */
function resolveNonTextContent(
  raw: string | DingtalkNonTextContent | undefined,
): DingtalkNonTextContent | undefined {
  if (!raw) return undefined;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw) as DingtalkNonTextContent;
  } catch {
    return undefined;
  }
}

/**
 * Parse DingTalk message event into unified context.
 * Handles all message types: text, picture, video, audio, richText, file.
 */
function parseDingtalkMessageEvent(msg: DingtalkRobotMessage): DingtalkMessageContext {
  const contentType = msg.msgtype ?? "text";
  let content = "";

  if (contentType === "text") {
    content = (msg.text?.content ?? "").trim();
  } else {
    const parsed = resolveNonTextContent(msg.content);
    content = buildNonTextContent(contentType, parsed);
  }

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
 * Build a human-readable string for non-text message types.
 */
function buildNonTextContent(msgtype: string, parsed: DingtalkNonTextContent | undefined): string {
  if (!parsed) return `[${msgtype} message]`;

  switch (msgtype) {
    case "picture":
      return "[Image]";

    case "audio": {
      const audio = parsed as DingtalkAudioContent;
      if (audio.recognition) return audio.recognition;
      const dur = audio.duration ? ` ${audio.duration}s` : "";
      return `[Audio${dur}]`;
    }

    case "video": {
      return "[Video]";
    }

    case "richText": {
      const rich = parsed as DingtalkRichTextContent;
      if (!rich.richText?.length) return "[Rich text]";
      const parts = rich.richText
        .map((seg) => {
          if (seg.text) return seg.text;
          if (seg.pictureDownloadCode || seg.downloadCode) return "[Image]";
          return "";
        })
        .filter(Boolean);
      return parts.join(" ") || "[Rich text]";
    }

    case "file": {
      const file = parsed as DingtalkFileContent;
      return file.fileName ? `[File: ${file.fileName}]` : "[File]";
    }

    default:
      return `[${msgtype} message]`;
  }
}

/**
 * Resolve per-group config: exact match > wildcard "*" > undefined.
 */
function resolveDingtalkGroupConfig(params: {
  cfg?: DingtalkConfig;
  groupId?: string | null;
}): DingtalkGroupConfig | undefined {
  const groups = params.cfg?.groups ?? {};
  const wildcard = groups["*"];
  const groupId = params.groupId?.trim();
  if (!groupId) return undefined;

  const direct = groups[groupId];
  if (direct) return direct;

  const ciMatch = Object.entries(groups).find(
    ([k, v]) => k !== "*" && v && k.toLowerCase() === groupId.toLowerCase(),
  );
  if (ciMatch) return ciMatch[1];

  return wildcard;
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

type GroupSessionScope = "group" | "group_sender";

/**
 * Derive the peer ID based on groupSessionScope.
 */
function resolveGroupPeerId(params: {
  conversationId: string;
  senderStaffId: string;
  groupConfig?: DingtalkGroupConfig;
  dingtalkCfg?: DingtalkConfig;
}): string {
  const scope: GroupSessionScope =
    params.groupConfig?.groupSessionScope ?? params.dingtalkCfg?.groupSessionScope ?? "group";

  if (scope === "group_sender") {
    return `${params.conversationId}:sender:${params.senderStaffId}`;
  }
  return params.conversationId;
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
  const groupConfig = isGroup
    ? resolveDingtalkGroupConfig({ cfg: dingtalkCfg, groupId: ctx.conversationId })
    : undefined;

  if (isGroup) {
    if (groupConfig?.enabled === false) {
      log(`dingtalk[${account.accountId}]: group ${ctx.conversationId} is disabled`);
      return;
    }

    const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
    const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
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

    const requireMention = groupConfig?.requireMention ?? dingtalkCfg?.requireMention ?? true;
    if (requireMention && !ctx.mentionedBot) {
      log(`dingtalk[${account.accountId}]: message in group did not mention bot, skipping`);
      return;
    }
  }

  // --- DM 策略检查 / DM policy check ---
  const configAllowFrom = dingtalkCfg?.allowFrom ?? [];
  let effectiveAllowFrom = configAllowFrom;

  if (isDirect) {
    const dmPolicy = dingtalkCfg?.dmPolicy ?? "pairing";

    if (dmPolicy === "allowlist") {
      const allowed = configAllowFrom.some(
        (entry) => String(entry).trim() === ctx.senderStaffId || String(entry).trim() === "*",
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
      effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
      const allowed = effectiveAllowFrom.some(
        (entry) => String(entry).trim() === ctx.senderStaffId || String(entry).trim() === "*",
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
          log(`dingtalk[${account.accountId}]: pairing code ${code} for ${ctx.senderStaffId}`);
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
            log(`dingtalk[${account.accountId}]: failed to send pairing reply: ${err}`);
          }
        }
        return;
      }
    }
  }

  // --- Resolve command authorization ---
  const shouldComputeCommandAuthorized = core.channel.commands.shouldComputeCommandAuthorized(
    ctx.content,
    cfg,
  );
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const commandAllowFrom = isGroup
    ? (groupConfig?.allowFrom ?? configAllowFrom)
    : effectiveAllowFrom;
  const senderAllowedForCommands = commandAllowFrom.some(
    (entry) => String(entry).trim() === ctx.senderStaffId || String(entry).trim() === "*",
  );
  const commandAuthorized = shouldComputeCommandAuthorized
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;

  // --- 构建消息体并分发给 agent / Build message body and dispatch to agent ---
  const messageBody = buildMessageBody(ctx);

  const dingtalkFrom = `dingtalk:${ctx.senderStaffId}`;
  const dingtalkTo = isGroup ? `chat:${ctx.conversationId}` : `user:${ctx.senderStaffId}`;
  const peerId = isGroup
    ? resolveGroupPeerId({
        conversationId: ctx.conversationId,
        senderStaffId: ctx.senderStaffId,
        groupConfig,
        dingtalkCfg,
      })
    : ctx.senderStaffId;

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
    CommandAuthorized: commandAuthorized,
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
 * Build message body for agent dispatch.
 */
function buildMessageBody(ctx: DingtalkMessageContext): string {
  return ctx.content || `[${ctx.contentType} message]`;
}
