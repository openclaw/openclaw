/**
 * DingTalk message processing
 *
 * Implements message parsing, policy checking, and agent dispatch
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalTaskQueue, type AsyncTask } from "./async-task-queue.js";
import { handleCalendarCommand } from "./calendar-commands.js";
import { createAICard, streamAICard, finishAICard, type AICardInstance } from "./card.js";
import { getAccessToken } from "./client.js";
import type { DingtalkConfig } from "./config.js";
import { getUserInfoByStaffId } from "./contact-management.js";
import { handleDocCommand } from "./doc-commands.js";
import { handleGroupCommand } from "./group-commands.js";
import { JarvisCard, registerActiveCard } from "./jarvis-card.js";
import { handleJarvisCommand } from "./jarvis-commands.js";
import { JarvisPersona } from "./jarvis-persona.js";
import {
  sendMediaDingtalk,
  extractFileFromMessage,
  downloadDingTalkFile,
  parseRichTextMessage,
  downloadRichTextImages,
  cleanupFile,
  type DownloadedFile,
  type ExtractedFileInfo,
  type MediaMsgType,
} from "./media.js";
import { MultiTaskCardManager } from "./multi-task-card.js";
import { MultiTaskParser } from "./multi-task-parser.js";
import { getDingtalkRuntime, isDingtalkRuntimeInitialized } from "./runtime.js";
import { sendMessageDingtalk } from "./send.js";
import {
  createLogger,
  type Logger,
  checkDmPolicy,
  checkGroupPolicy,
  resolveFileCategory,
  extractMediaFromText,
  normalizeLocalPath,
  isImagePath,
} from "./shared/index.js";
import { TaskClassifier } from "./task-classifier.js";
import { getGlobalContextManager } from "./task-context-manager.js";
import { TaskNotifier } from "./task-notifier.js";
import { handleTodoCommand } from "./todo-commands.js";
import type { DingtalkRawMessage, DingtalkMessageContext, DingtalkMediaContent } from "./types.js";

// In-process TTL cache for staffId → unionId lookups to avoid redundant API calls.
// Entries expire after 10 minutes; the Map is bounded by unique active senders.
const STAFF_ID_CACHE_TTL_MS = 10 * 60 * 1000;
const staffIdToUnionIdCache = new Map<string, { unionId: string; expiresAt: number }>();

function getCachedUnionId(staffId: string): string | undefined {
  const entry = staffIdToUnionIdCache.get(staffId);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    staffIdToUnionIdCache.delete(staffId);
    return undefined;
  }
  return entry.unionId;
}

function setCachedUnionId(staffId: string, unionId: string): void {
  staffIdToUnionIdCache.set(staffId, { unionId, expiresAt: Date.now() + STAFF_ID_CACHE_TTL_MS });
}

/**
 * Extract local media paths (images/files) from text without modifying original text
 */
function extractLocalMediaFromText(params: { text: string; logger?: Logger }): {
  mediaUrls: string[];
} {
  const { text, logger } = params;

  const result = extractMediaFromText(text, {
    removeFromText: false,
    checkExists: true,
    existsSync: (p: string) => {
      const exists = fs.existsSync(p);
      if (!exists) {
        logger?.warn?.(`[stream] local media not found: ${p}`);
      }
      return exists;
    },
    parseMediaLines: false,
    parseMarkdownImages: true,
    parseHtmlImages: false, // DingTalk doesn't support HTML
    parseBarePaths: true,
    parseMarkdownLinks: true,
  });

  const mediaUrls = result.all
    .filter((m) => m.isLocal && m.localPath)
    .map((m) => m.localPath as string);

  return { mediaUrls };
}

/**
 * Extract MEDIA: directives from beginning of lines in text (supports file:// / absolute paths / URLs)
 * Uses extractMediaFromText from shared module
 */
function extractMediaLinesFromText(params: { text: string; logger?: Logger }): {
  text: string;
  mediaUrls: string[];
} {
  const { text, logger } = params;

  const result = extractMediaFromText(text, {
    removeFromText: false,
    checkExists: true,
    existsSync: (p: string) => {
      const exists = fs.existsSync(p);
      if (!exists) {
        logger?.warn?.(`[stream] local media not found: ${p}`);
      }
      return exists;
    },
    parseMediaLines: true,
    parseMarkdownImages: false,
    parseHtmlImages: false,
    parseBarePaths: false,
    parseMarkdownLinks: false,
  });

  const mediaUrls = result.all
    .map((m) => (m.isLocal ? (m.localPath ?? m.source) : m.source))
    .filter((m): m is string => typeof m === "string" && m.trim().length > 0);

  return { text: result.text, mediaUrls };
}

/**
 * 解析钉钉原始消息为标准化的消息上下文
 *
 * @param raw 钉钉原始消息对象
 * @returns 解析后的消息上下�?
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */
/**
 * 解析 raw.content 字段为 DingtalkMediaContent 对象
 * content 可能是 JSON 字符串、DingtalkMediaContent 对象或 undefined
 */
function resolveContentObject(
  content: string | DingtalkMediaContent | undefined,
): DingtalkMediaContent | null {
  if (!content) return null;
  if (typeof content === "object") return content;
  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as DingtalkMediaContent) : null;
  } catch {
    return null;
  }
}

/**
 * 从 richText content 中提取所有文本元素并拼接
 */
function extractRichTextContent(contentObj: DingtalkMediaContent | null): string {
  if (!contentObj) return "";

  const richText = contentObj.richText;
  if (!richText) return "";

  if (typeof richText === "string") {
    try {
      const parsed = JSON.parse(richText) as unknown;
      if (Array.isArray(parsed)) {
        return extractRichTextFromArray(parsed);
      }
    } catch {
      return "";
    }
    return "";
  }

  if (Array.isArray(richText)) {
    return extractRichTextFromArray(richText);
  }

  return "";
}

/**
 * 从 richText 元素数组中提取文本
 */
function extractRichTextFromArray(elements: unknown[]): string {
  const textParts: string[] = [];

  for (const element of elements) {
    if (typeof element !== "object" || element === null) continue;
    const record = element as Record<string, unknown>;

    if (typeof record.text === "string" && record.text.trim()) {
      textParts.push(record.text.trim());
    } else if (record.type === "picture" || record.downloadCode || record.pictureDownloadCode) {
      textParts.push("[图片]");
    }
  }

  return textParts.join(" ");
}

export function parseDingtalkMessage(raw: DingtalkRawMessage): DingtalkMessageContext {
  // 根据 conversationType 判断聊天类型
  // "1" = 单聊 (direct), "2" = 群聊 (group)
  const chatType = raw.conversationType === "2" ? "group" : "direct";

  // 提取消息内容
  let content = "";

  // 解析 content 字段（可能是 JSON 字符串或对象）
  const contentObj = resolveContentObject(raw.content);

  switch (raw.msgtype) {
    case "text":
      // 文本消息：提取 text.content
      if (raw.text?.content) {
        content = raw.text.content.trim();
      }
      break;

    case "audio":
      // 语音消息：提取语音识别文本 content.recognition
      if (
        contentObj &&
        "recognition" in contentObj &&
        typeof contentObj.recognition === "string" &&
        contentObj.recognition.trim()
      ) {
        content = contentObj.recognition.trim();
      } else {
        content = "[语音消息]";
      }
      break;

    case "picture":
      // 图片消息
      content = "[图片]";
      break;

    case "video": {
      // 视频消息：提取时长和格式信息
      const duration = contentObj?.duration;
      const videoType = contentObj?.videoType;
      const durationStr = duration ? ` ${duration}秒` : "";
      const typeStr = videoType ? ` ${videoType}` : "";
      content = `[视频${typeStr}${durationStr}]`;
      break;
    }

    case "file": {
      // 文件消息：提取文件名
      const fileName = contentObj?.fileName;
      content = fileName ? `[文件: ${fileName}]` : "[文件]";
      break;
    }

    case "richText": {
      // 富文本消息：提取所有文本元素拼接
      const richTextContent = extractRichTextContent(contentObj);
      content = richTextContent || "[富文本消息]";
      break;
    }

    case "unknownMsgType": {
      // 不支持的消息类型
      const hint =
        contentObj &&
        "unknownMsgType" in contentObj &&
        typeof contentObj.unknownMsgType === "string"
          ? contentObj.unknownMsgType
          : "用户发送了一条消息，机器人暂不支持接收。";
      content = `[不支持的消息类型] ${hint}`;
      break;
    }

    default:
      // 其他未知类型：尝试从 text.content 或 content 中提取
      if (raw.text?.content) {
        content = raw.text.content.trim();
      }
      break;
  }

  // 检查是�?@提及了机器人
  const mentionedBot = resolveMentionedBot(raw);

  // 使用 Stream 消息 ID（如果可用），确保去重稳定
  const ts = Date.now();
  const fallbackId = `${raw.conversationId}_${ts}`;
  const messageId = raw.streamMessageId ?? fallbackId;

  const senderId = raw.senderStaffId ?? raw.senderUserId ?? raw.senderUserid ?? raw.senderId;

  return {
    conversationId: raw.conversationId,
    messageId,
    senderId,
    senderNick: raw.senderNick,
    chatType,
    content,
    contentType: raw.msgtype,
    mentionedBot,
    robotCode: raw.robotCode,
  };
}

/**
 * 判断是否 @提及了机器人
 *
 * 钉钉群聊机器人只有被 @ 才会收到消息，因此只要 atUsers 数组非空，
 * 就认为机器人被提及。不需要检查 robotCode 是否在 atUsers 中，
 * 因为钉钉 Stream SDK 只会将 @ 机器人的消息推送给机器人。
 */
function resolveMentionedBot(raw: DingtalkRawMessage): boolean {
  const atUsers = raw.atUsers ?? [];
  return atUsers.length > 0;
}

/**
 * 入站消息上下�?
 * 用于传递给 Moltbot 核心的标准化上下�?
 */
export interface InboundContext {
  /** 消息正文 */
  Body: string;
  /** 原始消息正文 */
  RawBody: string;
  /** 命令正文 */
  CommandBody: string;
  /** 发送方标识 */
  From: string;
  /** 接收方标�?*/
  To: string;
  /** 会话�?*/
  SessionKey: string;
  /** 账户 ID */
  AccountId: string;
  /** 聊天类型 */
  ChatType: "direct" | "group";
  /** 群组主题（群聊时�?*/
  GroupSubject?: string;
  /** 发送者名�?*/
  SenderName?: string;
  /** 发送�?ID */
  SenderId: string;
  /** 渠道提供�?*/
  Provider: "dingtalk";
  /** 消息 ID */
  MessageSid: string;
  /** 时间�?*/
  Timestamp: number;
  /** 是否�?@提及 */
  WasMentioned: boolean;
  /** 命令是否已授�?*/
  CommandAuthorized: boolean;
  /** 原始渠道 */
  OriginatingChannel: "dingtalk";
  /** 原始接收�?*/
  OriginatingTo: string;

  // ===== 媒体相关字段 (Requirements 7.1-7.8) =====

  /** 单个媒体文件的本地绝对路�?*/
  MediaPath?: string;
  /** 单个媒体文件�?MIME 类型 (�?"image/jpeg") */
  MediaType?: string;
  /** 多个媒体文件的本地绝对路径数�?(用于 richText 消息) */
  MediaPaths?: string[];
  /** 多个媒体文件�?MIME 类型数组 (用于 richText 消息) */
  MediaTypes?: string[];
  /** 原始文件�?(用于 file 消息) */
  FileName?: string;
  /** 文件大小（字节）(用于 file 消息) */
  FileSize?: number;
  /** 语音识别文本 (用于 audio 消息) */
  Transcript?: string;
}

/**
 * 构建入站消息上下�?
 *
 * @param ctx 解析后的消息上下�?
 * @param sessionKey 会话�?
 * @param accountId 账户 ID
 * @returns 入站消息上下�?
 *
 * Requirements: 6.4
 */
export function buildInboundContext(
  ctx: DingtalkMessageContext,
  sessionKey: string,
  accountId: string,
): InboundContext {
  const isGroup = ctx.chatType === "group";

  // 构建 From �?To 标识
  const from = isGroup ? `dingtalk:group:${ctx.conversationId}` : `dingtalk:${ctx.senderId}`;
  const to = isGroup ? `chat:${ctx.conversationId}` : `user:${ctx.senderId}`;

  return {
    Body: ctx.content,
    RawBody: ctx.content,
    CommandBody: ctx.content,
    From: from,
    To: to,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: ctx.chatType,
    GroupSubject: isGroup ? ctx.conversationId : undefined,
    SenderName: ctx.senderNick,
    SenderId: ctx.senderId,
    Provider: "dingtalk",
    MessageSid: ctx.messageId,
    Timestamp: Date.now(),
    WasMentioned: ctx.mentionedBot,
    CommandAuthorized: true,
    OriginatingChannel: "dingtalk",
    OriginatingTo: to,
  };
}

/**
 * 构建文件上下文消�?
 *
 * 根据文件类型返回对应的中文描述文�?
 *
 * @param msgType 消息类型 (picture, video, audio, file)
 * @param fileName 文件名（可选，用于 file 类型�?
 * @returns 消息正文描述
 *
 * Requirements: 9.5
 */
export function buildFileContextMessage(msgType: MediaMsgType, fileName?: string): string {
  switch (msgType) {
    case "picture":
      return "[图片]";
    case "audio":
      return "[语音消息]";
    case "video":
      return "[视频]";
    case "file": {
      // 根据文件扩展名确定文件类�?
      const displayName = fileName ?? "未知文件";

      if (fileName) {
        // 使用 resolveFileCategory 来确定文件类�?
        const category = resolveFileCategory("application/octet-stream", fileName);

        switch (category) {
          case "document":
            return `[文档: ${displayName}]`;
          case "archive":
            return `[压缩�? ${displayName}]`;
          case "code":
            return `[代码文件: ${displayName}]`;
          default:
            return `[文件: ${displayName}]`;
        }
      }

      return `[文件: ${displayName}]`;
    }
    default:
      return `[文件: ${fileName ?? "未知文件"}]`;
  }
}

/**
 * 钉钉消息处理核心参数
 */
interface ProcessDingtalkMessageCoreParams {
  cfg: unknown;
  raw: DingtalkRawMessage;
  accountId: string;
  enableAICard: boolean;
  logger: Logger;
  /** Optional callback invoked whenever the agent produces a reply.
   *  Used by the async task queue to forward LLM output to JarvisCard. */
  onDeliver?: (payload: { text?: string; kind?: string }) => void;
  /** When true, suppress direct message sending via sendMessageDingtalk.
   *  Only the onDeliver callback will receive reply payloads.
   *  Used by async task queue (heavy/normal/append) to prevent duplicate
   *  messages when JarvisCard already handles the output display. */
  suppressDirectReply?: boolean;
}

