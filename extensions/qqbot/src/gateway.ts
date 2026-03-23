import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import WebSocket from "ws";
import { sendStartupGreetings, type AdminResolverContext } from "./admin-resolver.js";
import {
  getAccessToken,
  getGatewayUrl,
  sendC2CMessage,
  sendChannelMessage,
  sendGroupMessage,
  clearTokenCache,
  initApiConfig,
  startBackgroundTokenRefresh,
  stopBackgroundTokenRefresh,
  sendC2CInputNotify,
  onMessageSent,
  PLUGIN_USER_AGENT,
} from "./api.js";
import { processAttachments, formatVoiceText } from "./inbound-attachments.js";
import { recordKnownUser, flushKnownUsers } from "./known-users.js";
import { createMessageQueue, type QueuedMessage } from "./message-queue.js";
import {
  parseAndSendMediaTags,
  sendPlainReply,
  type DeliverEventContext,
  type DeliverAccountContext,
} from "./outbound-deliver.js";
import { sendDocument, sendMedia as sendMediaAuto, type MediaTargetContext } from "./outbound.js";
import {
  setRefIndex,
  getRefIndex,
  formatRefEntryForAgent,
  flushRefIndex,
  type RefAttachmentSummary,
} from "./ref-index-store.js";
import {
  sendWithTokenRetry,
  sendErrorToTarget,
  handleStructuredPayload,
  type ReplyContext,
  type MessageTarget,
} from "./reply-dispatcher.js";
import { getQQBotRuntime } from "./runtime.js";
import { loadSession, saveSession, clearSession } from "./session-store.js";
import {
  matchSlashCommand,
  type SlashCommandContext,
  type SlashCommandFileResult,
} from "./slash-commands.js";
import type {
  ResolvedQQBotAccount,
  WSPayload,
  C2CMessageEvent,
  GuildMessageEvent,
  GroupMessageEvent,
} from "./types.js";
import { TypingKeepAlive, TYPING_INPUT_SECOND } from "./typing-keepalive.js";
import { triggerUpdateCheck } from "./update-checker.js";
import { resolveTTSConfig } from "./utils/audio-convert.js";
import { runDiagnostics } from "./utils/platform.js";
import { parseFaceTags, parseRefIndices, buildAttachmentSummaries } from "./utils/text-parsing.js";

// QQ Bot intents - 按权限级别分组
const INTENTS = {
  // 基础权限（默认有）
  GUILDS: 1 << 0, // 频道相关
  GUILD_MEMBERS: 1 << 1, // 频道成员
  PUBLIC_GUILD_MESSAGES: 1 << 30, // 频道公开消息（公域）
  // 需要申请的权限
  DIRECT_MESSAGE: 1 << 12, // 频道私信
  GROUP_AND_C2C: 1 << 25, // 群聊和 C2C 私聊（需申请）
};

// 固定使用完整权限（群聊 + 私信 + 频道），不做降级
const FULL_INTENTS = INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C;
const FULL_INTENTS_DESC = "群聊+私信+频道";

// 重连配置
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]; // 递增延迟
const RATE_LIMIT_DELAY = 60000; // 遇到频率限制时等待 60 秒
const MAX_RECONNECT_ATTEMPTS = 100;
const MAX_QUICK_DISCONNECT_COUNT = 3; // 连续快速断开次数阈值
const QUICK_DISCONNECT_THRESHOLD = 5000; // 5秒内断开视为快速断开

