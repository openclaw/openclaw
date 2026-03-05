import axios from "axios";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/dingtalk";
import {
  buildAgentMediaPayload,
  createScopedPairingAccess,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/dingtalk";
import { resolveDingtalkAccount } from "./accounts.js";
import { downloadMessageFile } from "./media.js";
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
  DingtalkPictureContent,
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
  let downloadCodes: string[] | undefined;

  if (contentType === "text") {
    content = (msg.text?.content ?? "").trim();
  } else {
    const parsed = resolveNonTextContent(msg.content);
    content = buildNonTextContent(contentType, parsed);
    downloadCodes = extractDownloadCodes(contentType, parsed);
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
    downloadCodes,
  };
}

/**
 * Extract all downloadCode / pictureDownloadCode values from parsed non-text content.
 */
function extractDownloadCodes(
  msgtype: string,
  parsed: DingtalkNonTextContent | undefined,
): string[] | undefined {
  if (!parsed) return undefined;
  const codes: string[] = [];

  switch (msgtype) {
    case "picture": {
      const pic = parsed as DingtalkPictureContent;
      if (pic.downloadCode) codes.push(pic.downloadCode);
      else if (pic.pictureDownloadCode) codes.push(pic.pictureDownloadCode);
      break;
    }
    case "audio":
    case "video":
    case "file": {
      const media = parsed as { downloadCode?: string };
      if (media.downloadCode) codes.push(media.downloadCode);
      break;
    }
    case "richText": {
      const rich = parsed as DingtalkRichTextContent;
      if (rich.richText) {
        for (const seg of rich.richText) {
          if (seg.downloadCode) codes.push(seg.downloadCode);
          else if (seg.pictureDownloadCode) codes.push(seg.pictureDownloadCode);
        }
      }
      break;
    }
  }

  return codes.length > 0 ? codes : undefined;
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
    `dingtalk[${account.accountId}]: received ${isDirect ? "DM" : "group"} message from ${ctx.senderStaffId} (${ctx.senderNick}), msgtype=${msg.msgtype}`,
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

  // --- Download media for non-text messages ---
  const mediaPayload = await resolveDingtalkMedia({ account, ctx, log });

  // --- Build message body and dispatch to agent ---
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
    ...mediaPayload,
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
 * Download media files from DingTalk and save them for agent consumption.
 * Uses the /v1.0/robot/messageFiles/download API to get a temporary download URL,
 * then fetches the binary and saves via core.channel.media.saveMediaBuffer.
 */
async function resolveDingtalkMedia(params: {
  account: ResolvedDingtalkAccount;
  ctx: DingtalkMessageContext;
  log: (msg: string) => void;
}): Promise<ReturnType<typeof buildAgentMediaPayload>> {
  const { account, ctx, log } = params;
  const codes = ctx.downloadCodes;
  if (!codes || codes.length === 0) return buildAgentMediaPayload([]);

  log(
    `dingtalk[${account.accountId}]: resolving ${codes.length} media download code(s), msgtype=${ctx.contentType}`,
  );

  const core = getDingtalkRuntime();
  const mediaMaxMb = account.config?.mediaMaxMb ?? 30;
  const mediaMaxBytes = mediaMaxMb * 1024 * 1024;
  const savedMedia: Array<{ path: string; contentType?: string | null }> = [];

  for (const code of codes) {
    try {
      const { downloadUrl } = await downloadMessageFile({
        account,
        downloadCode: code,
        robotCode: ctx.robotCode,
      });

      if (!downloadUrl) {
        log(`dingtalk[${account.accountId}]: empty download URL, skipping`);
        continue;
      }

      const dlRes = await axios.get(downloadUrl, {
        responseType: "arraybuffer",
        maxContentLength: mediaMaxBytes,
        timeout: 30_000,
      });

      const buffer = Buffer.from(dlRes.data);
      const ct = dlRes.headers["content-type"];
      let contentType = typeof ct === "string" ? ct.split(";")[0].trim() : undefined;

      if (!contentType) {
        contentType = await core.media.detectMime({ buffer });
      }

      const saved = await core.channel.media.saveMediaBuffer(
        buffer,
        contentType,
        "inbound",
        mediaMaxBytes,
      );

      savedMedia.push({ path: saved.path, contentType: saved.contentType });
      log(`dingtalk[${account.accountId}]: saved media to ${saved.path}`);
    } catch (err) {
      log(`dingtalk[${account.accountId}]: failed to download media: ${err}`);
    }
  }

  return buildAgentMediaPayload(savedMedia);
}

/**
 * Build message body for agent dispatch.
 */
function buildMessageBody(ctx: DingtalkMessageContext): string {
  return ctx.content || `[${ctx.contentType} message]`;
}