/**
 * 处理钉钉消息的核心逻辑（可被同步或异步调用）
 *
 * @param params 处理参数
 * @returns Promise<void>
 */
async function processDingtalkMessageCore(params: ProcessDingtalkMessageCoreParams): Promise<void> {
  const startTime = performance.now();
  const { cfg, raw, accountId, enableAICard, logger, onDeliver, suppressDirectReply } = params;
  logger.debug(`[PERF] processDingtalkMessageCore started`);

  // 解析消息
  const parseStart = performance.now();
  const ctx = parseDingtalkMessage(raw);
  const isGroup = ctx.chatType === "group";
  logger.debug(`[PERF] parseDingtalkMessage: ${(performance.now() - parseStart).toFixed(2)}ms`);

  // 添加详细的原始消息调试日志
  logger.debug(
    `raw message: msgtype=${raw.msgtype}, hasText=${!!raw.text?.content}, hasContent=${!!raw.content}, textContent="${raw.text?.content ?? ""}"`,
  );

  // 对于 richText 消息，输出完整的原始消息结构以便调试
  if (raw.msgtype === "richText") {
    try {
      // 安全地序列化原始消息（排除可能的循环引用）
      const safeRaw = {
        msgtype: raw.msgtype,
        conversationId: raw.conversationId,
        conversationType: raw.conversationType,
        senderId: raw.senderId,
        senderNick: raw.senderNick,
        text: raw.text,
        content: raw.content,
        // 检查是否有其他可能包含文本的字段
        hasRichTextInRoot: "richText" in raw,
        allKeys: Object.keys(raw),
      };
      logger.debug(`[FULL RAW] richText message structure: ${JSON.stringify(safeRaw)}`);
    } catch (e) {
      logger.debug(`[FULL RAW] failed to serialize: ${String(e)}`);
    }
  }

  logger.debug(`received message from ${ctx.senderId} in ${ctx.conversationId} (${ctx.chatType})`);

  // 获取钉钉配置
  const dingtalkCfg = (cfg as Record<string, unknown>)?.channels as
    | Record<string, unknown>
    | undefined;
  const channelCfg = dingtalkCfg?.dingtalk as DingtalkConfig | undefined;

  // 策略检�?
  if (isGroup) {
    const groupPolicy = channelCfg?.groupPolicy ?? "open";
    const groupAllowFrom = channelCfg?.groupAllowFrom ?? [];
    const requireMention = channelCfg?.requireMention ?? true;

    const policyResult = checkGroupPolicy({
      groupPolicy,
      conversationId: ctx.conversationId,
      groupAllowFrom,
      requireMention,
      mentionedBot: ctx.mentionedBot,
    });

    if (!policyResult.allowed) {
      logger.debug(`policy rejected: ${policyResult.reason}`);
      return;
    }
  } else {
    const dmPolicy = channelCfg?.dmPolicy ?? "open";
    const allowFrom = channelCfg?.allowFrom ?? [];

    const policyResult = checkDmPolicy({
      dmPolicy,
      senderId: ctx.senderId,
      allowFrom,
    });

    if (!policyResult.allowed) {
      logger.debug(`policy rejected: ${policyResult.reason}`);
      return;
    }
  }

  // SECURITY FIX: Create a per-request copy of channelCfg to avoid identity bleed.
  // The original code stored operatorUserId in the global channelCfg object,
  // causing all subsequent requests to use the first user's identity.
  let requestChannelCfg = channelCfg;

  // Auto-populate operatorUserId from the inbound senderId only when
  // no operatorUserId is explicitly configured. This respects admin-set
  // service-account identities and avoids an API call per message.
  if (channelCfg && ctx.senderId && !channelCfg.operatorUserId) {
    const cached = getCachedUnionId(ctx.senderId);
    if (cached) {
      requestChannelCfg = { ...channelCfg, operatorUserId: cached };
      logger.debug(`operatorUserId from cache: ${ctx.senderId} → ${cached}`);
    } else {
      const userLookupStart = performance.now();
      try {
        const userDetail = await getUserInfoByStaffId(channelCfg, ctx.senderId);
        const resolvedId = userDetail.unionid ?? ctx.senderId;
        if (userDetail.unionid) {
          setCachedUnionId(ctx.senderId, userDetail.unionid);
        }
        requestChannelCfg = { ...channelCfg, operatorUserId: resolvedId };
        logger.debug(
          `auto-set operatorUserId from senderId: ${ctx.senderId} → unionId: ${resolvedId}`,
        );
      } catch (error) {
        requestChannelCfg = channelCfg;
        logger.warn(
          `operatorUserId lookup failed for ${ctx.senderId}: ${String(error)} — commands requiring user identity will fail`,
        );
      }
      logger.debug(
        `[PERF] getUserInfoByStaffId (operatorUserId lookup): ${(performance.now() - userLookupStart).toFixed(2)}ms`,
      );
    }
  } else if (channelCfg) {
    requestChannelCfg = channelCfg;
  }

  // ===== 群管理命令拦截 =====
  // 在分发到 gateway 之前，检查是否为 /group 命令并直接处理
  if (requestChannelCfg && ctx.content.trim().toLowerCase().startsWith("/group")) {
    const handled = await handleGroupCommand(requestChannelCfg, ctx);
    if (handled) {
      logger.debug("group command handled, skipping gateway dispatch");
      return;
    }
  }

  // ===== 待办命令拦截 =====
  if (requestChannelCfg && ctx.content.trim().toLowerCase().startsWith("/todo")) {
    const handled = await handleTodoCommand(requestChannelCfg, ctx);
    if (handled) {
      logger.debug("todo command handled, skipping gateway dispatch");
      return;
    }
  }

  // ===== 日程命令拦截 =====
  if (requestChannelCfg && ctx.content.trim().toLowerCase().startsWith("/cal")) {
    const handled = await handleCalendarCommand(requestChannelCfg, ctx);
    if (handled) {
      logger.debug("calendar command handled, skipping gateway dispatch");
      return;
    }
  }

  // ===== 文档命令拦截 =====
  if (requestChannelCfg && ctx.content.trim().toLowerCase().startsWith("/doc")) {
    const handled = await handleDocCommand(requestChannelCfg, ctx);
    if (handled) {
      logger.debug("doc command handled, skipping gateway dispatch");
      return;
    }
  }

  // ===== Jarvis 快捷指令拦截 =====
  if (requestChannelCfg && ctx.content.trim().toLowerCase().startsWith("/jarvis")) {
    const handled = await handleJarvisCommand(requestChannelCfg, ctx);
    if (handled) {
      logger.debug("jarvis command handled, skipping gateway dispatch");
      return;
    }
  }

  // 检查运行时是否已初始化
  const runtimeCheckStart = performance.now();
  if (!isDingtalkRuntimeInitialized()) {
    logger.warn("runtime not initialized, skipping dispatch");
    return;
  }
  logger.debug(
    `[PERF] isDingtalkRuntimeInitialized check: ${(performance.now() - runtimeCheckStart).toFixed(2)}ms`,
  );

  // ===== 媒体消息处理变量 (�?try 块外声明以便 catch 块访�? =====
  let downloadedMedia: DownloadedFile | null = null;
  let downloadedRichTextImages: DownloadedFile[] = [];
  let extractedFileInfo: ExtractedFileInfo | null = null;

  try {
    // [PERF] 获取完整�?Moltbot 运行时（包含 core API�?
    const runtimeStart = performance.now();
    const core = getDingtalkRuntime();
    logger.debug(`[PERF] getDingtalkRuntime: ${(performance.now() - runtimeStart).toFixed(2)}ms`);
    const coreRecord = core as Record<string, unknown>;
    const coreChannel = coreRecord?.channel as Record<string, unknown> | undefined;
    const replyApi = coreChannel?.reply as Record<string, unknown> | undefined;
    const routingApi = coreChannel?.routing as Record<string, unknown> | undefined;

    // 检查必要的 API 是否存在
    if (!routingApi?.resolveAgentRoute) {
      logger.debug("core.channel.routing.resolveAgentRoute not available, skipping dispatch");
      return;
    }

    if (!replyApi?.dispatchReplyFromConfig) {
      logger.debug("core.channel.reply.dispatchReplyFromConfig not available, skipping dispatch");
      return;
    }

    if (!replyApi?.createReplyDispatcher && !replyApi?.createReplyDispatcherWithTyping) {
      logger.debug("core.channel.reply dispatcher factory not available, skipping dispatch");
      return;
    }

    // 解析路由
    const routeStart = performance.now();
    const resolveAgentRoute = routingApi.resolveAgentRoute as (
      opts: Record<string, unknown>,
    ) => Record<string, unknown>;
    const route = resolveAgentRoute({
      cfg,
      channel: "dingtalk",
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup ? ctx.conversationId : ctx.senderId,
      },
    });
    logger.debug(`[PERF] resolveAgentRoute: ${(performance.now() - routeStart).toFixed(2)}ms`);

    // ===== 媒体消息处理 (Requirements 9.1, 9.2, 9.4, 9.6) =====
    // 用于存储下载的媒体文件信�?
    let mediaBody: string | null = null;
    let richTextParseResult: ReturnType<typeof parseRichTextMessage> = null;

    // 检测并处理媒体消息类型 (picture, video, audio, file)
    // 语音消息：如果钉钉已提供 recognition 文本，跳过下载，直接当文本处理
    const audioHasRecognition =
      raw.msgtype === "audio" && ctx.content !== "" && ctx.content !== "[语音消息]";
    const mediaTypes: MediaMsgType[] = ["picture", "video", "audio", "file"];
    if (audioHasRecognition) {
      logger.debug(`audio message has recognition text, skipping file download: "${ctx.content}"`);
    }
    if (mediaTypes.includes(raw.msgtype as MediaMsgType) && !audioHasRecognition) {
      try {
        // 提取文件信息 (Requirement 9.1)
        extractedFileInfo = extractFileFromMessage(raw);

        if (extractedFileInfo && channelCfg?.clientId && channelCfg?.clientSecret) {
          const mediaDownloadStart = performance.now();
          // 获取 access token (Requirement 9.6)
          const accessToken = await getAccessToken(channelCfg.clientId, channelCfg.clientSecret);
          logger.debug(
            `[PERF] getAccessToken: ${(performance.now() - mediaDownloadStart).toFixed(2)}ms`,
          );

          // 下载文件 (Requirement 9.2)
          const fileDownloadStart = performance.now();
          downloadedMedia = await downloadDingTalkFile({
            downloadCode: extractedFileInfo.downloadCode,
            robotCode: channelCfg.clientId,
            accessToken,
            fileName: extractedFileInfo.fileName,
            msgType: extractedFileInfo.msgType,
            log: logger,
            maxFileSizeMB: channelCfg.maxFileSizeMB,
          });
          logger.debug(
            `[PERF] downloadDingTalkFile: ${(performance.now() - fileDownloadStart).toFixed(2)}ms`,
          );

          logger.debug(
            `downloaded media file: ${downloadedMedia.path} (${downloadedMedia.size} bytes)`,
          );

          // 构建消息正文 (Requirement 9.5)
          mediaBody = buildFileContextMessage(
            extractedFileInfo.msgType,
            extractedFileInfo.fileName,
          );
        }
      } catch (err) {
        // 优雅降级：记录警告并继续处理文本内容 (Requirement 9.4)
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn(`media download failed, continuing with text: ${errorMessage}`);
        downloadedMedia = null;
        extractedFileInfo = null;
      }
    }

    // ===== richText 消息处理 (Requirements 9.3, 3.6) =====
    if (raw.msgtype === "richText") {
      try {
        // 解析 richText 消息
        richTextParseResult = parseRichTextMessage(raw);

        if (richTextParseResult && channelCfg?.clientId && channelCfg?.clientSecret) {
          // 检查是否有图片需要下�?(Requirement 3.6)
          if (richTextParseResult.imageCodes.length > 0) {
            // 获取 access token
            const accessToken = await getAccessToken(channelCfg.clientId, channelCfg.clientSecret);

            // 批量下载图片
            downloadedRichTextImages = await downloadRichTextImages({
              imageCodes: richTextParseResult.imageCodes,
              robotCode: channelCfg.clientId,
              accessToken,
              log: logger,
              maxFileSizeMB: channelCfg.maxFileSizeMB,
            });

            logger.debug(
              `downloaded ${downloadedRichTextImages.length}/${richTextParseResult.imageCodes.length} richText images`,
            );
          }

          const orderedLines: string[] = [];
          const imageQueue = [...downloadedRichTextImages];

          for (const element of richTextParseResult.elements ?? []) {
            if (!element) continue;
            if (element.type === "picture") {
              const file = imageQueue.shift();
              orderedLines.push(file?.path ?? "[图片]");
              continue;
            }
            if (element.type === "text" && typeof element.text === "string") {
              orderedLines.push(element.text);
              continue;
            }
            if (element.type === "at" && typeof element.userId === "string") {
              orderedLines.push(`@${element.userId}`);
              continue;
            }
          }

          if (orderedLines.length > 0) {
            mediaBody = orderedLines.join("\n");
          } else if (richTextParseResult.textParts.length > 0) {
            mediaBody = richTextParseResult.textParts.join("\n");
          } else if (downloadedRichTextImages.length > 0) {
            // 兜底：如果只有图片没有文本，设置为图片描述
            mediaBody =
              downloadedRichTextImages.length === 1
                ? "[图片]"
                : `[${downloadedRichTextImages.length}张图片]`;
          }
        }
      } catch (err) {
        // 优雅降级：记录警告并继续处理
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn(`richText processing failed: ${errorMessage}`);
        richTextParseResult = null;
        downloadedRichTextImages = [];
      }
    }

    // 构建入站上下�?
    const buildCtxStart = performance.now();
    const inboundCtx = buildInboundContext(
      ctx,
      (route as Record<string, unknown>)?.sessionKey as string,
      (route as Record<string, unknown>)?.accountId as string,
    );
    logger.debug(`[PERF] buildInboundContext: ${(performance.now() - buildCtxStart).toFixed(2)}ms`);

    // 设置媒体相关字段 (Requirements 7.1-7.8)
    if (downloadedMedia) {
      inboundCtx.MediaPath = downloadedMedia.path;
      inboundCtx.MediaType = downloadedMedia.contentType;

      // 设置消息正文为媒体描�?
      if (mediaBody) {
        inboundCtx.Body = mediaBody;
        inboundCtx.RawBody = mediaBody;
        inboundCtx.CommandBody = mediaBody;
      }

      // 文件消息特有字段
      if (extractedFileInfo?.msgType === "file") {
        if (extractedFileInfo.fileName) {
          inboundCtx.FileName = extractedFileInfo.fileName;
        }
        if (extractedFileInfo.fileSize !== undefined) {
          inboundCtx.FileSize = extractedFileInfo.fileSize;
        }
      }

      // 音频消息的语音识别文�?
      if (extractedFileInfo?.msgType === "audio" && extractedFileInfo.recognition) {
        inboundCtx.Transcript = extractedFileInfo.recognition;
      }
    }

    // 设置 richText 消息的媒体字�?(Requirements 7.3, 7.4)
    if (downloadedRichTextImages.length > 0) {
      inboundCtx.MediaPaths = downloadedRichTextImages.map((f) => f.path);
      inboundCtx.MediaTypes = downloadedRichTextImages.map((f) => f.contentType);

      // 设置消息正文
      if (mediaBody) {
        inboundCtx.Body = mediaBody;
        inboundCtx.RawBody = mediaBody;
        inboundCtx.CommandBody = mediaBody;
      }
    } else if (richTextParseResult && richTextParseResult.textParts.length > 0) {
      // 纯文�?richText 消息 (Requirement 3.6)
      // 不设�?MediaPath/MediaType，只设置 Body
      const textBody = richTextParseResult.textParts.join("\n");
      inboundCtx.Body = textBody;
      inboundCtx.RawBody = textBody;
      inboundCtx.CommandBody = textBody;
    }

    // 如果�?finalizeInboundContext，使用它
    const finalizeStart = performance.now();
    const finalizeInboundContext = replyApi?.finalizeInboundContext as
      | ((ctx: InboundContext) => InboundContext)
      | undefined;
    const finalCtx = finalizeInboundContext ? finalizeInboundContext(inboundCtx) : inboundCtx;
    logger.debug(
      `[PERF] finalizeInboundContext: ${(performance.now() - finalizeStart).toFixed(2)}ms`,
    );

    // Inject a timestamp prefix so the agent knows the current date/time.
    // Core channels get this via gateway handler; plugins must do it themselves.
    // DingTalk users are in China, so default to Asia/Shanghai.
    if (finalCtx.Body && finalCtx.Body.trim()) {
      const timestampEnvelopePattern = /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
      if (!timestampEnvelopePattern.test(finalCtx.Body)) {
        const timezone = "Asia/Shanghai";
        const now = new Date();
        const dow = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          weekday: "short",
        }).format(now);
        const formatted = new Intl.DateTimeFormat("en-CA", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
          .format(now)
          .replace(",", "");
        finalCtx.Body = `[${dow} ${formatted} CST] ${finalCtx.Body}`;
        logger.debug(`injected timestamp into message body: [${dow} ${formatted} CST]`);
      }
    }

    const dingtalkCfgResolved = channelCfg;
    if (!dingtalkCfgResolved) {
      logger.warn("channel config missing, skipping dispatch");
      return;
    }

    // ===== AI Card 准备（如果启用）=====
    let aiCard: AICardInstance | null = null;
    if (enableAICard) {
      const aiCardStart = performance.now();
      aiCard = await createAICard({
        cfg: dingtalkCfgResolved,
        conversationType: ctx.chatType === "group" ? "2" : "1",
        conversationId: ctx.conversationId,
        senderId: ctx.senderId,
        senderStaffId: raw.senderStaffId,
        log: (msg) => logger.debug(msg),
      });
      logger.debug(`[PERF] createAICard: ${(performance.now() - aiCardStart).toFixed(2)}ms`);

      if (aiCard) {
        logger.info("AI Card created, will update via dispatch deliver");
      } else {
        logger.warn("AI Card creation failed, falling back to normal message");
      }
    }

    // ===== 普通消息模�?=====
    const textApi = coreChannel?.text as Record<string, unknown> | undefined;

    const textChunkLimitResolved =
      (textApi?.resolveTextChunkLimit as ((opts: Record<string, unknown>) => number) | undefined)?.(
        {
          cfg,
          channel: "dingtalk",
          defaultLimit: dingtalkCfgResolved.textChunkLimit ?? 4000,
        },
      ) ??
      dingtalkCfgResolved.textChunkLimit ??
      4000;
    const chunkMode = (
      textApi?.resolveChunkMode as ((cfg: unknown, channel: string) => unknown) | undefined
    )?.(cfg, "dingtalk");
    const tableMode = "bullets";

    const deliver = async (
      payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
      info?: { kind?: string },
    ) => {
      // Notify the caller (e.g. async task queue) so it can forward
      // LLM output to JarvisCard or other external surfaces — even when
      // replyFinalOnly suppresses the normal delivery path.
      if (onDeliver) {
        try {
          onDeliver({ text: payload.text, kind: info?.kind });
        } catch (deliverErr) {
          logger.warn(`onDeliver callback failed: ${String(deliverErr)}`);
        }
      }

      // When suppressDirectReply is set (async task queue mode), skip direct
      // message sending via sendMessageDingtalk. The onDeliver callback above
      // already forwarded the output to JarvisCard. This prevents duplicate
      // messages (JarvisCard status card + direct text reply appearing at once).
      if (suppressDirectReply) {
        return true;
      }

      if (replyFinalOnly && (!info || info.kind !== "final")) {
        return false;
      }
      logger.debug(
        `[reply] payload=${JSON.stringify({
          hasText: typeof payload.text === "string",
          text: payload.text,
          mediaUrl: payload.mediaUrl,
          mediaUrls: payload.mediaUrls,
        })}`,
      );
      const targetId = isGroup ? ctx.conversationId : ctx.senderId;
      const chatType = isGroup ? "group" : "direct";
      let sent = false;

      // AI Card 模式：流式更新卡片内容
      let aiCardHandledText = false;
      if (aiCard && typeof payload.text === "string" && payload.text.trim()) {
        try {
          if (info?.kind === "final") {
            await finishAICard(aiCard, payload.text, (msg) => logger.debug(msg));
            logger.info(`AI Card finished with ${payload.text.length} chars`);
          } else {
            await streamAICard(aiCard, payload.text, false, (msg) => logger.debug(msg));
            logger.debug(`AI Card streamed ${payload.text.length} chars`);
          }
          sent = true;
          aiCardHandledText = true;
        } catch (cardErr) {
          // Retry once before giving up — avoid mixing card + plain message formats
          logger.warn(`AI Card update failed (attempt 1/2), retrying: ${String(cardErr)}`);
          try {
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (info?.kind === "final") {
              await finishAICard(aiCard, payload.text, (msg) => logger.debug(msg));
              logger.info(`AI Card finished on retry with ${payload.text.length} chars`);
            } else {
              await streamAICard(aiCard, payload.text, false, (msg) => logger.debug(msg));
              logger.debug(`AI Card streamed on retry ${payload.text.length} chars`);
            }
            sent = true;
            aiCardHandledText = true;
          } catch (retryErr) {
            // All retries exhausted: nullify aiCard so subsequent deliver calls
            // fall through to plain text consistently (no more mixed formats)
            logger.warn(
              `AI Card update failed after 2 attempts, disabling card for this session: ${String(retryErr)}`,
            );
            aiCard = null;
          }
        }
      }

      const sendMediaWithFallback = async (mediaUrl: string): Promise<void> => {
        try {
          await sendMediaDingtalk({
            cfg: dingtalkCfgResolved,
            to: targetId,
            mediaUrl,
            chatType,
          });
          sent = true;
        } catch (err) {
          logger.error(`[reply] sendMediaDingtalk failed: ${String(err)}`);
          const fallbackText = `📎 ${mediaUrl}`;
          await sendMessageDingtalk({
            cfg: dingtalkCfgResolved,
            to: targetId,
            text: fallbackText,
            chatType,
          });
          sent = true;
        }
      };

      const payloadMediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
      const rawText = payload.text ?? "";
      const { mediaUrls: mediaFromLines } = extractMediaLinesFromText({
        text: rawText,
        logger,
      });
      const { mediaUrls: localMediaFromText } = extractLocalMediaFromText({
        text: rawText,
        logger,
      });

      const mediaQueue: string[] = [];
      const seenMedia = new Set<string>();
      const addMedia = (value?: string) => {
        const trimmed = value?.trim();
        if (!trimmed) return;
        if (seenMedia.has(trimmed)) return;
        seenMedia.add(trimmed);
        mediaQueue.push(trimmed);
      };

      for (const url of payloadMediaUrls) addMedia(url);
      for (const url of mediaFromLines) addMedia(url);
      for (const url of localMediaFromText) addMedia(url);

      const converted =
        (textApi?.convertMarkdownTables as ((text: string, mode: string) => string) | undefined)?.(
          rawText,
          tableMode,
        ) ?? rawText;

      const hasText = converted.trim().length > 0;
      if (hasText && !aiCardHandledText) {
        const chunks =
          textApi?.chunkTextWithMode &&
          typeof textChunkLimitResolved === "number" &&
          textChunkLimitResolved > 0
            ? (
                textApi.chunkTextWithMode as (
                  text: string,
                  limit: number,
                  mode: unknown,
                ) => string[]
              )(converted, textChunkLimitResolved, chunkMode)
            : [converted];

        for (const chunk of chunks) {
          await sendMessageDingtalk({
            cfg: dingtalkCfgResolved,
            to: targetId,
            text: chunk,
            chatType,
          });
          sent = true;
        }
      }

      for (const mediaUrl of mediaQueue) {
        await sendMediaWithFallback(mediaUrl);
      }

      if (!hasText && mediaQueue.length === 0) {
        return false;
      }
      return sent;
    };

    const replyFinalOnly = dingtalkCfgResolved.replyFinalOnly === true;
    const deliverFinalOnly = async (
      payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
      info?: { kind?: string },
    ): Promise<boolean> => {
      return await deliver(payload, info);
    };

    const humanDelay = (
      replyApi?.resolveHumanDelayConfig as ((cfg: unknown, agentId?: string) => unknown) | undefined
    )?.(cfg, (route as Record<string, unknown>)?.agentId as string | undefined);

    const createDispatcherWithTyping = replyApi?.createReplyDispatcherWithTyping as
      | ((opts: Record<string, unknown>) => Record<string, unknown>)
      | undefined;
    const createDispatcher = replyApi?.createReplyDispatcher as
      | ((opts: Record<string, unknown>) => Record<string, unknown>)
      | undefined;

    const dispatchReplyWithBufferedBlockDispatcher =
      replyApi?.dispatchReplyWithBufferedBlockDispatcher as
        | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
        | undefined;

    if (dispatchReplyWithBufferedBlockDispatcher) {
      logger.debug(
        `dispatching to agent (buffered, session=${(route as Record<string, unknown>)?.sessionKey})`,
      );
      const dispatchStart = performance.now();
      const deliveryState = { delivered: false, skippedNonSilent: 0 };
      // Track whether the AI Card received a proper "final" finish call.
      // Intermediate stream updates set delivered=true but the card stays
      // in INPUTING state until finishAICard is called. When the agent's
      // final reply is skipped (e.g. concurrent message preemption), we
      // must finish the card with the last streamed content so it doesn't
      // stay stuck showing "···".
      let aiCardFinished = false;
      let accumulatedCardText = "";
      const buffered = {
        lastText: "",
        mediaUrls: [] as string[],
        hasPayload: false,
      };
      const addBufferedMedia = (value?: string) => {
        const trimmed = value?.trim();
        if (!trimmed) return;
        if (buffered.mediaUrls.includes(trimmed)) return;
        buffered.mediaUrls.push(trimmed);
      };
      // When AI Card streaming is active, inject low block streaming thresholds
      // so even short replies trigger intermediate block updates.
      // Default minChars=800 is too high for AI Card's replace-style updates.
      const useAiCardStreaming = !replyFinalOnly && !!aiCard;
      const dispatchCfg = useAiCardStreaming
        ? injectBlockStreamingDefaults(cfg, {
            blockStreamingChunk: { minChars: 1, maxChars: 4000, breakPreference: "newline" },
            blockStreamingCoalesce: { minChars: 1, maxChars: 4000, idleMs: 300 },
          })
        : cfg;
      const result = await dispatchReplyWithBufferedBlockDispatcher({
        ctx: finalCtx,
        cfg: dispatchCfg,
        dispatcherOptions: {
          deliver: async (payload: unknown, info?: { kind?: string }) => {
            // AI Card 流式模式：中间回复流式更新卡片，final 完成卡片
            if (!replyFinalOnly && aiCard) {
              const typed = payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] };
              if (typeof typed.text === "string" && typed.text.trim()) {
                try {
                  if (info?.kind === "final") {
                    await finishAICard(aiCard, typed.text, (msg) => logger.debug(msg));
                    logger.info(`AI Card finished with ${typed.text.length} chars (buffered)`);
                    aiCardFinished = true;
                  } else {
                    // Block streaming chunks are already complete text segments;
                    // AI Card uses isFull=true (full replacement), so we accumulate.
                    // Collapse any residual "\n\n" coalescer joiners at the boundary
                    // between the existing accumulated text and the new chunk, so
                    // preprocessDingtalkMarkdown can merge soft breaks correctly
                    // (DingTalk renders every \n as a real line break).
                    accumulatedCardText = accumulatedCardText
                      ? collapseCoalescerJoiners(accumulatedCardText, typed.text)
                      : typed.text;
                    await streamAICard(aiCard, accumulatedCardText, false, (msg) =>
                      logger.debug(msg),
                    );
                    logger.debug(`AI Card streamed ${typed.text.length} chars (buffered)`);
                  }
                  deliveryState.delivered = true;
                } catch (cardErr) {
                  logger.warn(`AI Card update failed in buffered dispatcher: ${String(cardErr)}`);
                  const didSend = await deliverFinalOnly(typed, info);
                  if (didSend) deliveryState.delivered = true;
                }
              }
              // 处理媒体附件（仅 final 时发送）
              const mediaUrls = typed.mediaUrls ?? (typed.mediaUrl ? [typed.mediaUrl] : []);
              if (info?.kind === "final" && mediaUrls.length > 0) {
                const didSend = await deliverFinalOnly({ mediaUrls }, info);
                if (didSend) deliveryState.delivered = true;
              }
              return;
            }

            if (!replyFinalOnly) {
              const didSend = await deliverFinalOnly(
                payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] },
                info,
              );
              if (didSend) {
                deliveryState.delivered = true;
              }
              return;
            }

            if (!info || info.kind !== "final") {
              return;
            }

            const typed = payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] };
            buffered.hasPayload = true;
            if (typeof typed.text === "string" && typed.text.trim()) {
              buffered.lastText = typed.text;
            }
            if (Array.isArray(typed.mediaUrls)) {
              for (const url of typed.mediaUrls) addBufferedMedia(url);
            } else if (typed.mediaUrl) {
              addBufferedMedia(typed.mediaUrl);
            }
          },
          humanDelay,
          onSkip: (_payload: unknown, info: { kind: string; reason: string }) => {
            if (info.reason !== "silent") {
              deliveryState.skippedNonSilent += 1;
            }
          },
          onError: (err: unknown, info: { kind: string }) => {
            logger.error(`${info.kind} reply failed: ${String(err)}`);
          },
        },
        // Enable block streaming when AI Card is active for real-time updates
        replyOptions: {
          disableBlockStreaming: replyFinalOnly || !aiCard ? undefined : false,
        },
      });

      if (buffered.hasPayload) {
        const didSend = await deliver(
          {
            text: buffered.lastText,
            mediaUrls: buffered.mediaUrls.length ? buffered.mediaUrls : undefined,
          },
          { kind: "final" },
        );
        if (didSend) {
          deliveryState.delivered = true;
        }
      }

      if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
        await sendMessageDingtalk({
          cfg: dingtalkCfgResolved,
          to: isGroup ? ctx.conversationId : ctx.senderId,
          text: "No response generated. Please try again.",
          chatType: isGroup ? "group" : "direct",
        });
      }

      // Finish AI Card if it was never properly finished.
      // Case 1: Card received streamed content but the final reply was
      //         skipped (e.g. concurrent message preemption). Finish with
      //         the last streamed text so the card shows complete content
      //         instead of staying stuck in INPUTING state with "···".
      // Case 2: Card was created but never received any content at all.
      if (aiCard && !aiCardFinished) {
        try {
          // Pick a meaningful fallback depending on what happened:
          // - Had streamed content → use it (card shows partial answer)
          // - Preempted by newer message → tell user explicitly
          // - No content at all → generic "processing" hint
          const fallbackText =
            accumulatedCardText ||
            (deliveryState.skippedNonSilent > 0
              ? "⏭️ 已被新消息抢占，本条消息的回复已跳过。请查看最新消息的回复。"
              : "处理中...");
          await finishAICard(aiCard, fallbackText, (msg) => logger.debug(msg));
          logger.info(
            `AI Card finished (fallback, hadStreamedContent=${!!accumulatedCardText}, preempted=${deliveryState.skippedNonSilent > 0})`,
          );
        } catch (cardErr) {
          logger.warn(`Failed to finish orphaned AI Card: ${String(cardErr)}`);
        }
      }

      const counts = (result as Record<string, unknown>)?.counts as
        | Record<string, unknown>
        | undefined;
      const queuedFinal = (result as Record<string, unknown>)?.queuedFinal as unknown;
      logger.debug(
        `dispatch complete (queuedFinal=${typeof queuedFinal === "boolean" ? queuedFinal : "unknown"}, replies=${counts?.final ?? 0})`,
      );
      logger.debug(
        `[PERF] dispatchReplyWithBufferedBlockDispatcher total: ${(performance.now() - dispatchStart).toFixed(2)}ms`,
      );
      return;
    }

    const dispatcherResult = createDispatcherWithTyping
      ? createDispatcherWithTyping({
          deliver: async (payload: unknown, info?: { kind?: string }) => {
            await deliverFinalOnly(
              payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] },
              info,
            );
          },
          humanDelay,
          onError: (err: unknown, info: { kind: string }) => {
            logger.error(`${info.kind} reply failed: ${String(err)}`);
          },
        })
      : {
          dispatcher: createDispatcher?.({
            deliver: async (payload: unknown, info?: { kind?: string }) => {
              await deliverFinalOnly(
                payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] },
                info,
              );
            },
            humanDelay,
            onError: (err: unknown, info: { kind: string }) => {
              logger.error(`${info.kind} reply failed: ${String(err)}`);
            },
          }),
          replyOptions: {},
          markDispatchIdle: () => undefined,
        };

    const dispatcher = (dispatcherResult as Record<string, unknown>)?.dispatcher as
      | Record<string, unknown>
      | undefined;
    if (!dispatcher) {
      logger.debug("dispatcher not available, skipping dispatch");
      return;
    }

    logger.debug(
      `dispatching to agent (session=${(route as Record<string, unknown>)?.sessionKey})`,
    );

    // 分发消息
    const dispatchReplyFromConfig = replyApi?.dispatchReplyFromConfig as
      | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
      | undefined;

    if (!dispatchReplyFromConfig) {
      logger.debug("dispatchReplyFromConfig not available");
      return;
    }

    const dispatchStart2 = performance.now();
    const result = await dispatchReplyFromConfig({
      ctx: finalCtx,
      cfg,
      dispatcher,
      replyOptions: (dispatcherResult as Record<string, unknown>)?.replyOptions ?? {},
    });
    logger.debug(
      `[PERF] dispatchReplyFromConfig: ${(performance.now() - dispatchStart2).toFixed(2)}ms`,
    );

    const markDispatchIdle = (dispatcherResult as Record<string, unknown>)?.markDispatchIdle as
      | (() => void)
      | undefined;
    markDispatchIdle?.();

    const counts = (result as Record<string, unknown>)?.counts as
      | Record<string, unknown>
      | undefined;
    const queuedFinal = (result as Record<string, unknown>)?.queuedFinal as unknown;
    logger.debug(
      `dispatch complete (queuedFinal=${typeof queuedFinal === "boolean" ? queuedFinal : "unknown"}, replies=${counts?.final ?? 0})`,
    );

    // ===== 文件清理 (Requirements 8.1, 8.2, 8.4) =====
    // 清理单个媒体文件
    if (downloadedMedia && extractedFileInfo) {
      const category = resolveFileCategory(downloadedMedia.contentType, extractedFileInfo.fileName);

      // 图片/音频/视频立即删除 (Requirement 8.1)
      // 文档/压缩�?代码文件保留�?agent 工具访问 (Requirement 8.2)
      if (category === "image" || category === "audio" || category === "video") {
        await cleanupFile(downloadedMedia.path, logger);
        logger.debug(`cleaned up media file: ${downloadedMedia.path}`);
      } else {
        logger.debug(
          `retaining file for agent access: ${downloadedMedia.path} (category: ${category})`,
        );
      }
    }

    // 清理 richText 图片 (Requirement 8.4)
    for (const img of downloadedRichTextImages) {
      await cleanupFile(img.path, logger);
    }
    if (downloadedRichTextImages.length > 0) {
      logger.debug(`cleaned up ${downloadedRichTextImages.length} richText images`);
    }
  } catch (err) {
    logger.error(`failed to dispatch message: ${String(err)}`);
    logger.debug(
      `[PERF] processDingtalkMessageCore total (error path): ${(performance.now() - startTime).toFixed(2)}ms`,
    );

    // 即使出错也要按分类策略清理文�?(Requirements 8.1, 8.2)
    // 图片/音频/视频立即删除，文�?压缩�?代码文件保留�?agent 工具访问
    if (downloadedMedia && extractedFileInfo) {
      const category = resolveFileCategory(downloadedMedia.contentType, extractedFileInfo.fileName);
      if (category === "image" || category === "audio" || category === "video") {
        await cleanupFile(downloadedMedia.path, logger);
        logger.debug(`cleaned up media file on error: ${downloadedMedia.path}`);
      } else {
        logger.debug(
          `retaining file for agent access on error: ${downloadedMedia.path} (category: ${category})`,
        );
      }
    }

    // richText 图片始终清理
    for (const img of downloadedRichTextImages) {
      await cleanupFile(img.path, logger);
    }
  }
  logger.debug(
    `[PERF] processDingtalkMessageCore total: ${(performance.now() - startTime).toFixed(2)}ms`,
  );
}