export interface GatewayContext {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  cfg: OpenClawConfig;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

// 模块级变量：记录已完成首次 READY 的账号
// 区分 gateway restart（进程重启）和 health-monitor 断线重连
const seenReadyAccounts = new Set<string>();

/**
 * 启动 Gateway WebSocket 连接（带自动重连）
 * 支持流式消息发送
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log } = ctx;

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  // 启动环境诊断（首次连接时执行）
  const diag = await runDiagnostics();
  if (diag.warnings.length > 0) {
    for (const w of diag.warnings) {
      log?.info(`[qqbot:${account.accountId}] ${w}`);
    }
  }

  // 后台版本检查（供 /bot-version、/bot-upgrade 指令被动查询）
  triggerUpdateCheck(log);

  // 初始化 API 配置（markdown 支持）
  initApiConfig(account.appId, {
    markdownSupport: account.markdownSupport,
  });
  log?.info(
    `[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport === true}`,
  );

  // 注册出站消息 refIdx 缓存钩子
  // 所有消息发送函数在拿到 QQ 回包后，如果含 ref_idx 则自动回调此处缓存
  onMessageSent(account.appId, (refIdx, meta) => {
    log?.info(
      `[qqbot:${account.accountId}] onMessageSent called: refIdx=${refIdx}, mediaType=${meta.mediaType}, ttsText=${meta.ttsText?.slice(0, 30)}`,
    );
    const attachments: RefAttachmentSummary[] = [];
    if (meta.mediaType) {
      const localPath = meta.mediaLocalPath;
      // filename 取路径的 basename，如果没有路径信息则留空
      const filename = localPath ? path.basename(localPath) : undefined;
      const attachment: RefAttachmentSummary = {
        type: meta.mediaType,
        ...(localPath ? { localPath } : {}),
        ...(filename ? { filename } : {}),
        ...(meta.mediaUrl ? { url: meta.mediaUrl } : {}),
      };
      // 如果是语音消息且有 TTS 原文本，保存到 transcript 并标记来源为 tts
      if (meta.mediaType === "voice" && meta.ttsText) {
        attachment.transcript = meta.ttsText;
        attachment.transcriptSource = "tts";
        log?.info(
          `[qqbot:${account.accountId}] Saving voice transcript (TTS): ${meta.ttsText.slice(0, 50)}`,
        );
      }
      attachments.push(attachment);
    }
    setRefIndex(refIdx, {
      content: meta.text ?? "",
      senderId: account.accountId,
      senderName: account.accountId,
      timestamp: Date.now(),
      isBot: true,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    log?.info(
      `[qqbot:${account.accountId}] Cached outbound refIdx: ${refIdx}, attachments=${JSON.stringify(attachments)}`,
    );
  });

  // TTS 配置验证
  const ttsCfg = resolveTTSConfig(cfg as Record<string, unknown>);
  if (ttsCfg) {
    const maskedKey =
      ttsCfg.apiKey.length > 8
        ? `${ttsCfg.apiKey.slice(0, 4)}****${ttsCfg.apiKey.slice(-4)}`
        : "****";
    log?.info(
      `[qqbot:${account.accountId}] TTS configured: model=${ttsCfg.model}, voice=${ttsCfg.voice}, authStyle=${ttsCfg.authStyle ?? "bearer"}, baseUrl=${ttsCfg.baseUrl}`,
    );
    log?.info(
      `[qqbot:${account.accountId}] TTS apiKey: ${maskedKey}${ttsCfg.queryParams ? `, queryParams=${JSON.stringify(ttsCfg.queryParams)}` : ""}${ttsCfg.speed !== undefined ? `, speed=${ttsCfg.speed}` : ""}`,
    );
  } else {
    log?.info(
      `[qqbot:${account.accountId}] TTS not configured (voice messages will be unavailable)`,
    );
  }

  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let lastConnectTime: number = 0; // 上次连接成功的时间
  let quickDisconnectCount = 0; // 连续快速断开次数
  let isConnecting = false; // 防止并发连接
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null; // 重连定时器
  let shouldRefreshToken = false; // 下次连接是否需要刷新 token
  // 使用模块级 seenReadyAccounts，确保每个账号只在首次 READY 发送问候语
  // health-monitor 重连不会重新触发

  const adminCtx: AdminResolverContext = {
    accountId: account.accountId,
    appId: account.appId,
    clientSecret: account.clientSecret,
    log,
  };

  // ============ P1-2: 尝试从持久化存储恢复 Session ============
  // 传入当前 appId，如果 appId 已变更（换了机器人），旧 session 自动失效
  const savedSession = loadSession(account.accountId, account.appId);
  if (savedSession) {
    sessionId = savedSession.sessionId;
    lastSeq = savedSession.lastSeq;
    log?.info(
      `[qqbot:${account.accountId}] Restored session from storage: sessionId=${sessionId}, lastSeq=${lastSeq}`,
    );
  }

  // ============ 按用户并发的消息队列 ============
  const msgQueue = createMessageQueue({
    accountId: account.accountId,
    log,
    isAborted: () => isAborted,
  });

  // 斜杠指令拦截：在入队前匹配插件级指令，命中则直接回复，不入队
  // 紧急命令列表：这些命令会立即执行，不进入斜杠匹配流程
  const URGENT_COMMANDS = ["/stop"];

  const trySlashCommandOrEnqueue = async (msg: QueuedMessage): Promise<void> => {
    const content = (msg.content ?? "").trim();
    if (!content.startsWith("/")) {
      msgQueue.enqueue(msg);
      return;
    }

    // 检测是否为紧急命令 — 立即执行，清空该用户队列
    const contentLower = content.toLowerCase();
    const isUrgentCommand = URGENT_COMMANDS.some((cmd) =>
      contentLower.startsWith(cmd.toLowerCase()),
    );
    if (isUrgentCommand) {
      log?.info(
        `[qqbot:${account.accountId}] Urgent command detected: ${content.slice(0, 20)}, executing immediately`,
      );
      const peerId = msgQueue.getMessagePeerId(msg);
      const droppedCount = msgQueue.clearUserQueue(peerId);
      if (droppedCount > 0) {
        log?.info(
          `[qqbot:${account.accountId}] Dropped ${droppedCount} queued messages for ${peerId} due to urgent command`,
        );
      }
      msgQueue.executeImmediate(msg);
      return;
    }

    const receivedAt = Date.now();
    const peerId = msgQueue.getMessagePeerId(msg);

    const cmdCtx: SlashCommandContext = {
      type: msg.type,
      senderId: msg.senderId,
      senderName: msg.senderName,
      messageId: msg.messageId,
      eventTimestamp: msg.timestamp,
      receivedAt,
      rawContent: content,
      args: "",
      channelId: msg.channelId,
      groupOpenid: msg.groupOpenid,
      accountId: account.accountId,
      appId: account.appId,
      accountConfig: account.config,
      queueSnapshot: msgQueue.getSnapshot(peerId),
    };

    try {
      const reply = await matchSlashCommand(cmdCtx);
      if (reply === null) {
        // 不是插件级指令，正常入队交给框架
        msgQueue.enqueue(msg);
        return;
      }

      // 命中插件级指令，直接回复
      log?.info(
        `[qqbot:${account.accountId}] Slash command matched: ${content}, replying directly`,
      );
      const token = await getAccessToken(account.appId, account.clientSecret);

      // 解析回复：纯文本 or 带文件的结果
      const isFileResult = typeof reply === "object" && reply !== null && "filePath" in reply;
      const replyText = isFileResult ? (reply as SlashCommandFileResult).text : (reply as string);
      const replyFile = isFileResult ? (reply as SlashCommandFileResult).filePath : null;

      // 先发送文本回复
      if (msg.type === "c2c") {
        await sendC2CMessage(account.appId, token, msg.senderId, replyText, msg.messageId);
      } else if (msg.type === "group" && msg.groupOpenid) {
        await sendGroupMessage(account.appId, token, msg.groupOpenid, replyText, msg.messageId);
      } else if (msg.channelId) {
        await sendChannelMessage(token, msg.channelId, replyText, msg.messageId);
      } else if (msg.type === "dm") {
        await sendC2CMessage(account.appId, token, msg.senderId, replyText, msg.messageId);
      }

      // 如果有文件需要发送
      if (replyFile) {
        try {
          const targetType =
            msg.type === "group"
              ? "group"
              : msg.type === "c2c" || msg.type === "dm"
                ? "c2c"
                : "channel";
          const targetId =
            msg.type === "group"
              ? msg.groupOpenid || msg.senderId
              : msg.type === "c2c" || msg.type === "dm"
                ? msg.senderId
                : msg.channelId || msg.senderId;
          const mediaCtx: MediaTargetContext = {
            targetType,
            targetId,
            account,
            replyToId: msg.messageId,
            logPrefix: `[qqbot:${account.accountId}]`,
          };
          await sendDocument(mediaCtx, replyFile);
          log?.info(`[qqbot:${account.accountId}] Slash command file sent: ${replyFile}`);
        } catch (fileErr) {
          log?.error(`[qqbot:${account.accountId}] Failed to send slash command file: ${fileErr}`);
        }
      }
    } catch (err) {
      log?.error(`[qqbot:${account.accountId}] Slash command error: ${err}`);
      // 出错时回退到正常入队
      msgQueue.enqueue(msg);
    }
  };

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanup();
    // P1-1: 停止后台 Token 刷新
    stopBackgroundTokenRefresh(account.appId);
    // P1-3: 保存已知用户数据
    flushKnownUsers();
    // P1-4: 保存引用索引数据
    flushRefIndex();
  });

  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (
      currentWs &&
      (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)
    ) {
      currentWs.close();
    }
    currentWs = null;
  };

  const getReconnectDelay = () => {
    const idx = Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1);
    return RECONNECT_DELAYS[idx];
  };

  const scheduleReconnect = (customDelay?: number) => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log?.error(`[qqbot:${account.accountId}] Max reconnect attempts reached or aborted`);
      return;
    }

    // 取消已有的重连定时器
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const delay = customDelay ?? getReconnectDelay();
    reconnectAttempts++;
    log?.info(
      `[qqbot:${account.accountId}] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`,
    );

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isAborted) {
        connect();
      }
    }, delay);
  };

  const connect = async () => {
    // 防止并发连接
    if (isConnecting) {
      log?.debug?.(`[qqbot:${account.accountId}] Already connecting, skip`);
      return;
    }
    isConnecting = true;

    try {
      cleanup();

      // 如果标记了需要刷新 token，则清除缓存
      if (shouldRefreshToken) {
        log?.info(`[qqbot:${account.accountId}] Refreshing token...`);
        clearTokenCache(account.appId);
        shouldRefreshToken = false;
      }

      const accessToken = await getAccessToken(account.appId, account.clientSecret);
      log?.info(`[qqbot:${account.accountId}] ✅ Access token obtained successfully`);
      const gatewayUrl = await getGatewayUrl(accessToken);

      log?.info(`[qqbot:${account.accountId}] Connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl, { headers: { "User-Agent": PLUGIN_USER_AGENT } });
      currentWs = ws;

      const pluginRuntime = getQQBotRuntime();

      // 处理收到的消息
      const handleMessage = async (event: {
        type: "c2c" | "guild" | "dm" | "group";
        senderId: string;
        senderName?: string;
        content: string;
        messageId: string;
        timestamp: string;
        channelId?: string;
        guildId?: string;
        groupOpenid?: string;
        attachments?: Array<{
          content_type: string;
          url: string;
          filename?: string;
          voice_wav_url?: string;
          asr_refer_text?: string;
        }>;
        refMsgIdx?: string;
        msgIdx?: string;
      }) => {
        log?.debug?.(`[qqbot:${account.accountId}] Received message: ${JSON.stringify(event)}`);
        log?.info(
          `[qqbot:${account.accountId}] Processing message from ${event.senderId}: ${event.content}`,
        );
        if (event.attachments?.length) {
          log?.info(`[qqbot:${account.accountId}] Attachments: ${event.attachments.length}`);
        }

        pluginRuntime.channel.activity.record({
          channel: "qqbot",
          accountId: account.accountId,
          direction: "inbound",
        });

        // 发送输入状态提示 + 启动自动续期（仅 C2C 私聊有效）
        // refIdx 通过 Promise 延迟获取，在真正需要时再 await
        const isC2C = event.type === "c2c" || event.type === "dm";
        // 用对象包装避免 TS 控制流分析将 null 初始值窄化为 never
        const typing: { keepAlive: TypingKeepAlive | null } = { keepAlive: null };

        const inputNotifyPromise: Promise<string | undefined> = (async () => {
          if (!isC2C) return undefined;
          try {
            let token = await getAccessToken(account.appId, account.clientSecret);
            try {
              const notifyResponse = await sendC2CInputNotify(
                token,
                event.senderId,
                event.messageId,
                TYPING_INPUT_SECOND,
              );
              log?.info(
                `[qqbot:${account.accountId}] Sent input notify to ${event.senderId}${notifyResponse.refIdx ? `, got refIdx=${notifyResponse.refIdx}` : ""}`,
              );
              // 首次成功后启动定时续期
              typing.keepAlive = new TypingKeepAlive(
                () => getAccessToken(account.appId, account.clientSecret),
                () => clearTokenCache(account.appId),
                event.senderId,
                event.messageId,
                log,
                `[qqbot:${account.accountId}]`,
              );
              typing.keepAlive.start();
              return notifyResponse.refIdx;
            } catch (notifyErr) {
              const errMsg = String(notifyErr);
              if (errMsg.includes("token") || errMsg.includes("401") || errMsg.includes("11244")) {
                log?.info(`[qqbot:${account.accountId}] InputNotify token expired, refreshing...`);
                clearTokenCache(account.appId);
                token = await getAccessToken(account.appId, account.clientSecret);
                const notifyResponse = await sendC2CInputNotify(
                  token,
                  event.senderId,
                  event.messageId,
                  TYPING_INPUT_SECOND,
                );
                typing.keepAlive = new TypingKeepAlive(
                  () => getAccessToken(account.appId, account.clientSecret),
                  () => clearTokenCache(account.appId),
                  event.senderId,
                  event.messageId,
                  log,
                  `[qqbot:${account.accountId}]`,
                );
                typing.keepAlive.start();
                return notifyResponse.refIdx;
              } else {
                throw notifyErr;
              }
            }
          } catch (err) {
            log?.error(`[qqbot:${account.accountId}] sendC2CInputNotify error: ${err}`);
            return undefined;
          }
        })();

        const isGroupChat = event.type === "guild" || event.type === "group";
        // peerId 只放纯 ID，类型信息由 peer.kind 表达
        // 群聊：用 groupOpenid（框架根据 kind:"group" 区分）
        // 私聊：用 senderId（框架根据 dmScope 决定隔离粒度）
        const peerId =
          event.type === "guild"
            ? (event.channelId ?? "unknown")
            : event.type === "group"
              ? (event.groupOpenid ?? "unknown")
              : event.senderId;

        const route = pluginRuntime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "qqbot",
          accountId: account.accountId,
          peer: {
            kind: isGroupChat ? "group" : "direct",
            id: peerId,
          },
        });

        const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);

        // 组装消息体
        // 静态系统提示已移至 skills/qqbot-remind/SKILL.md 和 skills/qqbot-media/SKILL.md
        // BodyForAgent 只保留必要的动态上下文信息

        // ============ 用户标识信息 ============

        // 收集额外的系统提示（如果配置了账户级别的 systemPrompt）
        const systemPrompts: string[] = [];
        if (account.systemPrompt) {
          systemPrompts.push(account.systemPrompt);
        }

        // 处理附件（图片等）- 下载到本地供 openclaw 访问
        const processed = await processAttachments(event.attachments, {
          accountId: account.accountId,
          cfg,
          log,
        });
        const {
          attachmentInfo,
          imageUrls,
          imageMediaTypes,
          voiceAttachmentPaths,
          voiceAttachmentUrls,
          voiceAsrReferTexts,
          voiceTranscripts,
          voiceTranscriptSources,
          attachmentLocalPaths,
        } = processed;

        // 语音转录文本注入到用户消息中
        const voiceText = formatVoiceText(voiceTranscripts);
        const hasAsrReferFallback = voiceTranscriptSources.includes("asr");

        // 解析 QQ 表情标签，将 <faceType=...,ext="base64"> 替换为 【表情: 中文名】
        const parsedContent = parseFaceTags(event.content);
        const userContent = voiceText
          ? (parsedContent.trim() ? `${parsedContent}\n${voiceText}` : voiceText) + attachmentInfo
          : parsedContent + attachmentInfo;

        // ============ 引用消息处理 ============
        let replyToId: string | undefined;
        let replyToBody: string | undefined;
        let replyToSender: string | undefined;
        let replyToIsQuote = false;

        // 1. 查找被引用消息
        if (event.refMsgIdx) {
          const refEntry = getRefIndex(event.refMsgIdx);
          if (refEntry) {
            replyToId = event.refMsgIdx;
            replyToBody = formatRefEntryForAgent(refEntry);
            replyToSender = refEntry.senderName ?? refEntry.senderId;
            replyToIsQuote = true;
            log?.info(
              `[qqbot:${account.accountId}] Quote detected: refMsgIdx=${event.refMsgIdx}, sender=${replyToSender}, content="${replyToBody.slice(0, 80)}..."`,
            );
          } else {
            log?.info(
              `[qqbot:${account.accountId}] Quote detected but refMsgIdx not in cache: ${event.refMsgIdx}`,
            );
            replyToId = event.refMsgIdx;
            replyToIsQuote = true;
            // 缓存未命中时 replyToBody 为空，AI 只能知道"用户引用了一条消息"
          }
        }

        // 2. 缓存当前消息自身的 msgIdx（供将来被引用时查找）
        // 优先使用推送事件中的 msgIdx（来自 message_scene.ext），否则使用 InputNotify 返回的 refIdx
        // inputNotifyPromise 在这里才 await，此时附件下载等工作已并行完成
        const inputNotifyRefIdx = await inputNotifyPromise;
        const currentMsgIdx = event.msgIdx ?? inputNotifyRefIdx;
        if (currentMsgIdx) {
          const attSummaries = buildAttachmentSummaries(event.attachments, attachmentLocalPaths);
          // 如果有语音转录,把转录文本和来源写入对应附件摘要
          if (attSummaries && voiceTranscripts.length > 0) {
            let voiceIdx = 0;
            for (const att of attSummaries) {
              if (att.type === "voice" && voiceIdx < voiceTranscripts.length) {
                att.transcript = voiceTranscripts[voiceIdx];
                // 保存转录来源
                if (voiceIdx < voiceTranscriptSources.length) {
                  att.transcriptSource = voiceTranscriptSources[voiceIdx];
                }
                voiceIdx++;
              }
            }
          }
          setRefIndex(currentMsgIdx, {
            content: parsedContent,
            senderId: event.senderId,
            senderName: event.senderName,
            timestamp: new Date(event.timestamp).getTime(),
            attachments: attSummaries,
          });
          log?.info(
            `[qqbot:${account.accountId}] Cached msgIdx=${currentMsgIdx} for future reference (source: ${event.msgIdx ? "message_scene.ext" : "InputNotify"})`,
          );
        }

        // Body: 展示用的用户原文（Web UI 看到的）
        const body = pluginRuntime.channel.reply.formatInboundEnvelope({
          channel: "qqbot",
          from: event.senderName ?? event.senderId,
          timestamp: new Date(event.timestamp).getTime(),
          body: userContent,
          chatType: isGroupChat ? "group" : "direct",
          sender: {
            id: event.senderId,
            name: event.senderName,
          },
          envelope: envelopeOptions,
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
        });

        // BodyForAgent: AI 实际看到的完整上下文（动态数据 + 系统提示 + 用户输入）

        // 构建媒体附件纯数据描述（图片 + 语音统一列出）
        const uniqueVoicePaths = [...new Set(voiceAttachmentPaths)];
        const uniqueVoiceUrls = [...new Set(voiceAttachmentUrls)];
        const uniqueVoiceAsrReferTexts = [...new Set(voiceAsrReferTexts)].filter(Boolean);
        const sttTranscriptCount = voiceTranscriptSources.filter((s) => s === "stt").length;
        const asrFallbackCount = voiceTranscriptSources.filter((s) => s === "asr").length;
        const fallbackCount = voiceTranscriptSources.filter((s) => s === "fallback").length;
        if (
          voiceAttachmentPaths.length > 0 ||
          voiceAttachmentUrls.length > 0 ||
          uniqueVoiceAsrReferTexts.length > 0
        ) {
          const asrPreview =
            uniqueVoiceAsrReferTexts.length > 0 ? uniqueVoiceAsrReferTexts[0].slice(0, 50) : "";
          log?.info(
            `[qqbot:${account.accountId}] Voice input summary: local=${uniqueVoicePaths.length}, remote=${uniqueVoiceUrls.length}, ` +
              `asrReferTexts=${uniqueVoiceAsrReferTexts.length}, transcripts=${voiceTranscripts.length}, ` +
              `source(stt/asr/fallback)=${sttTranscriptCount}/${asrFallbackCount}/${fallbackCount}` +
              (asrPreview
                ? `, asr_preview="${asrPreview}${uniqueVoiceAsrReferTexts[0].length > 50 ? "..." : ""}"`
                : ""),
          );
        }
        // AI 看到的投递地址必须带完整前缀（qqbot:c2c: / qqbot:group:）
        const qualifiedTarget = isGroupChat
          ? `qqbot:group:${event.groupOpenid}`
          : `qqbot:c2c:${event.senderId}`;

        // 动态检测 TTS 配置状态
        const hasTTS = !!resolveTTSConfig(cfg as Record<string, unknown>);

        // 引用消息上下文
        let quotePart = "";
        if (replyToIsQuote) {
          if (replyToBody) {
            quotePart = `[引用消息开始]\n${replyToBody}\n[引用消息结束]\n`;
          } else {
            quotePart = `[引用消息开始]\n原始内容不可用\n[引用消息结束]\n`;
          }
        }

        // ============ 构建 contextInfo（静态/动态分离） ============
        // 设计原则（参考 Telegram/Discord 做法）：
        //   - 静态指引：每条消息不变的内容（场景锚定、投递地址、能力说明），
        //     注入 systemPrompts 前部，session 中虽重复出现但 AI 会自动降权，
        //     且保证长 session 窗口截断后仍可见。
        //   - 动态标签：每条消息变化的数据（时间、附件、ASR），
        //     以紧凑的 [ctx] 块标注在用户消息前，最小化 token 开销。

        // --- 静态指引（仅注入框架信封未覆盖的 QQBot 特有信息） ---
        // 框架 formatInboundEnvelope 已提供：平台标识、发送者、时间戳
        // 这里只补充 QQBot 独有的：投递地址（cron skill 需要）
        const staticParts: string[] = [`[QQBot] to=${qualifiedTarget}`];
        // TTS 能力声明：仅在启用时告知 AI 可以发语音（媒体标签用法由 qqbot-media SKILL.md 提供）
        // STT 无需声明：转写结果已在动态上下文的 ASR 行中，AI 自然可见
        if (hasTTS) staticParts.push("语音合成已启用");
        const staticInstruction = staticParts.join(" | ");

        // 静态指引作为 systemPrompts 的首项注入
        systemPrompts.unshift(staticInstruction);

        // --- 动态上下文（仅框架信封未覆盖的附件信息） ---
        const dynLines: string[] = [];
        if (imageUrls.length > 0) {
          dynLines.push(`- 图片: ${imageUrls.join(", ")}`);
        }
        if (uniqueVoicePaths.length > 0 || uniqueVoiceUrls.length > 0) {
          dynLines.push(`- 语音: ${[...uniqueVoicePaths, ...uniqueVoiceUrls].join(", ")}`);
        }
        if (uniqueVoiceAsrReferTexts.length > 0) {
          dynLines.push(`- ASR: ${uniqueVoiceAsrReferTexts.join(" | ")}`);
        }
        const dynamicCtx = dynLines.length > 0 ? dynLines.join("\n") + "\n" : "";

        // 命令直接透传，不注入上下文
        const userMessage = `${quotePart}${userContent}`;
        const agentBody = userContent.startsWith("/")
          ? userContent
          : `${systemPrompts.join("\n")}\n\n${dynamicCtx}${userMessage}`;

        log?.info(`[qqbot:${account.accountId}] agentBody length: ${agentBody.length}`);

        const fromAddress =
          event.type === "guild"
            ? `qqbot:channel:${event.channelId}`
            : event.type === "group"
              ? `qqbot:group:${event.groupOpenid}`
              : `qqbot:c2c:${event.senderId}`;
        const toAddress = fromAddress;

        // 计算命令授权状态
        // allowFrom: ["*"] 表示允许所有人，否则检查 senderId 是否在 allowFrom 列表中
        const allowFromList = account.config?.allowFrom ?? [];
        const allowAll =
          allowFromList.length === 0 || allowFromList.some((entry: string) => entry === "*");
        const commandAuthorized =
          allowAll ||
          allowFromList.some(
            (entry: string) => entry.toUpperCase() === event.senderId.toUpperCase(),
          );

        // 分离 imageUrls 为本地路径和远程 URL，供 openclaw 原生媒体处理
        const localMediaPaths: string[] = [];
        const localMediaTypes: string[] = [];
        const remoteMediaUrls: string[] = [];
        const remoteMediaTypes: string[] = [];
        for (let i = 0; i < imageUrls.length; i++) {
          const u = imageUrls[i];
          const t = imageMediaTypes[i] ?? "image/png";
          if (u.startsWith("http://") || u.startsWith("https://")) {
            remoteMediaUrls.push(u);
            remoteMediaTypes.push(t);
          } else {
            localMediaPaths.push(u);
            localMediaTypes.push(t);
          }
        }

        const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
          Body: body,
          BodyForAgent: agentBody,
          RawBody: event.content,
          CommandBody: event.content,
          From: fromAddress,
          To: toAddress,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: isGroupChat ? "group" : "direct",
          SenderId: event.senderId,
          SenderName: event.senderName,
          Provider: "qqbot",
          Surface: "qqbot",
          MessageSid: event.messageId,
          Timestamp: new Date(event.timestamp).getTime(),
          OriginatingChannel: "qqbot",
          OriginatingTo: toAddress,
          QQChannelId: event.channelId,
          QQGuildId: event.guildId,
          QQGroupOpenid: event.groupOpenid,
          QQVoiceAsrReferAvailable: hasAsrReferFallback,
          QQVoiceTranscriptSources: voiceTranscriptSources,
          QQVoiceAttachmentPaths: uniqueVoicePaths,
          QQVoiceAttachmentUrls: uniqueVoiceUrls,
          QQVoiceAsrReferTexts: uniqueVoiceAsrReferTexts,
          QQVoiceInputStrategy: "prefer_audio_stt_then_asr_fallback",
          CommandAuthorized: commandAuthorized,
          // 传递媒体路径和 URL，使 openclaw 原生媒体处理（视觉等）能正常工作
          ...(localMediaPaths.length > 0
            ? {
                MediaPaths: localMediaPaths,
                MediaPath: localMediaPaths[0],
                MediaTypes: localMediaTypes,
                MediaType: localMediaTypes[0],
              }
            : {}),
          ...(remoteMediaUrls.length > 0
            ? {
                MediaUrls: remoteMediaUrls,
                MediaUrl: remoteMediaUrls[0],
              }
            : {}),
          // 引用消息上下文（对齐 Telegram/Discord 的 ReplyTo 字段）
          ...(replyToId
            ? {
                ReplyToId: replyToId,
                ReplyToBody: replyToBody,
                ReplyToSender: replyToSender,
                ReplyToIsQuote: replyToIsQuote,
              }
            : {}),
        });

        // 构建回复上下文
        const replyTarget: MessageTarget = {
          type: event.type,
          senderId: event.senderId,
          messageId: event.messageId,
          channelId: event.channelId,
          groupOpenid: event.groupOpenid,
        };
        const replyCtx: ReplyContext = { target: replyTarget, account, cfg, log };

        // 简化的 token 重试包装（使用 reply-dispatcher 的通用实现）
        const sendWithRetry = <T>(sendFn: (token: string) => Promise<T>) =>
          sendWithTokenRetry(account.appId, account.clientSecret, sendFn, log, account.accountId);

        // 发送错误提示的辅助函数
        const sendErrorMessage = (errorText: string) => sendErrorToTarget(replyCtx, errorText);

        try {
          const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(
            cfg,
            route.agentId,
          );

          // 追踪是否有响应
          let hasResponse = false;
          let hasBlockResponse = false; // 是否收到了面向用户的 block 回复
          let toolDeliverCount = 0; // tool deliver 计数
          const toolTexts: string[] = []; // 收集所有 tool deliver 文本
          const toolMediaUrls: string[] = []; // 收集所有 tool deliver 媒体 URL
          let toolFallbackSent = false; // 兜底消息是否已发送（只发一次）
          const responseTimeout = 120000; // 120秒超时（2分钟，与 TTS/文件生成超时对齐）
          const toolOnlyTimeout = 60000; // tool-only 兜底超时：60秒内没有 block 就兜底
          const maxToolRenewals = 3; // tool 续期上限：最多续期 3 次（总等待 = 60s × 3 = 180s）
          let toolRenewalCount = 0; // 已续期次数
          let timeoutId: ReturnType<typeof setTimeout> | null = null;
          let toolOnlyTimeoutId: ReturnType<typeof setTimeout> | null = null;

          // tool-only 兜底：转发工具产生的实际内容（媒体/文本），而非生硬的提示语
          const sendToolFallback = async (): Promise<void> => {
            // 优先发送工具产出的媒体文件（TTS 语音、生成图片等）
            if (toolMediaUrls.length > 0) {
              log?.info(
                `[qqbot:${account.accountId}] Tool fallback: forwarding ${toolMediaUrls.length} media URL(s) from tool deliver(s)`,
              );
              const mediaTimeout = 45000; // 单个媒体发送超时 45s
              for (const mediaUrl of toolMediaUrls) {
                try {
                  const result = await Promise.race([
                    sendMediaAuto({
                      to: qualifiedTarget,
                      text: "",
                      mediaUrl,
                      accountId: account.accountId,
                      replyToId: event.messageId,
                      account,
                    }),
                    new Promise<{ channel: string; error: string }>((resolve) =>
                      setTimeout(
                        () =>
                          resolve({
                            channel: "qqbot",
                            error: `Tool fallback media send timeout (${mediaTimeout / 1000}s)`,
                          }),
                        mediaTimeout,
                      ),
                    ),
                  ]);
                  if (result.error) {
                    log?.error(
                      `[qqbot:${account.accountId}] Tool fallback sendMedia error: ${result.error}`,
                    );
                  }
                } catch (err) {
                  log?.error(`[qqbot:${account.accountId}] Tool fallback sendMedia failed: ${err}`);
                }
              }
              return;
            }
            // 其次转发工具产出的文本
            if (toolTexts.length > 0) {
              const text = toolTexts.slice(-3).join("\n---\n").slice(0, 2000);
              log?.info(
                `[qqbot:${account.accountId}] Tool fallback: forwarding tool text (${text.length} chars)`,
              );
              await sendErrorMessage(text);
              return;
            }
            // 既无媒体也无文本，静默处理（仅日志记录）
            log?.info(
              `[qqbot:${account.accountId}] Tool fallback: no media or text collected from ${toolDeliverCount} tool deliver(s), silently dropping`,
            );
          };

          const timeoutPromise = new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => {
              if (!hasResponse) {
                reject(new Error("Response timeout"));
              }
            }, responseTimeout);
          });

          const dispatchPromise =
            pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: ctxPayload,
              cfg,
              dispatcherOptions: {
                responsePrefix: messagesConfig.responsePrefix,
                deliver: async (
                  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
                  info: { kind: string },
                ) => {
                  hasResponse = true;

                  log?.info(
                    `[qqbot:${account.accountId}] deliver called, kind: ${info.kind}, payload keys: ${Object.keys(payload).join(", ")}`,
                  );

                  // ============ 跳过工具调用的中间结果（带兜底保护） ============
                  if (info.kind === "tool") {
                    toolDeliverCount++;
                    const toolText = (payload.text ?? "").trim();
                    if (toolText) {
                      toolTexts.push(toolText);
                    }
                    // 收集工具产出的媒体 URL（TTS 语音、生成图片等），供 fallback 转发
                    if (payload.mediaUrls?.length) {
                      toolMediaUrls.push(...payload.mediaUrls);
                    }
                    if (payload.mediaUrl && !toolMediaUrls.includes(payload.mediaUrl)) {
                      toolMediaUrls.push(payload.mediaUrl);
                    }
                    log?.info(
                      `[qqbot:${account.accountId}] Collected tool deliver #${toolDeliverCount}: text=${toolText.length} chars, media=${toolMediaUrls.length} URLs`,
                    );

                    // block 已先发送完毕，tool 后到的媒体立即转发（典型场景：AI 先流式输出文本再执行 TTS）
                    if (hasBlockResponse && toolMediaUrls.length > 0) {
                      log?.info(
                        `[qqbot:${account.accountId}] Block already sent, immediately forwarding ${toolMediaUrls.length} tool media URL(s)`,
                      );
                      const urlsToSend = [...toolMediaUrls];
                      toolMediaUrls.length = 0;
                      for (const mediaUrl of urlsToSend) {
                        try {
                          const result = await sendMediaAuto({
                            to: qualifiedTarget,
                            text: "",
                            mediaUrl,
                            accountId: account.accountId,
                            replyToId: event.messageId,
                            account,
                          });
                          if (result.error) {
                            log?.error(
                              `[qqbot:${account.accountId}] Tool media immediate forward error: ${result.error}`,
                            );
                          } else {
                            log?.info(
                              `[qqbot:${account.accountId}] Forwarded tool media (post-block): ${mediaUrl.slice(0, 80)}...`,
                            );
                          }
                        } catch (err) {
                          log?.error(
                            `[qqbot:${account.accountId}] Tool media immediate forward failed: ${err}`,
                          );
                        }
                      }
                      return;
                    }

                    // 兜底已发送，不再续期
                    if (toolFallbackSent) {
                      return;
                    }

                    // tool-only 超时保护：收到 tool 但迟迟没有 block 时，启动兜底定时器
                    // 续期有上限（maxToolRenewals 次），防止无限工具调用永远不触发兜底
                    if (toolOnlyTimeoutId) {
                      if (toolRenewalCount < maxToolRenewals) {
                        clearTimeout(toolOnlyTimeoutId);
                        toolRenewalCount++;
                        log?.info(
                          `[qqbot:${account.accountId}] Tool-only timer renewed (${toolRenewalCount}/${maxToolRenewals})`,
                        );
                      } else {
                        // 已达续期上限，不再重置，等定时器自然触发兜底
                        log?.info(
                          `[qqbot:${account.accountId}] Tool-only timer renewal limit reached (${maxToolRenewals}), waiting for timeout`,
                        );
                        return;
                      }
                    }
                    toolOnlyTimeoutId = setTimeout(async () => {
                      if (!hasBlockResponse && !toolFallbackSent) {
                        toolFallbackSent = true;
                        log?.error(
                          `[qqbot:${account.accountId}] Tool-only timeout: ${toolDeliverCount} tool deliver(s) but no block within ${toolOnlyTimeout / 1000}s, sending fallback`,
                        );
                        try {
                          await sendToolFallback();
                        } catch (sendErr) {
                          log?.error(
                            `[qqbot:${account.accountId}] Failed to send tool-only fallback: ${sendErr}`,
                          );
                        }
                      }
                    }, toolOnlyTimeout);
                    return;
                  }

                  // 收到 block 回复，清除所有超时定时器
                  hasBlockResponse = true;
                  // 收到真正回复，立即停止输入状态续期（让 "输入中" 尽快消失）
                  typing.keepAlive?.stop();
                  if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                  }
                  if (toolOnlyTimeoutId) {
                    clearTimeout(toolOnlyTimeoutId);
                    toolOnlyTimeoutId = null;
                  }
                  if (toolDeliverCount > 0) {
                    log?.info(
                      `[qqbot:${account.accountId}] Block deliver after ${toolDeliverCount} tool deliver(s)`,
                    );
                  }

                  // ============ 引用回复 ============
                  const quoteRef = event.msgIdx;
                  let quoteRefUsed = false;
                  const consumeQuoteRef = (): string | undefined => {
                    if (quoteRef && !quoteRefUsed) {
                      quoteRefUsed = true;
                      return quoteRef;
                    }
                    return undefined;
                  };

                  let replyText = payload.text ?? "";

                  // ============ 媒体标签解析 + 发送 ============
                  const deliverEvent: DeliverEventContext = {
                    type: event.type,
                    senderId: event.senderId,
                    messageId: event.messageId,
                    channelId: event.channelId,
                    groupOpenid: event.groupOpenid,
                    msgIdx: event.msgIdx,
                  };
                  const deliverActx: DeliverAccountContext = { account, qualifiedTarget, log };

                  const mediaResult = await parseAndSendMediaTags(
                    replyText,
                    deliverEvent,
                    deliverActx,
                    sendWithRetry,
                    consumeQuoteRef,
                  );
                  if (mediaResult.handled) {
                    pluginRuntime.channel.activity.record({
                      channel: "qqbot",
                      accountId: account.accountId,
                      direction: "outbound",
                    });
                    return;
                  }
                  replyText = mediaResult.normalizedText;

                  // ============ 结构化载荷检测与分发 ============
                  const recordOutboundActivity = () =>
                    pluginRuntime.channel.activity.record({
                      channel: "qqbot",
                      accountId: account.accountId,
                      direction: "outbound",
                    });
                  const handled = await handleStructuredPayload(
                    replyCtx,
                    replyText,
                    recordOutboundActivity,
                  );
                  if (handled) return;

                  // ============ 非结构化消息发送 ============
                  await sendPlainReply(
                    payload,
                    replyText,
                    deliverEvent,
                    deliverActx,
                    sendWithRetry,
                    consumeQuoteRef,
                    toolMediaUrls,
                  );

                  pluginRuntime.channel.activity.record({
                    channel: "qqbot",
                    accountId: account.accountId,
                    direction: "outbound",
                  });
                },
                onError: async (err: unknown) => {
                  log?.error(`[qqbot:${account.accountId}] Dispatch error: ${err}`);
                  hasResponse = true;
                  if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                  }

                  // 发送错误提示给用户，显示完整错误信息
                  const errMsg = String(err);
                  if (errMsg.includes("401") || errMsg.includes("key") || errMsg.includes("auth")) {
                    log?.error(`[qqbot:${account.accountId}] AI auth error: ${errMsg}`);
                  } else {
                    log?.error(`[qqbot:${account.accountId}] AI process error: ${errMsg}`);
                  }
                },
              },
              replyOptions: {
                disableBlockStreaming: true,
              },
            });

          // 等待分发完成或超时
          try {
            await Promise.race([dispatchPromise, timeoutPromise]);
          } catch (err) {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            if (!hasResponse) {
              log?.error(`[qqbot:${account.accountId}] No response within timeout`);
            }
          } finally {
            // 清理 tool-only 兜底定时器
            if (toolOnlyTimeoutId) {
              clearTimeout(toolOnlyTimeoutId);
              toolOnlyTimeoutId = null;
            }
            // dispatch 完成后，如果只有 tool 没有 block，且尚未发过兜底，立即兜底
            if (toolDeliverCount > 0 && !hasBlockResponse && !toolFallbackSent) {
              toolFallbackSent = true;
              log?.error(
                `[qqbot:${account.accountId}] Dispatch completed with ${toolDeliverCount} tool deliver(s) but no block deliver, sending fallback`,
              );
              await sendToolFallback();
            }
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message processing failed: ${err}`);
        } finally {
          // 无论成功/失败/超时，都停止输入状态续期
          typing.keepAlive?.stop();
        }
      };

      ws.on("open", () => {
        log?.info(`[qqbot:${account.accountId}] WebSocket connected`);
        isConnecting = false; // 连接完成，释放锁
        reconnectAttempts = 0; // 连接成功，重置重试计数
        lastConnectTime = Date.now(); // 记录连接时间
        // 启动消息处理器（异步处理，防止阻塞心跳）
        msgQueue.startProcessor(handleMessage);
        // P1-1: 启动后台 Token 刷新
        startBackgroundTokenRefresh(account.appId, account.clientSecret, {
          log: log as {
            info: (msg: string) => void;
            error: (msg: string) => void;
            debug?: (msg: string) => void;
          },
        });
      });

      ws.on("message", async (data) => {
        try {
          const rawData = data.toString();
          const payload = JSON.parse(rawData) as WSPayload;
          const { op, d, s, t } = payload;

          if (s) {
            lastSeq = s;
            // P1-2: 更新持久化存储中的 lastSeq（节流保存）
            if (sessionId) {
              saveSession({
                sessionId,
                lastSeq,
                lastConnectedAt: lastConnectTime,
                intentLevelIndex: 0,
                accountId: account.accountId,
                savedAt: Date.now(),
                appId: account.appId,
              });
            }
          }

          log?.debug?.(`[qqbot:${account.accountId}] Received op=${op} t=${t}`);

          switch (op) {
            case 10: // Hello
              log?.info(`[qqbot:${account.accountId}] Hello received`);

              // 如果有 session_id，尝试 Resume
              if (sessionId && lastSeq !== null) {
                log?.info(`[qqbot:${account.accountId}] Attempting to resume session ${sessionId}`);
                ws.send(
                  JSON.stringify({
                    op: 6, // Resume
                    d: {
                      token: `QQBot ${accessToken}`,
                      session_id: sessionId,
                      seq: lastSeq,
                    },
                  }),
                );
              } else {
                // 新连接，发送 Identify，始终使用完整权限
                log?.info(
                  `[qqbot:${account.accountId}] Sending identify with intents: ${FULL_INTENTS} (${FULL_INTENTS_DESC})`,
                );
                ws.send(
                  JSON.stringify({
                    op: 2,
                    d: {
                      token: `QQBot ${accessToken}`,
                      intents: FULL_INTENTS,
                      shard: [0, 1],
                    },
                  }),
                );
              }

              // 启动心跳
              const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
              if (heartbeatInterval) clearInterval(heartbeatInterval);
              heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ op: 1, d: lastSeq }));
                  log?.debug?.(`[qqbot:${account.accountId}] Heartbeat sent`);
                }
              }, interval);
              break;

            case 0: // Dispatch
              log?.info(
                `[qqbot:${account.accountId}] 📩 Dispatch event: t=${t}, d=${JSON.stringify(d)}`,
              );
              if (t === "READY") {
                const readyData = d as { session_id: string };
                sessionId = readyData.session_id;
                log?.info(
                  `[qqbot:${account.accountId}] Ready with ${FULL_INTENTS_DESC}, session: ${sessionId}`,
                );
                // P1-2: 保存新的 Session 状态
                saveSession({
                  sessionId,
                  lastSeq,
                  lastConnectedAt: Date.now(),
                  intentLevelIndex: 0,
                  accountId: account.accountId,
                  savedAt: Date.now(),
                  appId: account.appId,
                });
                onReady?.(d);

                // 仅 startGateway 后的首次 READY 才发送上线通知
                // ws 断线重连（resume 失败后重新 Identify）产生的 READY 不发送
                if (seenReadyAccounts.has(account.accountId)) {
                  log?.info(
                    `[qqbot:${account.accountId}] Skipping startup greeting (reconnect READY, not first startup)`,
                  );
                } else {
                  seenReadyAccounts.add(account.accountId);
                  sendStartupGreetings(adminCtx, "READY");
                } // end isFirstReady
              } else if (t === "RESUMED") {
                log?.info(`[qqbot:${account.accountId}] Session resumed`);
                onReady?.(d); // 通知框架连接已恢复，避免 health-monitor 误判 disconnected
                // RESUMED 也属于首次启动（gateway restart 通常走 resume）
                if (!seenReadyAccounts.has(account.accountId)) {
                  seenReadyAccounts.add(account.accountId);
                  sendStartupGreetings(adminCtx, "RESUMED");
                }
                // P1-2: 更新 Session 连接时间
                if (sessionId) {
                  saveSession({
                    sessionId,
                    lastSeq,
                    lastConnectedAt: Date.now(),
                    intentLevelIndex: 0,
                    accountId: account.accountId,
                    savedAt: Date.now(),
                    appId: account.appId,
                  });
                }
              } else if (t === "C2C_MESSAGE_CREATE") {
                const event = d as C2CMessageEvent;
                // P1-3: 记录已知用户
                recordKnownUser({
                  openid: event.author.user_openid,
                  type: "c2c",
                  accountId: account.accountId,
                });
                // 解析引用索引
                const c2cRefs = parseRefIndices(event.message_scene?.ext);
                // 斜杠指令拦截 → 不匹配则入队
                trySlashCommandOrEnqueue({
                  type: "c2c",
                  senderId: event.author.user_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  attachments: event.attachments,
                  refMsgIdx: c2cRefs.refMsgIdx,
                  msgIdx: c2cRefs.msgIdx,
                });
              } else if (t === "AT_MESSAGE_CREATE") {
                const event = d as GuildMessageEvent;
                // P1-3: 记录已知用户（频道用户）
                recordKnownUser({
                  openid: event.author.id,
                  type: "c2c", // 频道用户按 c2c 类型存储
                  nickname: event.author.username,
                  accountId: account.accountId,
                });
                const guildRefs = parseRefIndices((event as any).message_scene?.ext);
                trySlashCommandOrEnqueue({
                  type: "guild",
                  senderId: event.author.id,
                  senderName: event.author.username,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  channelId: event.channel_id,
                  guildId: event.guild_id,
                  attachments: event.attachments,
                  refMsgIdx: guildRefs.refMsgIdx,
                  msgIdx: guildRefs.msgIdx,
                });
              } else if (t === "DIRECT_MESSAGE_CREATE") {
                const event = d as GuildMessageEvent;
                // P1-3: 记录已知用户（频道私信用户）
                recordKnownUser({
                  openid: event.author.id,
                  type: "c2c",
                  nickname: event.author.username,
                  accountId: account.accountId,
                });
                const dmRefs = parseRefIndices((event as any).message_scene?.ext);
                trySlashCommandOrEnqueue({
                  type: "dm",
                  senderId: event.author.id,
                  senderName: event.author.username,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  guildId: event.guild_id,
                  attachments: event.attachments,
                  refMsgIdx: dmRefs.refMsgIdx,
                  msgIdx: dmRefs.msgIdx,
                });
              } else if (t === "GROUP_AT_MESSAGE_CREATE") {
                const event = d as GroupMessageEvent;
                // P1-3: 记录已知用户（群组用户）
                recordKnownUser({
                  openid: event.author.member_openid,
                  type: "group",
                  groupOpenid: event.group_openid,
                  accountId: account.accountId,
                });
                const groupRefs = parseRefIndices(event.message_scene?.ext);
                trySlashCommandOrEnqueue({
                  type: "group",
                  senderId: event.author.member_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  groupOpenid: event.group_openid,
                  attachments: event.attachments,
                  refMsgIdx: groupRefs.refMsgIdx,
                  msgIdx: groupRefs.msgIdx,
                });
              }
              break;

            case 11: // Heartbeat ACK
              log?.debug?.(`[qqbot:${account.accountId}] Heartbeat ACK`);
              break;

            case 7: // Reconnect
              log?.info(`[qqbot:${account.accountId}] Server requested reconnect`);
              cleanup();
              scheduleReconnect();
              break;

            case 9: // Invalid Session
              const canResume = d as boolean;
              log?.error(
                `[qqbot:${account.accountId}] Invalid session (${FULL_INTENTS_DESC}), can resume: ${canResume}, raw: ${rawData}`,
              );

              if (!canResume) {
                sessionId = null;
                lastSeq = null;
                // P1-2: 清除持久化的 Session
                clearSession(account.accountId);
                shouldRefreshToken = true;
                log?.info(
                  `[qqbot:${account.accountId}] Will refresh token and retry with full intents (${FULL_INTENTS_DESC})`,
                );
              }
              cleanup();
              // Invalid Session 后等待一段时间再重连
              scheduleReconnect(3000);
              break;
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message parse error: ${err}`);
        }
      });

      ws.on("close", (code, reason) => {
        log?.info(`[qqbot:${account.accountId}] WebSocket closed: ${code} ${reason.toString()}`);
        isConnecting = false; // 释放锁

        // 根据错误码处理（参考 QQ 官方文档）
        // 4004: CODE_INVALID_TOKEN - Token 无效，需刷新 token 重新连接
        // 4006: CODE_SESSION_NO_LONGER_VALID - 会话失效，需重新 identify
        // 4007: CODE_INVALID_SEQ - Resume 时 seq 无效，需重新 identify
        // 4008: CODE_RATE_LIMITED - 限流断开，等待后重连
        // 4009: CODE_SESSION_TIMED_OUT - 会话超时，需重新 identify
        // 4900-4913: 内部错误，需要重新 identify
        // 4914: 机器人已下架
        // 4915: 机器人已封禁
        if (code === 4914 || code === 4915) {
          log?.error(
            `[qqbot:${account.accountId}] Bot is ${code === 4914 ? "offline/sandbox-only" : "banned"}. Please contact QQ platform.`,
          );
          cleanup();
          // 不重连，直接退出
          return;
        }

        // 4004: Token 无效，强制刷新 token 后重连
        if (code === 4004) {
          log?.info(
            `[qqbot:${account.accountId}] Invalid token (4004), will refresh token and reconnect`,
          );
          shouldRefreshToken = true;
          cleanup();
          if (!isAborted) {
            scheduleReconnect();
          }
          return;
        }

        // 4008: 限流断开，等待后重连（不需要重新 identify）
        if (code === 4008) {
          log?.info(
            `[qqbot:${account.accountId}] Rate limited (4008), waiting ${RATE_LIMIT_DELAY}ms before reconnect`,
          );
          cleanup();
          if (!isAborted) {
            scheduleReconnect(RATE_LIMIT_DELAY);
          }
          return;
        }

        // 4006/4007/4009: 会话失效或超时，需要清除 session 重新 identify
        if (code === 4006 || code === 4007 || code === 4009) {
          const codeDesc: Record<number, string> = {
            4006: "session no longer valid",
            4007: "invalid seq on resume",
            4009: "session timed out",
          };
          log?.info(
            `[qqbot:${account.accountId}] Error ${code} (${codeDesc[code]}), will re-identify`,
          );
          sessionId = null;
          lastSeq = null;
          // 清除持久化的 Session
          clearSession(account.accountId);
          shouldRefreshToken = true;
        } else if (code >= 4900 && code <= 4913) {
          // 4900-4913 内部错误，清除 session 重新 identify
          log?.info(`[qqbot:${account.accountId}] Internal error (${code}), will re-identify`);
          sessionId = null;
          lastSeq = null;
          // 清除持久化的 Session
          clearSession(account.accountId);
          shouldRefreshToken = true;
        }

        // 检测是否是快速断开（连接后很快就断了）
        const connectionDuration = Date.now() - lastConnectTime;
        if (connectionDuration < QUICK_DISCONNECT_THRESHOLD && lastConnectTime > 0) {
          quickDisconnectCount++;
          log?.info(
            `[qqbot:${account.accountId}] Quick disconnect detected (${connectionDuration}ms), count: ${quickDisconnectCount}`,
          );

          // 如果连续快速断开超过阈值，等待更长时间
          if (quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
            log?.error(
              `[qqbot:${account.accountId}] Too many quick disconnects. This may indicate a permission issue.`,
            );
            log?.error(
              `[qqbot:${account.accountId}] Please check: 1) AppID/Secret correct 2) Bot permissions on QQ Open Platform`,
            );
            quickDisconnectCount = 0;
            cleanup();
            // 快速断开太多次，等待更长时间再重连
            if (!isAborted && code !== 1000) {
              scheduleReconnect(RATE_LIMIT_DELAY);
            }
            return;
          }
        } else {
          // 连接持续时间够长，重置计数
          quickDisconnectCount = 0;
        }

        cleanup();

        // 非正常关闭则重连
        if (!isAborted && code !== 1000) {
          scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        log?.error(`[qqbot:${account.accountId}] WebSocket error: ${err.message}`);
        onError?.(err);
      });
    } catch (err) {
      isConnecting = false; // 释放锁
      const errMsg = String(err);
      log?.error(`[qqbot:${account.accountId}] Connection failed: ${err}`);

      // 如果是频率限制错误，等待更长时间
      if (errMsg.includes("Too many requests") || errMsg.includes("100001")) {
        log?.info(
          `[qqbot:${account.accountId}] Rate limited, waiting ${RATE_LIMIT_DELAY}ms before retry`,
        );
        scheduleReconnect(RATE_LIMIT_DELAY);
      } else {
        scheduleReconnect();
      }
    }
  };

  // 开始连接
  await connect();

  // 等待 abort 信号
  return new Promise((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