/**
 * 处理钉钉入站消息
 *
 * 集成消息解析、策略检查和 Agent 分发
 *
 * @param params 处理参数
 * @returns Promise<void>
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */
export async function handleDingtalkMessage(params: {
  cfg: unknown; // ClawdbotConfig
  raw: DingtalkRawMessage;
  accountId?: string;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  enableAICard?: boolean;
}): Promise<void> {
  const handleStartTime = performance.now();
  const { cfg, raw, accountId = "default" } = params;
  let { enableAICard = false } = params;

  // 创建日志�?
  const logger: Logger = createLogger("dingtalk", {
    log: params.log,
    error: params.error,
  });

  // 解析消息
  const ctx = parseDingtalkMessage(raw);
  const isGroup = ctx.chatType === "group";

  // 添加详细的原始消息调试日志
  logger.debug(
    `raw message: msgtype=${raw.msgtype}, hasText=${!!raw.text?.content}, hasContent=${!!raw.content}, textContent="${raw.text?.content ?? ""}"`,
  );

  // 对于 richText 消息，输出完整的原始消息结构以便调试
  if (raw.msgtype === "richText") {
    try {
      // 安全地序列化原始消息（排除可能的循环引用）
      const safeRaw = {
        msgtype: raw.msgtype,
        conversationId: raw.conversationId,
        conversationType: raw.conversationType,
        senderId: raw.senderId,
        senderNick: raw.senderNick,
        text: raw.text,
        content: raw.content,
        // 检查是否有其他可能包含文本的字段
        hasRichTextInRoot: "richText" in raw,
        allKeys: Object.keys(raw),
      };
      logger.debug(`[FULL RAW] richText message structure: ${JSON.stringify(safeRaw)}`);
    } catch (e) {
      logger.debug(`[FULL RAW] failed to serialize: ${String(e)}`);
    }
  }

  logger.debug(`received message from ${ctx.senderId} in ${ctx.conversationId} (${ctx.chatType})`);

  // 获取钉钉配置
  const dingtalkCfg = (cfg as Record<string, unknown>)?.channels as
    | Record<string, unknown>
    | undefined;
  const channelCfg = dingtalkCfg?.dingtalk as DingtalkConfig | undefined;

  // 策略检�?
  if (isGroup) {
    const groupPolicy = channelCfg?.groupPolicy ?? "open";
    const groupAllowFrom = channelCfg?.groupAllowFrom ?? [];
    const requireMention = channelCfg?.requireMention ?? true;

    const policyResult = checkGroupPolicy({
      groupPolicy,
      conversationId: ctx.conversationId,
      groupAllowFrom,
      requireMention,
      mentionedBot: ctx.mentionedBot,
    });

    if (!policyResult.allowed) {
      logger.debug(`policy rejected: ${policyResult.reason}`);
      return;
    }
  } else {
    const dmPolicy = channelCfg?.dmPolicy ?? "open";
    const allowFrom = channelCfg?.allowFrom ?? [];

    const policyResult = checkDmPolicy({
      dmPolicy,
      senderId: ctx.senderId,
      allowFrom,
    });

    if (!policyResult.allowed) {
      logger.debug(`policy rejected: ${policyResult.reason}`);
      return;
    }
  }

  // SECURITY FIX: Create a per-request copy of channelCfg to avoid identity bleed.
  // The original code stored operatorUserId in the global channelCfg object,
  // causing all subsequent requests to use the first user's identity.
  let requestChannelCfg = channelCfg;

  // Auto-populate operatorUserId from the inbound senderId only when
  // no operatorUserId is explicitly configured. This respects admin-set
  // service-account identities and avoids an API call per message.
  if (channelCfg && ctx.senderId && !channelCfg.operatorUserId) {
    const cached = getCachedUnionId(ctx.senderId);
    if (cached) {
      requestChannelCfg = { ...channelCfg, operatorUserId: cached };
      logger.debug(`operatorUserId from cache: ${ctx.senderId} → ${cached}`);
    } else {
      const userLookupStart = performance.now();
      try {
        const userDetail = await getUserInfoByStaffId(channelCfg, ctx.senderId);
        const resolvedId = userDetail.unionid ?? ctx.senderId;
        if (userDetail.unionid) {
          setCachedUnionId(ctx.senderId, userDetail.unionid);
        }
        requestChannelCfg = { ...channelCfg, operatorUserId: resolvedId };
        logger.debug(
          `auto-set operatorUserId from senderId: ${ctx.senderId} → unionId: ${resolvedId}`,
        );
      } catch (error) {
        requestChannelCfg = channelCfg;
        logger.warn(
          `operatorUserId lookup failed for ${ctx.senderId}: ${String(error)} — commands requiring user identity will fail`,
        );
      }
      logger.debug(
        `[PERF] getUserInfoByStaffId (operatorUserId lookup): ${(performance.now() - userLookupStart).toFixed(2)}ms`,
      );
    }
  } else if (channelCfg) {
    requestChannelCfg = channelCfg;
  }

  // ===== 群管理命令拦截 =====
  // 在分发到 gateway 之前，检查是否为 /group 命令并直接处理
  if (requestChannelCfg && ctx.content.trim().toLowerCase().startsWith("/group")) {
    const handled = await handleGroupCommand(requestChannelCfg, ctx);
    if (handled) {
      logger.debug("group command handled, skipping gateway dispatch");
      return;
    }
  }

  // ===== 待办命令拦截 =====
  if (requestChannelCfg && ctx.content.trim().toLowerCase().startsWith("/todo")) {
    const handled = await handleTodoCommand(requestChannelCfg, ctx);
    if (handled) {
      logger.debug("todo command handled, skipping gateway dispatch");
      return;
    }
  }

  // ===== 日程命令拦截 =====
  if (requestChannelCfg && ctx.content.trim().toLowerCase().startsWith("/cal")) {
    const handled = await handleCalendarCommand(requestChannelCfg, ctx);
    if (handled) {
      logger.debug("calendar command handled, skipping gateway dispatch");
      return;
    }
  }

  // ===== 文档命令拦截 =====
  if (requestChannelCfg && ctx.content.trim().toLowerCase().startsWith("/doc")) {
    const handled = await handleDocCommand(requestChannelCfg, ctx);
    if (handled) {
      logger.debug("doc command handled, skipping gateway dispatch");
      return;
    }
  }

  // ===== Jarvis 快捷指令拦截 =====
  if (requestChannelCfg && ctx.content.trim().toLowerCase().startsWith("/jarvis")) {
    const handled = await handleJarvisCommand(requestChannelCfg, ctx);
    if (handled) {
      logger.debug("jarvis command handled, skipping gateway dispatch");
      return;
    }
  }

  // ===== 智能异步任务队列处理（贾维斯式多任务并行）=====
  // 初始化任务分类器、任务队列和通知器
  const asyncModeConfig = channelCfg?.asyncMode;
  const asyncModeEnabled = asyncModeConfig?.enabled ?? false;

  // 检查是否为强制异步命令（如 /code, /opencode, /generate, /write, /create, /implement）
  // Keep in sync with TaskClassifier.isCodeGenerationCommand()
  const normalizedCmd = ctx.content.trim().toLowerCase();
  const forceAsyncPrefixes = ["/opencode", "/code", "/generate", "/write", "/create", "/implement"];
  const isForceAsyncCommand = forceAsyncPrefixes.some((prefix) => normalizedCmd.startsWith(prefix));

  // Pre-classify to detect task management commands (status_query / cancel_task)
  // so they can reach the classifier even when async mode is disabled.
  // This fixes the case where a user creates a task via /code (force-async)
  // then sends "任务状态" or "取消任务" which would otherwise skip the classifier gate.
  const preClassifier = new TaskClassifier(asyncModeConfig);
  const preClassification = preClassifier.classify(ctx.content);
  const isTaskManagementCommand =
    preClassification === "status_query" || preClassification === "cancel_task";

  logger.debug(
    `async mode check: enabled=${asyncModeEnabled}, forceAsync=${isForceAsyncCommand}, taskMgmt=${isTaskManagementCommand}, hasAsyncConfig=${!!asyncModeConfig}`,
  );

  if ((asyncModeEnabled || isForceAsyncCommand || isTaskManagementCommand) && channelCfg) {
    const classifier = new TaskClassifier(asyncModeConfig);
    const classification = classifier.classify(ctx.content);
    const persona = JarvisPersona.fromDingtalkConfig(channelCfg);

    // 初始化全局上下文管理器，记录用户消息
    const contextManager = getGlobalContextManager({ maxHistoryPerSession: 50 }, logger);
    const sessionKey = `${ctx.conversationId}:${ctx.senderId}`;
    contextManager.getOrCreateSession(sessionKey, ctx.senderId);
    contextManager.recordMessage(sessionKey, ctx.content);

    logger.debug(
      `task classification: ${classification} for message: "${ctx.content.substring(0, 50)}..."`,
    );

    // ===== 统一意图识别 =====
    // 使用 recognizeIntent() 替代散落的 pausePattern / shouldAppendToActiveCard 判断
    const recognizedIntent =
      classification !== "status_query" && classification !== "cancel_task"
        ? contextManager.recognizeIntent(ctx.content, sessionKey)
        : undefined;

    // 处理暂停/紧急停止意图
    if (
      recognizedIntent &&
      (recognizedIntent.intent === "INTERRUPT_PAUSE" ||
        recognizedIntent.intent === "INTERRUPT_URGENT")
    ) {
      const activeCard = contextManager.getActiveJarvisCard(sessionKey);
      if (activeCard && activeCard.hasActiveTasks()) {
        // 低置信度时先确认
        if (recognizedIntent.needsConfirmation) {
          await sendMessageDingtalk({
            cfg: channelCfg,
            to: isGroup ? ctx.conversationId : ctx.senderId,
            text: "你是想暂停当前任务吗？回复「暂停」确认，或继续输入新任务。",
            chatType: isGroup ? "group" : "direct",
          });
          logger.debug(
            `pause intent needs confirmation, confidence=${recognizedIntent.confidence}`,
          );
          return;
        }

        const pausedCount = activeCard.pausePendingTasks();
        await activeCard.refresh(true);
        const responseText =
          pausedCount > 0
            ? persona.getGreeting().includes("Sir")
              ? `已暂停 ${pausedCount} 个排队中的任务，Sir。正在运行的任务将继续完成。`
              : `已暂停 ${pausedCount} 个排队中的任务。正在运行的任务将继续完成。`
            : "当前没有排队中的任务可以暂停。";
        await sendMessageDingtalk({
          cfg: channelCfg,
          to: isGroup ? ctx.conversationId : ctx.senderId,
          text: responseText,
          chatType: isGroup ? "group" : "direct",
        });
        logger.debug(`pause command handled, paused ${pausedCount} tasks`);
        return;
      }
    }

    // 处理重做意图
    if (recognizedIntent?.intent === "REDO_TASK" && recognizedIntent.relatedSnapshot) {
      const snapshot = recognizedIntent.relatedSnapshot;
      logger.debug(`redo intent detected, replaying task: ${snapshot.description}`);
      // 将快照描述作为新消息重新处理（后续流程会创建新卡片）
      ctx.content = snapshot.description;
    }

    // 处理结果引用意图
    if (recognizedIntent?.intent === "RESULT_REFERENCE") {
      const lastResult = contextManager.getLastTaskResult(sessionKey);
      if (lastResult) {
        await sendMessageDingtalk({
          cfg: channelCfg,
          to: isGroup ? ctx.conversationId : ctx.senderId,
          text: `📋 上次任务「${lastResult.description}」的结果：\n\n${lastResult.result}`,
          chatType: isGroup ? "group" : "direct",
        });
        logger.debug(`result reference handled, task: ${lastResult.taskId}`);
        return;
      }
    }

    // 处理追加任务意图（有活跃卡片且未完成时追加）
    if (recognizedIntent?.intent === "APPEND_TASK") {
      const activeCard = contextManager.getActiveJarvisCard(sessionKey);
      if (activeCard && !activeCard.isCardFinished()) {
        const taskQueue = getGlobalTaskQueue(asyncModeConfig, logger);
        const appendTs = Date.now();
        const appendRnd = Math.random().toString(36).slice(2, 6);
        const appendTaskId = `append_${appendTs}_${appendRnd}`;

        await activeCard.appendTask({
          taskId: appendTaskId,
          description: ctx.content.substring(0, 50),
        });

        const taskRef: { current: ReturnType<typeof taskQueue.addTask> | null } = { current: null };
        const task = taskQueue.addTask({
          type: "message_processing",
          description: ctx.content.substring(0, 100),
          userId: ctx.senderId,
          conversationId: ctx.conversationId,
          async execute(signal: AbortSignal) {
            const currentTask = taskRef.current;
            if (!currentTask) throw new Error("Task reference is null");

            if (signal.aborted) return;

            activeCard.startTask(appendTaskId);
            await activeCard.refresh();

            let lastDeliveredText = "";
            try {
              if (signal.aborted) return;
              const coreProcessStart = performance.now();
              await processDingtalkMessageCore({
                cfg,
                raw,
                accountId,
                enableAICard: false,
                logger,
                suppressDirectReply: true,
                onDeliver: ({ text }) => {
                  if (typeof text === "string" && text.trim()) {
                    lastDeliveredText = text;
                    activeCard.updateTask(appendTaskId, { resultSummary: text.substring(0, 200) });
                    activeCard.refresh().catch((refreshErr) => {
                      logger.warn(
                        `JarvisCard refresh in appended task failed: ${String(refreshErr)}`,
                      );
                    });
                  }
                },
              });
              logger.debug(
                `[PERF] processDingtalkMessageCore (from handleDingtalkMessage): ${(performance.now() - coreProcessStart).toFixed(2)}ms`,
              );
              logger.debug(
                `[PERF] handleDingtalkMessage total: ${(performance.now() - handleStartTime).toFixed(2)}ms`,
              );

              activeCard.completeTask(appendTaskId, persona.getTaskCompleteMessage());
              await activeCard.refresh(true);
              contextManager.recordTaskComplete(
                sessionKey,
                currentTask.id,
                lastDeliveredText.substring(0, 500) || "完成",
              );

              // 检查是否所有任务都已完成
              if (activeCard.areAllTasksDone()) {
                await activeCard.finish();
                contextManager.finishActiveJarvisCard(sessionKey);
              }
            } catch (error) {
              activeCard.failTask(appendTaskId, String(error));
              await activeCard.refresh(true);
              contextManager.recordTaskFail(sessionKey, currentTask.id, String(error));

              if (activeCard.areAllTasksDone()) {
                await activeCard.finish();
                contextManager.finishActiveJarvisCard(sessionKey);
              }
              throw error;
            }
          },
        });

        taskRef.current = task;
        contextManager.recordTaskStart(sessionKey, ctx.senderId, task);
        logger.debug(`appended task ${task.id} to active card in session ${sessionKey}`);
        return;
      }
    }

    // 处理状态查询请求
    if (classification === "status_query") {
      const taskQueue = getGlobalTaskQueue(asyncModeConfig, logger);
      const notifier = new TaskNotifier(
        { enabled: true, mentionOnComplete: true, mentionOnError: true },
        logger,
      );

      // 获取用户的所有任务
      const userTasks = taskQueue.getUserTasks(ctx.senderId);
      await notifier.sendTaskStatusResponse({
        cfg: channelCfg,
        tasks: userTasks,
        conversationId: ctx.conversationId,
        chatType: isGroup ? "group" : "direct",
      });
      logger.debug("status query handled, skipping gateway dispatch");
      return;
    }

    // 处理取消任务请求
    if (classification === "cancel_task") {
      const taskQueue = getGlobalTaskQueue(asyncModeConfig, logger);
      const notifier = new TaskNotifier(
        { enabled: true, mentionOnComplete: true, mentionOnError: true },
        logger,
      );

      // 检查消息内容以确定是取消特定任务还是取消所有任务
      const normalizedContent = ctx.content.toLowerCase();
      const isCancelAll =
        /\u53d6\u6d88\u6240\u6709|\u505c\u6b62\u6240\u6709|\u5168\u90e8\u53d6\u6d88|\u5168\u90e8\u505c\u6b62/.test(
          normalizedContent,
        );

      if (isCancelAll) {
        const cancelledCount = taskQueue.cancelUserTasks(ctx.senderId);
        await notifier.sendBatchCancelConfirmation({
          cfg: channelCfg,
          count: cancelledCount,
          conversationId: ctx.conversationId,
          chatType: isGroup ? "group" : "direct",
        });
        logger.debug(`cancelled ${cancelledCount} tasks for user ${ctx.senderId}`);
      } else {
        // 尝试从消息中提取任务ID
        const taskIdMatch = normalizedContent.match(/#?([a-zA-Z0-9-]+)/);
        if (taskIdMatch) {
          const taskId = taskIdMatch[1];
          const cancelled = taskQueue.cancelTask(taskId);
          if (cancelled) {
            // 获取已取消的任务信息
            const userTasks = taskQueue.getUserTasks(ctx.senderId);
            const cancelledTask = userTasks.find((t) => t.id === taskId);
            if (cancelledTask) {
              await notifier.notifyTaskCancelled({
                cfg: channelCfg,
                task: cancelledTask,
                chatType: isGroup ? "group" : "direct",
              });
            }
            logger.debug(`cancel task ${taskId} result: ${cancelled}`);
          } else {
            await sendMessageDingtalk({
              cfg: channelCfg,
              to: isGroup ? ctx.conversationId : ctx.senderId,
              text: `\u672a\u627e\u5230\u4efb\u52a1 #${taskId}\uff0c\u53ef\u80fd\u5df2\u5b8c\u6210\u6216\u4e0d\u5b58\u5728`,
              chatType: isGroup ? "group" : "direct",
            });
          }
        } else {
          // 没有指定任务ID，取消用户最新的任务
          const userTasks = taskQueue.getUserTasks(ctx.senderId);
          const runningTask = userTasks.find((t) => t.status === "running");
          const pendingTask = userTasks.find((t) => t.status === "pending");

          const targetTask = runningTask || pendingTask;
          if (targetTask) {
            const cancelled = taskQueue.cancelTask(targetTask.id);
            if (cancelled) {
              await notifier.notifyTaskCancelled({
                cfg: channelCfg,
                task: targetTask,
                chatType: isGroup ? "group" : "direct",
              });
            }
            logger.debug(`cancel latest task ${targetTask.id} result: ${cancelled}`);
          } else {
            await sendMessageDingtalk({
              cfg: channelCfg,
              to: isGroup ? ctx.conversationId : ctx.senderId,
              text: "\u6ca1\u6709\u627e\u5230\u53ef\u53d6\u6d88\u7684\u4efb\u52a1",
              chatType: isGroup ? "group" : "direct",
            });
          }
        }
      }
      logger.debug("cancel task handled, skipping gateway dispatch");
      return;
    }

    // 处理异步任务
    if (classification === "async") {
      const taskQueue = getGlobalTaskQueue(asyncModeConfig, logger);

      // 立即发送确认消息，不阻塞后续消息处理
      await sendMessageDingtalk({
        cfg: channelCfg,
        to: isGroup ? ctx.conversationId : ctx.senderId,
        text: "✅ 任务已提交，正在处理中... 您可以继续发送其他消息。",
        chatType: isGroup ? "group" : "direct",
      });

      // 使用 setImmediate 将卡片创建和任务执行逻辑推迟到事件循环的下一个微任务
      // 这样 handleDingtalkMessage 可以立即返回，不阻塞后续消息接收
      setImmediate(async () => {
        // 创建单任务模式 JarvisCard
        const jarvisCard = new JarvisCard(
          {
            title: persona.getCardTitle(false),
            minRefreshIntervalMs: 800,
          },
          logger,
        );

        const cardCreated = await jarvisCard.create({
          cfg: channelCfg,
          conversationType: isGroup ? "2" : "1",
          conversationId: ctx.conversationId,
          senderId: ctx.senderId,
          initialTasks: [{ taskId: "main", description: ctx.content.substring(0, 50) }],
        });

        if (cardCreated) {
          registerActiveCard(ctx.conversationId, jarvisCard);
          contextManager.setActiveJarvisCard(sessionKey, ctx.senderId, jarvisCard);
          logger.debug("[JarvisCard] Single-task card created for normal classification");
        }

        const task = taskQueue.addTask({
          type: "message_processing",
          description: ctx.content.substring(0, 100),
          userId: ctx.senderId,
          conversationId: ctx.conversationId,
          async execute(signal: AbortSignal) {
            logger.debug(
              `[AsyncTask] Starting execution for user ${ctx.senderId}, task ${task.id}`,
            );

            if (signal.aborted) return;

            if (cardCreated) {
              jarvisCard.startTask("main");
              await jarvisCard.refresh();
              logger.debug("[AsyncTask] Task started and card refreshed");
            }

            let lastDeliveredText = "";
            let executionError: Error | null = null;

            try {
              if (signal.aborted) return;
              logger.debug("[AsyncTask] Calling processDingtalkMessageCore...");
              await processDingtalkMessageCore({
                cfg,
                raw,
                accountId,
                enableAICard: !cardCreated && enableAICard,
                logger,
                suppressDirectReply: cardCreated,
                onDeliver: cardCreated
                  ? ({ text }) => {
                      if (typeof text === "string" && text.trim()) {
                        lastDeliveredText = text;
                        jarvisCard.updateTask("main", { resultSummary: text.substring(0, 200) });
                        jarvisCard.refresh().catch((refreshErr) => {
                          logger.warn(
                            `JarvisCard refresh in onDeliver failed: ${String(refreshErr)}`,
                          );
                        });
                      }
                    }
                  : undefined,
              });
              logger.debug("[AsyncTask] processDingtalkMessageCore completed successfully");

              if (cardCreated) {
                jarvisCard.completeTask("main", persona.getTaskCompleteMessage());
                logger.debug("[AsyncTask] Task marked as complete");
              }
              contextManager.recordTaskComplete(
                sessionKey,
                task.id,
                lastDeliveredText.substring(0, 500) || "完成",
              );
            } catch (error) {
              executionError = error instanceof Error ? error : new Error(String(error));
              logger.error(`[AsyncTask] Task execution failed: ${executionError.message}`);

              if (cardCreated) {
                jarvisCard.failTask("main", executionError.message);
                logger.debug("[AsyncTask] Task marked as failed");
              }
              contextManager.recordTaskFail(sessionKey, task.id, executionError.message);
              throw executionError;
            } finally {
              // 确保 finish() 总是被调用，即使出错
              if (cardCreated) {
                try {
                  await jarvisCard.finish();
                  logger.debug("[AsyncTask] Card finished successfully");
                } catch (finishError) {
                  logger.error(`[AsyncTask] Failed to finish card: ${String(finishError)}`);
                }
              }
              contextManager.finishActiveJarvisCard(sessionKey);
              logger.debug("[AsyncTask] Active JarvisCard finished");
            }
          },
        });

        logger.debug(`[AsyncTask] Task ${task.id} submitted to queue`);
      });

      logger.debug(
        `[AsyncTask] Task submitted to queue, handleDingtalkMessage returning immediately`,
      );
      return;
    }

    // 处理异步任务（else 分支 - 慢任务）
    else {
      // 确保 channelCfg 存在
      if (!channelCfg) {
        logger.error("channelCfg is undefined, cannot process slow task");
        return;
      }

      const taskQueue = getGlobalTaskQueue(asyncModeConfig, logger);
      const notifier = new TaskNotifier(
        { enabled: true, mentionOnComplete: true, mentionOnError: true },
        logger,
      );

      // 使用入口处已初始化的全局 contextManager 和 sessionKey

      // 解析多任务
      const multiTaskParser = new MultiTaskParser();
      const parseResult = multiTaskParser.parse(ctx.content);

      // 检查是否有自然语言任务引用
      const taskReference = contextManager.parseTaskReference(ctx.content, ctx.senderId);

      let tasksToProcess: Array<{
        description: string;
        priority?: number;
        estimatedDuration?: number;
      }> = [];

      if (parseResult.hasMultipleTasks && parseResult.tasks.length > 1) {
        // 多任务模式：并行启动所有任务
        logger.debug(`detected multi-task request with ${parseResult.tasks.length} tasks`);
        tasksToProcess = parseResult.tasks.map((t) => ({
          description: t.description,
        }));
      } else if (taskReference && taskReference.length > 0) {
        // 任务引用模式：用户引用了之前的任务
        logger.debug(`detected task reference: ${taskReference[0].type}`);
        tasksToProcess = [{ description: ctx.content }];
      } else {
        // 单任务模式
        tasksToProcess = [{ description: ctx.content }];
      }

      // 立即发送确认消息，不阻塞后续消息处理
      const taskCountText = tasksToProcess.length > 1 ? `${tasksToProcess.length} 个任务` : "任务";
      await sendMessageDingtalk({
        cfg: channelCfg,
        to: isGroup ? ctx.conversationId : ctx.senderId,
        text: `✅ ${taskCountText}已提交，正在处理中... 您可以继续发送其他消息。`,
        chatType: isGroup ? "group" : "direct",
      });

      // 使用 setImmediate 将卡片创建和任务执行逻辑推迟到事件循环的下一个微任务
      // 这样 handleDingtalkMessage 可以立即返回，不阻塞后续消息接收
      setImmediate(async () => {
        // ===== JarvisCard 统一任务面板（替代 MultiTaskCardManager + TaskNotifier 双轨制）=====
        const jarvisCard = new JarvisCard(
          {
            title: persona.getCardTitle(parseResult.hasMultipleTasks),
            minRefreshIntervalMs: 800,
          },
          logger,
        );

        // 准备初始任务列表
        const initialTasks = tasksToProcess.map((taskInfo, index) => ({
          taskId: `pending_${index}`,
          description: taskInfo.description.substring(0, 50),
        }));

        // 创建卡片（阻塞等待，确保卡片就绪后再提交任务）
        const cardCreated = await jarvisCard.create({
          cfg: channelCfg,
          conversationType: isGroup ? "2" : "1",
          conversationId: ctx.conversationId,
          senderId: ctx.senderId,
          initialTasks,
        });

        if (cardCreated) {
          // 注册到活跃卡片表，供回调路由查找
          registerActiveCard(ctx.conversationId, jarvisCard);
          contextManager.setActiveJarvisCard(sessionKey, ctx.senderId, jarvisCard);
          logger.debug("[JarvisCard] Card created and registered as active");
        } else {
          // 卡片创建失败，降级为 TaskNotifier 文本通知
          logger.warn("[JarvisCard] Card creation failed, falling back to TaskNotifier");
        }

        // Pre-build task descriptors so the submittedTasks array is fully
        // populated before any execute() callback can run. This prevents the
        // "allDone" check from seeing an empty array and finishing the card
        // prematurely (race condition: addTask triggers processQueue which
        // may start executing before the loop pushes to submittedTasks).
        const totalTaskCount = tasksToProcess.length;
        const submittedTasks: Array<{ id: string; description: string }> = [];

        for (let taskIndex = 0; taskIndex < totalTaskCount; taskIndex++) {
          const taskInfo = tasksToProcess[taskIndex];
          const capturedIndex = taskIndex;
          // 使用 taskRef 来在 execute() 中访问任务对象，避免闭包捕获问题
          const taskRef: { current: ReturnType<typeof taskQueue.addTask> | null } = {
            current: null,
          };
          const task = taskQueue.addTask({
            type: "message_processing",
            description: taskInfo.description.substring(0, 100),
            userId: ctx.senderId,
            conversationId: ctx.conversationId,
            async execute(signal: AbortSignal) {
              // 使用 taskRef.current 来访问任务对象
              // 注意：async-task-queue.ts 已使用 setImmediate 延迟 processQueue 执行，
              // 确保 taskRef.current = task 在 execute() 被调用前完成
              const currentTask = taskRef.current;
              if (!currentTask) {
                logger.error(`[AsyncTask] Task reference is null in execute()`);
                throw new Error("Task reference is null");
              }
              if (signal.aborted) return;
              logger.debug(`executing async task ${currentTask.id} for user ${ctx.senderId}`);

              // 更新 JarvisCard 任务状态为 running
              if (cardCreated) {
                jarvisCard.startTask(`pending_${capturedIndex}`);
                await jarvisCard.refresh();
              }

              let lastDeliveredText = "";
              try {
                // 调用核心处理逻辑，通过 onDeliver 将 LLM 输出转发到 JarvisCard
                await processDingtalkMessageCore({
                  cfg,
                  raw: { ...raw, text: { content: taskInfo.description } },
                  accountId,
                  enableAICard: !cardCreated && enableAICard,
                  logger,
                  suppressDirectReply: cardCreated,
                  onDeliver: cardCreated
                    ? ({ text }) => {
                        if (typeof text === "string" && text.trim()) {
                          lastDeliveredText = text;
                          jarvisCard.updateTask(`pending_${capturedIndex}`, {
                            resultSummary: text.substring(0, 200),
                          });
                          jarvisCard.refresh().catch((refreshErr) => {
                            logger.warn(
                              `JarvisCard refresh in onDeliver failed: ${String(refreshErr)}`,
                            );
                          });
                        }
                      }
                    : undefined,
                });

                // 标记任务完成（在 JarvisCard 上）
                if (cardCreated) {
                  jarvisCard.completeTask(`pending_${capturedIndex}`, "完成");
                  await jarvisCard.refresh(true);
                }

                // 记录到任务历史（保存实际结果摘要）
                contextManager.recordTaskComplete(
                  sessionKey,
                  currentTask.id,
                  lastDeliveredText.substring(0, 500) || "完成",
                );

                // 检查是否所有任务都已完成，如果是则 finish 卡片
                if (cardCreated) {
                  // Guard: only check when we know the full task list is ready
                  if (submittedTasks.length === totalTaskCount) {
                    const allDone = submittedTasks.every((submitted) => {
                      const queuedTask = taskQueue.getTask(submitted.id);
                      return (
                        queuedTask &&
                        (queuedTask.status === "completed" ||
                          queuedTask.status === "failed" ||
                          queuedTask.status === "cancelled")
                      );
                    });
                    if (allDone) {
                      await jarvisCard.finish();
                      contextManager.finishActiveJarvisCard(sessionKey);
                    }
                  }
                }
              } catch (error) {
                // 标记任务失败（在 JarvisCard 上）
                if (cardCreated) {
                  jarvisCard.failTask(`pending_${capturedIndex}`, String(error));
                  await jarvisCard.refresh(true);
                } else {
                  // 降级：用 TaskNotifier 发送失败通知
                  await notifier.notifyTaskFailed?.({
                    cfg: channelCfg,
                    task: currentTask,
                    error: String(error),
                    chatType: isGroup ? "group" : "direct",
                  });
                }

                contextManager.recordTaskFail(sessionKey, currentTask.id, String(error));

                // Check allDone even on failure so the card finishes properly
                if (cardCreated && submittedTasks.length === totalTaskCount) {
                  const allDone = submittedTasks.every((submitted) => {
                    const queuedTask = taskQueue.getTask(submitted.id);
                    return (
                      queuedTask &&
                      (queuedTask.status === "completed" ||
                        queuedTask.status === "failed" ||
                        queuedTask.status === "cancelled")
                    );
                  });
                  if (allDone) {
                    await jarvisCard.finish();
                    contextManager.finishActiveJarvisCard(sessionKey);
                  }
                }

                throw error;
              }
            },
          });

          // 设置 taskRef，使 execute() 中可以访问到任务对象
          taskRef.current = task;
          submittedTasks.push({ id: task.id, description: taskInfo.description });
          logger.debug(`submitted task ${task.id}: ${taskInfo.description.substring(0, 50)}`);
        }

        // 如果卡片创建失败，降级使用 TaskNotifier 发送提交通知
        if (!cardCreated) {
          setImmediate(() => {
            if (submittedTasks.length > 1) {
              const fullTasks = submittedTasks
                .map((st) => taskQueue.getTask(st.id))
                .filter((t): t is AsyncTask => t != null);
              void notifier
                .notifyMultiTaskStarted({
                  cfg: channelCfg,
                  tasks: fullTasks,
                  chatType: isGroup ? "group" : "direct",
                  conversationId: ctx.conversationId,
                  senderId: ctx.senderId,
                })
                .catch((err) => {
                  logger.error(`failed to send multi-task started notification: ${String(err)}`);
                });
            } else {
              const singleTask = taskQueue.getTask(submittedTasks[0].id);
              if (singleTask) {
                void notifier
                  .notifyTaskSubmitted({
                    cfg: channelCfg,
                    task: singleTask,
                    chatType: isGroup ? "group" : "direct",
                    queuePosition: taskQueue.getStats().pending,
                    senderId: ctx.senderId,
                  })
                  .catch((err) => {
                    logger.error(`failed to send task submitted notification: ${String(err)}`);
                  });
              }
            }
          });
        }

        logger.debug(
          `submitted ${submittedTasks.length} tasks, multi-task mode: ${parseResult.hasMultipleTasks}`,
        );
      });

      logger.debug(`slow tasks submitted to queue, handleDingtalkMessage returning immediately`);
      return;
    }

    // instant 分类 - 直接同步执行，不创建 AI Card（减少视觉噪音）
    logger.debug(
      `instant task (classification=${classification}), processing synchronously without AI Card`,
    );
  }

  // 检查运行时是否已初始化
  const runtimeCheckStart = performance.now();
  if (!isDingtalkRuntimeInitialized()) {
    logger.warn("runtime not initialized, skipping dispatch");
    return;
  }
  logger.debug(
    `[PERF] isDingtalkRuntimeInitialized check: ${(performance.now() - runtimeCheckStart).toFixed(2)}ms`,
  );

  // ===== 媒体消息处理变量 (�?try 块外声明以便 catch 块访�? =====
  let downloadedMedia: DownloadedFile | null = null;
  let downloadedRichTextImages: DownloadedFile[] = [];
  let extractedFileInfo: ExtractedFileInfo | null = null;

  try {
    // [PERF] 获取完整�?Moltbot 运行时（包含 core API�?
    const runtimeStart = performance.now();
    const core = getDingtalkRuntime();
    logger.debug(`[PERF] getDingtalkRuntime: ${(performance.now() - runtimeStart).toFixed(2)}ms`);
    const coreRecord = core as Record<string, unknown>;
    const coreChannel = coreRecord?.channel as Record<string, unknown> | undefined;
    const replyApi = coreChannel?.reply as Record<string, unknown> | undefined;
    const routingApi = coreChannel?.routing as Record<string, unknown> | undefined;

    // 检查必要的 API 是否存在
    if (!routingApi?.resolveAgentRoute) {
      logger.debug("core.channel.routing.resolveAgentRoute not available, skipping dispatch");
      return;
    }

    if (!replyApi?.dispatchReplyFromConfig) {
      logger.debug("core.channel.reply.dispatchReplyFromConfig not available, skipping dispatch");
      return;
    }

    if (!replyApi?.createReplyDispatcher && !replyApi?.createReplyDispatcherWithTyping) {
      logger.debug("core.channel.reply dispatcher factory not available, skipping dispatch");
      return;
    }

    // 解析路由
    const routeStart = performance.now();
    const resolveAgentRoute = routingApi.resolveAgentRoute as (
      opts: Record<string, unknown>,
    ) => Record<string, unknown>;
    const route = resolveAgentRoute({
      cfg,
      channel: "dingtalk",
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup ? ctx.conversationId : ctx.senderId,
      },
    });
    logger.debug(`[PERF] resolveAgentRoute: ${(performance.now() - routeStart).toFixed(2)}ms`);

    // ===== 媒体消息处理 (Requirements 9.1, 9.2, 9.4, 9.6) =====
    // 用于存储下载的媒体文件信�?
    let mediaBody: string | null = null;
    let richTextParseResult: ReturnType<typeof parseRichTextMessage> = null;

    // 检测并处理媒体消息类型 (picture, video, audio, file)
    // 语音消息：如果钉钉已提供 recognition 文本，跳过下载，直接当文本处理
    const audioHasRecognition =
      raw.msgtype === "audio" && ctx.content !== "" && ctx.content !== "[语音消息]";
    const mediaTypes: MediaMsgType[] = ["picture", "video", "audio", "file"];
    if (audioHasRecognition) {
      logger.debug(`audio message has recognition text, skipping file download: "${ctx.content}"`);
    }
    if (mediaTypes.includes(raw.msgtype as MediaMsgType) && !audioHasRecognition) {
      try {
        // 提取文件信息 (Requirement 9.1)
        extractedFileInfo = extractFileFromMessage(raw);

        if (extractedFileInfo && channelCfg?.clientId && channelCfg?.clientSecret) {
          // 获取 access token (Requirement 9.6)
          const accessToken = await getAccessToken(channelCfg.clientId, channelCfg.clientSecret);

          // 下载文件 (Requirement 9.2)
          downloadedMedia = await downloadDingTalkFile({
            downloadCode: extractedFileInfo.downloadCode,
            robotCode: channelCfg.clientId,
            accessToken,
            fileName: extractedFileInfo.fileName,
            msgType: extractedFileInfo.msgType,
            log: logger,
            maxFileSizeMB: channelCfg.maxFileSizeMB,
          });

          logger.debug(
            `downloaded media file: ${downloadedMedia.path} (${downloadedMedia.size} bytes)`,
          );

          // 构建消息正文 (Requirement 9.5)
          mediaBody = buildFileContextMessage(
            extractedFileInfo.msgType,
            extractedFileInfo.fileName,
          );
        }
      } catch (err) {
        // 优雅降级：记录警告并继续处理文本内容 (Requirement 9.4)
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn(`media download failed, continuing with text: ${errorMessage}`);
        downloadedMedia = null;
        extractedFileInfo = null;
      }
    }

    // ===== richText 消息处理 (Requirements 9.3, 3.6) =====
    if (raw.msgtype === "richText") {
      try {
        // 解析 richText 消息
        richTextParseResult = parseRichTextMessage(raw);

        if (richTextParseResult && channelCfg?.clientId && channelCfg?.clientSecret) {
          // 检查是否有图片需要下�?(Requirement 3.6)
          if (richTextParseResult.imageCodes.length > 0) {
            // 获取 access token
            const accessToken = await getAccessToken(channelCfg.clientId, channelCfg.clientSecret);

            // 批量下载图片
            downloadedRichTextImages = await downloadRichTextImages({
              imageCodes: richTextParseResult.imageCodes,
              robotCode: channelCfg.clientId,
              accessToken,
              log: logger,
              maxFileSizeMB: channelCfg.maxFileSizeMB,
            });

            logger.debug(
              `downloaded ${downloadedRichTextImages.length}/${richTextParseResult.imageCodes.length} richText images`,
            );
          }

          const orderedLines: string[] = [];
          const imageQueue = [...downloadedRichTextImages];

          for (const element of richTextParseResult.elements ?? []) {
            if (!element) continue;
            if (element.type === "picture") {
              const file = imageQueue.shift();
              orderedLines.push(file?.path ?? "[图片]");
              continue;
            }
            if (element.type === "text" && typeof element.text === "string") {
              orderedLines.push(element.text);
              continue;
            }
            if (element.type === "at" && typeof element.userId === "string") {
              orderedLines.push(`@${element.userId}`);
              continue;
            }
          }

          if (orderedLines.length > 0) {
            mediaBody = orderedLines.join("\n");
          } else if (richTextParseResult.textParts.length > 0) {
            mediaBody = richTextParseResult.textParts.join("\n");
          } else if (downloadedRichTextImages.length > 0) {
            // 兜底：如果只有图片没有文本，设置为图片描述
            mediaBody =
              downloadedRichTextImages.length === 1
                ? "[图片]"
                : `[${downloadedRichTextImages.length}张图片]`;
          }
        }
      } catch (err) {
        // 优雅降级：记录警告并继续处理
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn(`richText processing failed: ${errorMessage}`);
        richTextParseResult = null;
        downloadedRichTextImages = [];
      }
    }

    // 构建入站上下�?
    const inboundCtx = buildInboundContext(
      ctx,
      (route as Record<string, unknown>)?.sessionKey as string,
      (route as Record<string, unknown>)?.accountId as string,
    );

    // 设置媒体相关字段 (Requirements 7.1-7.8)
    if (downloadedMedia) {
      inboundCtx.MediaPath = downloadedMedia.path;
      inboundCtx.MediaType = downloadedMedia.contentType;

      // 设置消息正文为媒体描�?
      if (mediaBody) {
        inboundCtx.Body = mediaBody;
        inboundCtx.RawBody = mediaBody;
        inboundCtx.CommandBody = mediaBody;
      }

      // 文件消息特有字段
      if (extractedFileInfo?.msgType === "file") {
        if (extractedFileInfo.fileName) {
          inboundCtx.FileName = extractedFileInfo.fileName;
        }
        if (extractedFileInfo.fileSize !== undefined) {
          inboundCtx.FileSize = extractedFileInfo.fileSize;
        }
      }

      // 音频消息的语音识别文�?
      if (extractedFileInfo?.msgType === "audio" && extractedFileInfo.recognition) {
        inboundCtx.Transcript = extractedFileInfo.recognition;
      }
    }

    // 设置 richText 消息的媒体字�?(Requirements 7.3, 7.4)
    if (downloadedRichTextImages.length > 0) {
      inboundCtx.MediaPaths = downloadedRichTextImages.map((f) => f.path);
      inboundCtx.MediaTypes = downloadedRichTextImages.map((f) => f.contentType);

      // 设置消息正文
      if (mediaBody) {
        inboundCtx.Body = mediaBody;
        inboundCtx.RawBody = mediaBody;
        inboundCtx.CommandBody = mediaBody;
      }
    } else if (richTextParseResult && richTextParseResult.textParts.length > 0) {
      // 纯文�?richText 消息 (Requirement 3.6)
      // 不设�?MediaPath/MediaType，只设置 Body
      const textBody = richTextParseResult.textParts.join("\n");
      inboundCtx.Body = textBody;
      inboundCtx.RawBody = textBody;
      inboundCtx.CommandBody = textBody;
    }

    // 如果�?finalizeInboundContext，使用它
    const finalizeInboundContext = replyApi?.finalizeInboundContext as
      | ((ctx: InboundContext) => InboundContext)
      | undefined;
    const finalCtx = finalizeInboundContext ? finalizeInboundContext(inboundCtx) : inboundCtx;

    // Inject a timestamp prefix so the agent knows the current date/time.
    // Core channels get this via gateway handler; plugins must do it themselves.
    // DingTalk users are in China, so default to Asia/Shanghai.
    if (finalCtx.Body && finalCtx.Body.trim()) {
      const timestampEnvelopePattern = /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
      if (!timestampEnvelopePattern.test(finalCtx.Body)) {
        const timezone = "Asia/Shanghai";
        const now = new Date();
        const dow = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          weekday: "short",
        }).format(now);
        const formatted = new Intl.DateTimeFormat("en-CA", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
          .format(now)
          .replace(",", "");
        finalCtx.Body = `[${dow} ${formatted} CST] ${finalCtx.Body}`;
        logger.debug(`injected timestamp into message body: [${dow} ${formatted} CST]`);
      }
    }

    const dingtalkCfgResolved = channelCfg;
    if (!dingtalkCfgResolved) {
      logger.warn("channel config missing, skipping dispatch");
      return;
    }

    // ===== AI Card 准备（如果启用）=====
    let aiCard: AICardInstance | null = null;
    if (enableAICard) {
      const aiCardStart = performance.now();
      aiCard = await createAICard({
        cfg: dingtalkCfgResolved,
        conversationType: ctx.chatType === "group" ? "2" : "1",
        conversationId: ctx.conversationId,
        senderId: ctx.senderId,
        senderStaffId: raw.senderStaffId,
        log: (msg) => logger.debug(msg),
      });
      logger.debug(`[PERF] createAICard: ${(performance.now() - aiCardStart).toFixed(2)}ms`);

      if (aiCard) {
        logger.info("AI Card created, will update via dispatch deliver");
      } else {
        logger.warn("AI Card creation failed, falling back to normal message");
      }
    }

    // ===== 普通消息模�?=====
    const textApi = coreChannel?.text as Record<string, unknown> | undefined;

    const textChunkLimitResolved =
      (textApi?.resolveTextChunkLimit as ((opts: Record<string, unknown>) => number) | undefined)?.(
        {
          cfg,
          channel: "dingtalk",
          defaultLimit: dingtalkCfgResolved.textChunkLimit ?? 4000,
        },
      ) ??
      dingtalkCfgResolved.textChunkLimit ??
      4000;
    const chunkMode = (
      textApi?.resolveChunkMode as ((cfg: unknown, channel: string) => unknown) | undefined
    )?.(cfg, "dingtalk");
    const tableMode = "bullets";

    const deliver = async (
      payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
      info?: { kind?: string },
    ) => {
      if (replyFinalOnly && (!info || info.kind !== "final")) {
        return false;
      }
      logger.debug(
        `[reply] payload=${JSON.stringify({
          hasText: typeof payload.text === "string",
          text: payload.text,
          mediaUrl: payload.mediaUrl,
          mediaUrls: payload.mediaUrls,
        })}`,
      );
      const targetId = isGroup ? ctx.conversationId : ctx.senderId;
      const chatType = isGroup ? "group" : "direct";
      let sent = false;

      // AI Card 模式：流式更新卡片内容
      let aiCardHandledText = false;
      if (aiCard && typeof payload.text === "string" && payload.text.trim()) {
        try {
          if (info?.kind === "final") {
            await finishAICard(aiCard, payload.text, (msg) => logger.debug(msg));
            logger.info(`AI Card finished with ${payload.text.length} chars`);
          } else {
            await streamAICard(aiCard, payload.text, false, (msg) => logger.debug(msg));
            logger.debug(`AI Card streamed ${payload.text.length} chars`);
          }
          sent = true;
          aiCardHandledText = true;
        } catch (cardErr) {
          // Retry once before giving up — avoid mixing card + plain message formats
          logger.warn(`AI Card update failed (attempt 1/2), retrying: ${String(cardErr)}`);
          try {
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (info?.kind === "final") {
              await finishAICard(aiCard, payload.text, (msg) => logger.debug(msg));
              logger.info(`AI Card finished on retry with ${payload.text.length} chars`);
            } else {
              await streamAICard(aiCard, payload.text, false, (msg) => logger.debug(msg));
              logger.debug(`AI Card streamed on retry ${payload.text.length} chars`);
            }
            sent = true;
            aiCardHandledText = true;
          } catch (retryErr) {
            // All retries exhausted: nullify aiCard so subsequent deliver calls
            // fall through to plain text consistently (no more mixed formats)
            logger.warn(
              `AI Card update failed after 2 attempts, disabling card for this session: ${String(retryErr)}`,
            );
            aiCard = null;
          }
        }
      }

      const sendMediaWithFallback = async (mediaUrl: string): Promise<void> => {
        try {
          await sendMediaDingtalk({
            cfg: dingtalkCfgResolved,
            to: targetId,
            mediaUrl,
            chatType,
          });
          sent = true;
        } catch (err) {
          logger.error(`[reply] sendMediaDingtalk failed: ${String(err)}`);
          const fallbackText = `📎 ${mediaUrl}`;
          await sendMessageDingtalk({
            cfg: dingtalkCfgResolved,
            to: targetId,
            text: fallbackText,
            chatType,
          });
          sent = true;
        }
      };

      const payloadMediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
      const rawText = payload.text ?? "";
      const { mediaUrls: mediaFromLines } = extractMediaLinesFromText({
        text: rawText,
        logger,
      });
      const { mediaUrls: localMediaFromText } = extractLocalMediaFromText({
        text: rawText,
        logger,
      });

      const mediaQueue: string[] = [];
      const seenMedia = new Set<string>();
      const addMedia = (value?: string) => {
        const trimmed = value?.trim();
        if (!trimmed) return;
        if (seenMedia.has(trimmed)) return;
        seenMedia.add(trimmed);
        mediaQueue.push(trimmed);
      };

      for (const url of payloadMediaUrls) addMedia(url);
      for (const url of mediaFromLines) addMedia(url);
      for (const url of localMediaFromText) addMedia(url);

      const converted =
        (textApi?.convertMarkdownTables as ((text: string, mode: string) => string) | undefined)?.(
          rawText,
          tableMode,
        ) ?? rawText;

      const hasText = converted.trim().length > 0;
      if (hasText && !aiCardHandledText) {
        const chunks =
          textApi?.chunkTextWithMode &&
          typeof textChunkLimitResolved === "number" &&
          textChunkLimitResolved > 0
            ? (
                textApi.chunkTextWithMode as (
                  text: string,
                  limit: number,
                  mode: unknown,
                ) => string[]
              )(converted, textChunkLimitResolved, chunkMode)
            : [converted];

        for (const chunk of chunks) {
          await sendMessageDingtalk({
            cfg: dingtalkCfgResolved,
            to: targetId,
            text: chunk,
            chatType,
          });
          sent = true;
        }
      }

      for (const mediaUrl of mediaQueue) {
        await sendMediaWithFallback(mediaUrl);
      }

      if (!hasText && mediaQueue.length === 0) {
        return false;
      }
      return sent;
    };

    const replyFinalOnly = dingtalkCfgResolved.replyFinalOnly === true;
    const deliverFinalOnly = async (
      payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
      info?: { kind?: string },
    ): Promise<boolean> => {
      return await deliver(payload, info);
    };

    const humanDelay = (
      replyApi?.resolveHumanDelayConfig as ((cfg: unknown, agentId?: string) => unknown) | undefined
    )?.(cfg, (route as Record<string, unknown>)?.agentId as string | undefined);

    const createDispatcherWithTyping = replyApi?.createReplyDispatcherWithTyping as
      | ((opts: Record<string, unknown>) => Record<string, unknown>)
      | undefined;
    const createDispatcher = replyApi?.createReplyDispatcher as
      | ((opts: Record<string, unknown>) => Record<string, unknown>)
      | undefined;

    const dispatchReplyWithBufferedBlockDispatcher =
      replyApi?.dispatchReplyWithBufferedBlockDispatcher as
        | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
        | undefined;

    if (dispatchReplyWithBufferedBlockDispatcher) {
      logger.debug(
        `dispatching to agent (buffered, session=${(route as Record<string, unknown>)?.sessionKey})`,
      );
      const dispatchStart = performance.now();
      const deliveryState = { delivered: false, skippedNonSilent: 0 };
      // Track whether the AI Card received a proper "final" finish call.
      // Intermediate stream updates set delivered=true but the card stays
      // in INPUTING state until finishAICard is called. When the agent's
      // final reply is skipped (e.g. concurrent message preemption), we
      // must finish the card with the last streamed content so it doesn't
      // stay stuck showing "···".
      let aiCardFinished = false;
      let accumulatedCardText = "";
      const buffered = {
        lastText: "",
        mediaUrls: [] as string[],
        hasPayload: false,
      };
      const addBufferedMedia = (value?: string) => {
        const trimmed = value?.trim();
        if (!trimmed) return;
        if (buffered.mediaUrls.includes(trimmed)) return;
        buffered.mediaUrls.push(trimmed);
      };
      // When AI Card streaming is active, inject low block streaming thresholds
      // so even short replies trigger intermediate block updates.
      // Default minChars=800 is too high for AI Card's replace-style updates.
      const useAiCardStreaming = !replyFinalOnly && !!aiCard;
      const dispatchCfg = useAiCardStreaming
        ? injectBlockStreamingDefaults(cfg, {
            blockStreamingChunk: { minChars: 1, maxChars: 4000, breakPreference: "newline" },
            blockStreamingCoalesce: { minChars: 1, maxChars: 4000, idleMs: 300 },
          })
        : cfg;
      const result = await dispatchReplyWithBufferedBlockDispatcher({
        ctx: finalCtx,
        cfg: dispatchCfg,
        dispatcherOptions: {
          deliver: async (payload: unknown, info?: { kind?: string }) => {
            // AI Card 流式模式：中间回复流式更新卡片，final 完成卡片
            if (!replyFinalOnly && aiCard) {
              const typed = payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] };
              if (typeof typed.text === "string" && typed.text.trim()) {
                try {
                  if (info?.kind === "final") {
                    await finishAICard(aiCard, typed.text, (msg) => logger.debug(msg));
                    logger.info(`AI Card finished with ${typed.text.length} chars (buffered)`);
                    aiCardFinished = true;
                  } else {
                    // Block streaming chunks are already complete text segments;
                    // AI Card uses isFull=true (full replacement), so we accumulate.
                    // Collapse any residual "\n\n" coalescer joiners at the boundary
                    // between the existing accumulated text and the new chunk, so
                    // preprocessDingtalkMarkdown can merge soft breaks correctly
                    // (DingTalk renders every \n as a real line break).
                    accumulatedCardText = accumulatedCardText
                      ? collapseCoalescerJoiners(accumulatedCardText, typed.text)
                      : typed.text;
                    await streamAICard(aiCard, accumulatedCardText, false, (msg) =>
                      logger.debug(msg),
                    );
                    logger.debug(`AI Card streamed ${typed.text.length} chars (buffered)`);
                  }
                  deliveryState.delivered = true;
                } catch (cardErr) {
                  logger.warn(`AI Card update failed in buffered dispatcher: ${String(cardErr)}`);
                  const didSend = await deliverFinalOnly(typed, info);
                  if (didSend) deliveryState.delivered = true;
                }
              }
              // 处理媒体附件（仅 final 时发送）
              const mediaUrls = typed.mediaUrls ?? (typed.mediaUrl ? [typed.mediaUrl] : []);
              if (info?.kind === "final" && mediaUrls.length > 0) {
                const didSend = await deliverFinalOnly({ mediaUrls }, info);
                if (didSend) deliveryState.delivered = true;
              }
              return;
            }

            if (!replyFinalOnly) {
              const didSend = await deliverFinalOnly(
                payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] },
                info,
              );
              if (didSend) {
                deliveryState.delivered = true;
              }
              return;
            }

            if (!info || info.kind !== "final") {
              return;
            }

            const typed = payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] };
            buffered.hasPayload = true;
            if (typeof typed.text === "string" && typed.text.trim()) {
              buffered.lastText = typed.text;
            }
            if (Array.isArray(typed.mediaUrls)) {
              for (const url of typed.mediaUrls) addBufferedMedia(url);
            } else if (typed.mediaUrl) {
              addBufferedMedia(typed.mediaUrl);
            }
          },
          humanDelay,
          onSkip: (_payload: unknown, info: { kind: string; reason: string }) => {
            if (info.reason !== "silent") {
              deliveryState.skippedNonSilent += 1;
            }
          },
          onError: (err: unknown, info: { kind: string }) => {
            logger.error(`${info.kind} reply failed: ${String(err)}`);
          },
        },
        // Enable block streaming when AI Card is active for real-time updates
        replyOptions: {
          disableBlockStreaming: replyFinalOnly || !aiCard ? undefined : false,
        },
      });

      if (buffered.hasPayload) {
        const didSend = await deliver(
          {
            text: buffered.lastText,
            mediaUrls: buffered.mediaUrls.length ? buffered.mediaUrls : undefined,
          },
          { kind: "final" },
        );
        if (didSend) {
          deliveryState.delivered = true;
        }
      }

      if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
        await sendMessageDingtalk({
          cfg: dingtalkCfgResolved,
          to: isGroup ? ctx.conversationId : ctx.senderId,
          text: "No response generated. Please try again.",
          chatType: isGroup ? "group" : "direct",
        });
      }

      // Finish AI Card if it was never properly finished.
      // Case 1: Card received streamed content but the final reply was
      //         skipped (e.g. concurrent message preemption). Finish with
      //         the last streamed text so the card shows complete content
      //         instead of staying stuck in INPUTING state with "···".
      // Case 2: Card was created but never received any content at all.
      if (aiCard && !aiCardFinished) {
        try {
          // Pick a meaningful fallback depending on what happened:
          // - Had streamed content → use it (card shows partial answer)
          // - Preempted by newer message → tell user explicitly
          // - No content at all → generic "processing" hint
          const fallbackText =
            accumulatedCardText ||
            (deliveryState.skippedNonSilent > 0
              ? "⏭️ 已被新消息抢占，本条消息的回复已跳过。请查看最新消息的回复。"
              : "处理中...");
          await finishAICard(aiCard, fallbackText, (msg) => logger.debug(msg));
          logger.info(
            `AI Card finished (fallback, hadStreamedContent=${!!accumulatedCardText}, preempted=${deliveryState.skippedNonSilent > 0})`,
          );
        } catch (cardErr) {
          logger.warn(`Failed to finish orphaned AI Card: ${String(cardErr)}`);
        }
      }

      const counts = (result as Record<string, unknown>)?.counts as
        | Record<string, unknown>
        | undefined;
      const queuedFinal = (result as Record<string, unknown>)?.queuedFinal as unknown;
      logger.debug(
        `dispatch complete (queuedFinal=${typeof queuedFinal === "boolean" ? queuedFinal : "unknown"}, replies=${counts?.final ?? 0})`,
      );
      logger.debug(
        `[PERF] dispatchReplyWithBufferedBlockDispatcher total: ${(performance.now() - dispatchStart).toFixed(2)}ms`,
      );
      return;
    }

    const dispatcherResult = createDispatcherWithTyping
      ? createDispatcherWithTyping({
          deliver: async (payload: unknown, info?: { kind?: string }) => {
            await deliverFinalOnly(
              payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] },
              info,
            );
          },
          humanDelay,
          onError: (err: unknown, info: { kind: string }) => {
            logger.error(`${info.kind} reply failed: ${String(err)}`);
          },
        })
      : {
          dispatcher: createDispatcher?.({
            deliver: async (payload: unknown, info?: { kind?: string }) => {
              await deliverFinalOnly(
                payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] },
                info,
              );
            },
            humanDelay,
            onError: (err: unknown, info: { kind: string }) => {
              logger.error(`${info.kind} reply failed: ${String(err)}`);
            },
          }),
          replyOptions: {},
          markDispatchIdle: () => undefined,
        };

    const dispatcher = (dispatcherResult as Record<string, unknown>)?.dispatcher as
      | Record<string, unknown>
      | undefined;
    if (!dispatcher) {
      logger.debug("dispatcher not available, skipping dispatch");
      return;
    }

    logger.debug(
      `dispatching to agent (session=${(route as Record<string, unknown>)?.sessionKey})`,
    );

    // 分发消息
    const dispatchReplyFromConfig = replyApi?.dispatchReplyFromConfig as
      | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
      | undefined;

    if (!dispatchReplyFromConfig) {
      logger.debug("dispatchReplyFromConfig not available");
      return;
    }

    const dispatchStart2 = performance.now();
    const result = await dispatchReplyFromConfig({
      ctx: finalCtx,
      cfg,
      dispatcher,
      replyOptions: (dispatcherResult as Record<string, unknown>)?.replyOptions ?? {},
    });
    logger.debug(
      `[PERF] dispatchReplyFromConfig: ${(performance.now() - dispatchStart2).toFixed(2)}ms`,
    );

    const markDispatchIdle = (dispatcherResult as Record<string, unknown>)?.markDispatchIdle as
      | (() => void)
      | undefined;
    markDispatchIdle?.();

    const counts = (result as Record<string, unknown>)?.counts as
      | Record<string, unknown>
      | undefined;
    const queuedFinal = (result as Record<string, unknown>)?.queuedFinal as unknown;
    logger.debug(
      `dispatch complete (queuedFinal=${typeof queuedFinal === "boolean" ? queuedFinal : "unknown"}, replies=${counts?.final ?? 0})`,
    );

    // ===== 文件清理 (Requirements 8.1, 8.2, 8.4) =====
    // 清理单个媒体文件
    if (downloadedMedia && extractedFileInfo) {
      const category = resolveFileCategory(downloadedMedia.contentType, extractedFileInfo.fileName);

      // 图片/音频/视频立即删除 (Requirement 8.1)
      // 文档/压缩�?代码文件保留�?agent 工具访问 (Requirement 8.2)
      if (category === "image" || category === "audio" || category === "video") {
        await cleanupFile(downloadedMedia.path, logger);
        logger.debug(`cleaned up media file: ${downloadedMedia.path}`);
      } else {
        logger.debug(
          `retaining file for agent access: ${downloadedMedia.path} (category: ${category})`,
        );
      }
    }

    // 清理 richText 图片 (Requirement 8.4)
    for (const img of downloadedRichTextImages) {
      await cleanupFile(img.path, logger);
    }
    if (downloadedRichTextImages.length > 0) {
      logger.debug(`cleaned up ${downloadedRichTextImages.length} richText images`);
    }
  } catch (err) {
    logger.error(`failed to dispatch message: ${String(err)}`);

    // 即使出错也要按分类策略清理文�?(Requirements 8.1, 8.2)
    // 图片/音频/视频立即删除，文�?压缩�?代码文件保留�?agent 工具访问
    if (downloadedMedia && extractedFileInfo) {
      const category = resolveFileCategory(downloadedMedia.contentType, extractedFileInfo.fileName);
      if (category === "image" || category === "audio" || category === "video") {
        await cleanupFile(downloadedMedia.path, logger);
        logger.debug(`cleaned up media file on error: ${downloadedMedia.path}`);
      } else {
        logger.debug(
          `retaining file for agent access on error: ${downloadedMedia.path} (category: ${category})`,
        );
      }
    }

    // richText 图片始终清理
    for (const img of downloadedRichTextImages) {
      await cleanupFile(img.path, logger);
    }
  }
}

/**
 * Safely inject block streaming defaults into an opaque config object.
 * The config is typed as unknown in extensions, so we use runtime checks
 * to deep-merge agents.defaults without unsafe spread on unknown types.
 */
/**
 * Collapse coalescer-introduced "\n\n" joiners at the boundary between
 * accumulated AI Card text and a new streaming chunk.
 *
 * The block reply coalescer joins chunks with "\n\n" (paragraph joiner).
 * For AI Card's full-replacement streaming, these joiners create spurious
 * blank lines that DingTalk renders as real line breaks. This function
 * detects trailing "\n\n" on the accumulated text or leading "\n\n" on
 * the new chunk and collapses them to single "\n", allowing
 * preprocessDingtalkMarkdown to merge soft breaks correctly.
 */
function collapseCoalescerJoiners(accumulated: string, newChunk: string): string {
  // If accumulated ends with \n\n and new chunk starts with non-structural text,
  // the \n\n is likely a coalescer joiner. Trim trailing \n from accumulated
  // and prepend \n to the chunk so they join with a single \n.
  let result = newChunk;

  // Case 1: new chunk starts with \n\n (coalescer prepended joiner)
  if (result.startsWith("\n\n")) {
    result = "\n" + result.slice(2);
  }

  // Case 2: accumulated ends with \n\n and chunk doesn't start with \n
  if (accumulated.endsWith("\n\n") && !result.startsWith("\n")) {
    // Replace the trailing \n\n on accumulated side by trimming one \n
    // We can't modify accumulated here, so prepend nothing and let the
    // caller handle it. Instead, we handle it differently:
    // The accumulated already has \n\n at the end. We return the chunk as-is
    // but strip the extra \n from accumulated by returning a modified concat.
    return accumulated.slice(0, -1) + result;
  }

  if (accumulated.endsWith("\n\n") && result.startsWith("\n")) {
    // accumulated ends with \n\n and chunk starts with \n → would be \n\n\n
    // Collapse to single \n boundary
    return accumulated.slice(0, -1) + result;
  }

  return accumulated + result;
}

function injectBlockStreamingDefaults(
  baseCfg: unknown,
  overrides: {
    blockStreamingChunk?: { minChars: number; maxChars: number; breakPreference?: string };
    blockStreamingCoalesce?: { minChars: number; maxChars: number; idleMs: number };
  },
): unknown {
  const base = (typeof baseCfg === "object" && baseCfg !== null ? baseCfg : {}) as Record<
    string,
    unknown
  >;
  const agents = (
    typeof base.agents === "object" && base.agents !== null ? base.agents : {}
  ) as Record<string, unknown>;
  const defaults = (
    typeof agents.defaults === "object" && agents.defaults !== null ? agents.defaults : {}
  ) as Record<string, unknown>;
  return {
    ...base,
    agents: {
      ...agents,
      defaults: {
        ...defaults,
        ...overrides,
      },
    },
  };
}
