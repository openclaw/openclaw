/**
 * 钉钉消息业务处理器
 *
 * 职责：
 * - 处理钉钉消息的业务逻辑
 * - 支持多种消息类型：text、richText、picture、audio、video、file
 * - 媒体文件下载和上传（图片、语音、视频、文件）
 * - 会话上下文构建和管理
 * - 消息分发（AI Card、命令处理、主动消息）
 * - Policy 检查（DM 白名单、群聊策略）
 *
 * 核心功能：
 * - 消息内容提取和归一化
 * - 媒体文件本地缓存管理
 * - 钉钉 API 调用（accessToken、文件下载）
 * - 与 OpenClaw 框架集成（bindings、runtime）
 */
// 类型定义
interface ClawdbotConfig {
  [key: string]: any;
}

interface RuntimeEnv {
  log?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
  info?: (...args: any[]) => void;
  [key: string]: any;
}

interface HistoryEntry {
  role: string;
  content: string;
  [key: string]: any;
}
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AICardTarget } from "../reply-dispatcher.ts";
import { createDingtalkReplyDispatcher } from "../reply-dispatcher.ts";
import { getDingtalkRuntime } from "../runtime.ts";
import {
  processLocalImages,
  processVideoMarkers,
  processAudioMarkers,
  uploadAndReplaceFileMarkers,
} from "../services/media/index.ts";
import { sendProactive } from "../services/messaging/index.ts";
import type { ResolvedDingtalkAccount, DingtalkConfig } from "../types/index.ts";
import { resolveAgentWorkspaceDir } from "../utils/agent.ts";
import { QUEUE_BUSY_ACK_PHRASES } from "../utils/constants.ts";
import { dingtalkHttp } from "../utils/http-client.ts";
import { createLoggerFromConfig } from "../utils/index.ts";
import { normalizeSlashCommand } from "../utils/session.ts";
import {
  buildSessionContext,
  getAccessToken,
  getOapiAccessToken,
  DINGTALK_API,
  DINGTALK_OAPI,
  addEmotionReply,
  recallEmotionReply,
} from "../utils/utils-legacy.ts";

// ============ 常量 ============

// ============ 会话级别消息队列 ============

/**
 * 会话消息队列管理
 * 用于确保同一会话+agent的消息按顺序处理，避免并发冲突导致AI返回空响应
 * 队列键格式：{sessionId}:{agentId}
 * 这样不同 agent 可以并发处理，同一 agent 的同一会话串行处理
 */
const sessionQueues = new Map<string, Promise<void>>();

/**
 * 清理过期的会话队列（超过5分钟没有新消息的会话+agent）
 */
const sessionLastActivity = new Map<string, number>();
const SESSION_QUEUE_TTL = 5 * 60 * 1000; // 5分钟

function cleanupExpiredSessionQueues(): void {
  const now = Date.now();
  for (const [queueKey, lastActivity] of sessionLastActivity.entries()) {
    if (now - lastActivity > SESSION_QUEUE_TTL) {
      sessionQueues.delete(queueKey);
      sessionLastActivity.delete(queueKey);
    }
  }
}

// 每分钟清理一次过期队列
setInterval(cleanupExpiredSessionQueues, 60_000);

// ============ 类型定义 ============

export type DingtalkReactionCreatedEvent = {
  type: "reaction_created";
  channelId: string;
  messageId: string;
  userId: string;
  emoji: string;
};

export type MonitorDingtalkAccountOpts = {
  cfg: ClawdbotConfig;
  account: ResolvedDingtalkAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

// ============ Agent 路由解析 ============
// SDK 会自动处理 bindings 解析，无需手动实现

// ============ 消息内容提取 ============

interface ExtractedMessage {
  text: string;
  messageType: string;
  imageUrls: string[];
  downloadCodes: string[];
  fileNames: string[];
  atDingtalkIds: string[];
  atMobiles: string[];
  /** interactiveCard 消息中提取的文档链接（biz_custom_action_url），用于下游 URL 路由 */
  interactiveCardUrl?: string;
  /** actionCard 消息中提取的操作链接（单个时直接存储），用于下游 URL 路由 */
  actionCardUrl?: string;
}

/**
 * 解析 data.content 字段：可能是对象，也可能是 JSON 字符串（钉钉部分 API 版本会将 content 序列化为字符串）。
 * 返回解析后的对象，或 null（字段不存在 / 无法解析）。
 */
function resolveContent(data: any): any | null {
  const raw = data?.content;
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // 非 JSON 字符串，忽略
    }
  }
  return null;
}

/**
 * 从消息的内容容器（data.text 或 data.content）中提取引用消息文本，最多递归 maxDepth 层。
 * 对齐 Rust chatbot.rs 的 extract_quoted_msg_text 逻辑。
 *
 * 钉钉引用消息结构：
 * { isReplyMsg: true, repliedMsg: { msgType, content, msgId, senderId } }
 */
function extractQuotedMsgText(container: any, maxDepth: number): string | null {
  if (maxDepth <= 0 || !container) return null;
  if (!container.isReplyMsg) return null;

  const repliedMsg = container.repliedMsg;
  if (!repliedMsg) return null;

  const msgType = repliedMsg.msgType || "text";

  // 解析 repliedMsg.content（可能是对象或 JSON 字符串）
  let contentObj: any = null;
  const rawContent = repliedMsg.content;
  if (rawContent && typeof rawContent === "object") {
    contentObj = rawContent;
  } else if (typeof rawContent === "string") {
    try {
      const parsed = JSON.parse(rawContent);
      if (parsed && typeof parsed === "object") contentObj = parsed;
    } catch {
      // 忽略
    }
  }

  let bodyText = "";
  switch (msgType) {
    case "text": {
      // repliedMsg.content.text 存放正文
      bodyText = contentObj?.text?.trim() || repliedMsg.text?.trim() || "";
      // 嵌套引用：content 中可能还有 isReplyMsg/repliedMsg
      if (contentObj?.isReplyMsg) {
        const nested = extractQuotedMsgText(contentObj, maxDepth - 1);
        if (nested) bodyText = bodyText ? `${bodyText}\n${nested}` : nested;
      }
      break;
    }
    case "richText": {
      const richList: any[] = contentObj?.richText || [];
      const textParts = richList
        .filter((item: any) => item.text && item.msgType !== "skill" && !item.skillData)
        .map((item: any) => item.text as string);
      bodyText = textParts.join("");
      break;
    }
    case "picture":
      bodyText = "[图片]";
      break;
    case "video":
      bodyText = "[视频]";
      break;
    case "audio":
      bodyText = contentObj?.recognition || "[语音消息]";
      break;
    case "file": {
      const fileName = contentObj?.fileName || "unknown";
      bodyText = `[文件: ${fileName}]`;
      break;
    }
    case "markdown":
      bodyText = contentObj?.text?.trim() || "[markdown消息]";
      break;
    case "interactiveCard": {
      const cardUrl = contentObj?.biz_custom_action_url || repliedMsg.biz_custom_action_url || "";
      bodyText = cardUrl ? `收到交互式卡片链接：${cardUrl}` : "[interactiveCard消息]";
      break;
    }
    default:
      bodyText = `[${msgType}消息]`;
  }

  if (!bodyText) return null;
  return `[引用] ${bodyText}`;
}

/**
 * 从 richText 列表中提取媒体附件（图片 downloadCode）。
 * 兼容新结构（content.richText）和旧结构（richText.richTextList）。
 */
function extractRichTextMediaAttachments(
  data: any,
  content: any,
): { imageUrls: string[]; downloadCodes: string[]; fileNames: string[] } {
  const imageUrls: string[] = [];
  const downloadCodes: string[] = [];
  const fileNames: string[] = [];

  // 兼容新结构 content.richText 和旧结构 richText.richTextList
  const richList: any[] = content?.richText || data?.richText?.richTextList || [];

  for (const item of richList) {
    if (item.pictureUrl) {
      imageUrls.push(item.pictureUrl);
    }
    if (item.downloadCode) {
      const itemType: string = item.type || "";
      if (itemType === "picture" || !itemType) {
        imageUrls.push(`downloadCode:${item.downloadCode}`);
      } else if (itemType === "video") {
        downloadCodes.push(item.downloadCode);
        fileNames.push(item.fileName || "video.mp4");
      } else if (itemType === "audio") {
        downloadCodes.push(item.downloadCode);
        fileNames.push(item.fileName || "audio.amr");
      } else if (itemType === "file") {
        downloadCodes.push(item.downloadCode);
        fileNames.push(item.fileName || "文件");
      }
    }
  }

  return { imageUrls, downloadCodes, fileNames };
}

/**
 * 从 repliedMsg 中提取媒体附件（用于 reply 类型消息）。
 */
function extractRepliedMsgMediaAttachments(repliedMsg: any): {
  imageUrls: string[];
  downloadCodes: string[];
  fileNames: string[];
} {
  const imageUrls: string[] = [];
  const downloadCodes: string[] = [];
  const fileNames: string[] = [];

  if (!repliedMsg) return { imageUrls, downloadCodes, fileNames };

  const msgType = repliedMsg.msgType || "text";

  let contentObj: any = null;
  const rawContent = repliedMsg.content;
  if (rawContent && typeof rawContent === "object") {
    contentObj = rawContent;
  } else if (typeof rawContent === "string") {
    try {
      const parsed = JSON.parse(rawContent);
      if (parsed && typeof parsed === "object") contentObj = parsed;
    } catch {
      // 忽略
    }
  }

  switch (msgType) {
    case "picture":
    case "video":
    case "audio": {
      const code = contentObj?.downloadCode;
      if (code) {
        if (msgType === "picture") {
          imageUrls.push(`downloadCode:${code}`);
        } else {
          downloadCodes.push(code);
          fileNames.push(contentObj?.fileName || (msgType === "video" ? "video.mp4" : "audio.amr"));
        }
      }
      break;
    }
    case "file": {
      const code = contentObj?.downloadCode;
      if (code) {
        downloadCodes.push(code);
        fileNames.push(contentObj?.fileName || "文件");
      }
      break;
    }
    case "richText": {
      const richList: any[] = contentObj?.richText || [];
      for (const item of richList) {
        if (item.downloadCode) {
          imageUrls.push(`downloadCode:${item.downloadCode}`);
        }
      }
      break;
    }
    default:
      break;
  }

  return { imageUrls, downloadCodes, fileNames };
}

export function extractMessageContent(data: any): ExtractedMessage {
  const msgtype = data.msgtype || "text";
  switch (msgtype) {
    case "text": {
      const atDingtalkIds = data.text?.at?.atDingtalkIds || [];
      const atMobiles = data.text?.at?.atMobiles || [];

      const bodyText = data.text?.content?.trim() || "";

      // 检测引用消息（isReplyMsg + repliedMsg 在 data.text 对象内）
      const hasReply = !!data.text?.isReplyMsg;
      const quotedText = extractQuotedMsgText(data.text, 3);
      const text = quotedText ? `${bodyText}\n${quotedText}` : bodyText;

      // 提取引用消息中的媒体附件（图片/视频/音频/文件）
      const repliedMsgInText = data.text?.repliedMsg;
      const { imageUrls, downloadCodes, fileNames } =
        extractRepliedMsgMediaAttachments(repliedMsgInText);

      // 从引用消息的文本内容中提取 URL，触发链接路由（如 alidocs 文档链接）
      // 场景：用户引用了一条含链接的文本消息，并追问"这个文档内容是什么"
      let interactiveCardUrl: string | undefined;
      if (hasReply && repliedMsgInText) {
        const repliedContentObj =
          typeof repliedMsgInText.content === "object"
            ? repliedMsgInText.content
            : (() => {
                try {
                  return JSON.parse(repliedMsgInText.content);
                } catch {
                  return null;
                }
              })();
        const repliedText = repliedContentObj?.text || repliedMsgInText.text || "";
        const extractedUrl = extractFirstUrlFromText(repliedText);
        if (extractedUrl) {
          interactiveCardUrl = extractedUrl;
        }
      }

      return {
        text,
        messageType: hasReply ? "reply" : "text",
        imageUrls,
        downloadCodes,
        fileNames,
        atDingtalkIds,
        atMobiles,
        interactiveCardUrl,
      };
    }
    case "richText": {
      // 兼容 content 为 JSON 字符串的情况
      const content = resolveContent(data);
      const textParts: string[] = [];

      // 兼容新结构 content.richText 和旧结构 richText.richTextList
      const richList: any[] = content?.richText || data?.richText?.richTextList || [];

      for (const item of richList) {
        const isSkillItem = item.type === "skill" || !!item.skillData;

        if (item.text && !isSkillItem) {
          textParts.push(item.text);
        }

        if (isSkillItem && item.skillData) {
          // 将 skillData 转换为 <skill> 标签，供下游识别斜杠命令
          const skillId = item.skillData.skillId || "";
          const displayName = item.skillData.displayName || "";
          const iconUrl = item.skillData.iconUrl || "";
          const skillTag = iconUrl
            ? `<skill data-id="${skillId}" data-name="${displayName}" icon="${iconUrl}">`
            : `<skill data-id="${skillId}" data-name="${displayName}">`;
          textParts.push(skillTag);
        }

        if (item.pictureUrl) {
          // pictureUrl 在 imageUrls 里处理，文本部分不需要占位
        }
      }

      // 检测引用消息（isReplyMsg + repliedMsg 在 content 对象内）
      const hasReply = !!content?.isReplyMsg;
      const quotedText = extractQuotedMsgText(content, 3);
      if (quotedText) textParts.push(quotedText);

      const richTextMedia = extractRichTextMediaAttachments(data, content);

      // 同时提取引用消息中的媒体附件（richText 引用图片场景）
      const repliedMsgInRichText = content?.repliedMsg;
      const repliedMedia = extractRepliedMsgMediaAttachments(repliedMsgInRichText);

      const imageUrls = [...richTextMedia.imageUrls, ...repliedMedia.imageUrls];
      const downloadCodes = [...richTextMedia.downloadCodes, ...repliedMedia.downloadCodes];
      const fileNames = [...richTextMedia.fileNames, ...repliedMedia.fileNames];

      const text =
        textParts.join("") ||
        (imageUrls.length > 0
          ? "[图片]"
          : downloadCodes.length > 0
            ? "[媒体文件]"
            : "[富文本消息]");

      return {
        text,
        messageType: hasReply ? "reply" : "richText",
        imageUrls,
        downloadCodes,
        fileNames,
        atDingtalkIds: [],
        atMobiles: [],
      };
    }
    case "picture": {
      const content = resolveContent(data);
      const downloadCode = content?.downloadCode || "";
      const pictureUrl = content?.pictureUrl || "";
      const imageUrls: string[] = [];
      const downloadCodes: string[] = [];

      if (pictureUrl) {
        imageUrls.push(pictureUrl);
      }
      if (downloadCode) {
        downloadCodes.push(downloadCode);
      }

      return {
        text: "[图片]",
        messageType: "picture",
        imageUrls,
        downloadCodes,
        fileNames: [],
        atDingtalkIds: [],
        atMobiles: [],
      };
    }
    case "audio": {
      const content = resolveContent(data);
      // 兼容旧结构 /audio/recognition
      const recognition = content?.recognition || data?.audio?.recognition || "[语音消息]";
      const audioDownloadCode = content?.downloadCode || "";
      const audioFileName = content?.fileName || "audio.amr";
      const downloadCodes: string[] = [];
      const fileNames: string[] = [];
      if (audioDownloadCode) {
        downloadCodes.push(audioDownloadCode);
        fileNames.push(audioFileName);
      }
      return {
        text: recognition,
        messageType: "audio",
        imageUrls: [],
        downloadCodes,
        fileNames,
        atDingtalkIds: [],
        atMobiles: [],
      };
    }
    case "video": {
      const content = resolveContent(data);
      const videoDownloadCode = content?.downloadCode || "";
      const videoFileName = content?.fileName || "video.mp4";
      const downloadCodes: string[] = [];
      const fileNames: string[] = [];
      if (videoDownloadCode) {
        downloadCodes.push(videoDownloadCode);
        fileNames.push(videoFileName);
      }
      return {
        text: "[视频]",
        messageType: "video",
        imageUrls: [],
        downloadCodes,
        fileNames,
        atDingtalkIds: [],
        atMobiles: [],
      };
    }
    case "file": {
      const content = resolveContent(data);
      // 兼容旧结构 /file/fileName
      const fileName = content?.fileName || data?.file?.fileName || "文件";
      const downloadCode = content?.downloadCode || "";
      const downloadCodes: string[] = [];
      const fileNames: string[] = [];
      if (downloadCode) {
        downloadCodes.push(downloadCode);
        fileNames.push(fileName);
      }
      return {
        text: `[文件: ${fileName}]`,
        messageType: "file",
        imageUrls: [],
        downloadCodes,
        fileNames,
        atDingtalkIds: [],
        atMobiles: [],
      };
    }
    case "markdown": {
      // 钉钉 markdown 消息内容在 data.text.content（与 text 类型一致），不在 data.content
      const text =
        data.text?.content?.trim() || resolveContent(data)?.text?.trim() || "[markdown消息]";
      return {
        text,
        messageType: "markdown",
        imageUrls: [],
        downloadCodes: [],
        fileNames: [],
        atDingtalkIds: [],
        atMobiles: [],
      };
    }
    case "actionCard": {
      const content = resolveContent(data);
      const title = content?.title?.trim() || "";
      const body = content?.text?.trim() || "";
      // 提取操作链接列表
      const actionUrlItems: any[] = content?.actionUrlItemList || [];
      const actionUrls = actionUrlItems
        .map((item: any) => item.actionUrl?.trim())
        .filter((url: string) => !!url);

      const sections: string[] = [];
      if (title) sections.push(title);
      if (body) sections.push(body);
      if (actionUrls.length > 0) {
        const linkSection =
          actionUrls.length === 1
            ? `操作链接：${actionUrls[0]}`
            : `操作链接：\n- ${actionUrls.join("\n- ")}`;
        sections.push(linkSection);
      }

      const text = sections.length > 0 ? sections.join("\n\n") : "[actionCard消息]";
      // 单个操作链接时作为 actionCardUrl 传给下游做 URL 路由
      const actionCardUrl = actionUrls.length === 1 ? actionUrls[0] : undefined;
      return {
        text,
        messageType: "actionCard",
        imageUrls: [],
        downloadCodes: [],
        fileNames: [],
        atDingtalkIds: [],
        atMobiles: [],
        actionCardUrl,
      };
    }
    case "interactiveCard": {
      // 交互式卡片消息（通常是文档分享）
      const content = resolveContent(data);
      // 兼容 content 字段不存在时直接从顶层取（repliedMsg 透传场景）
      const interactiveCardUrl =
        (content?.biz_custom_action_url || data?.biz_custom_action_url || "").trim() || undefined;
      if (interactiveCardUrl) {
        const text = `收到交互式卡片链接：${interactiveCardUrl}`;
        return {
          text,
          messageType: "interactiveCard",
          imageUrls: [],
          downloadCodes: [],
          fileNames: [],
          atDingtalkIds: [],
          atMobiles: [],
          interactiveCardUrl,
        };
      }
      return {
        text: "[interactiveCard消息]",
        messageType: "interactiveCard",
        imageUrls: [],
        downloadCodes: [],
        fileNames: [],
        atDingtalkIds: [],
        atMobiles: [],
      };
    }
    case "reply": {
      // 显式 reply 类型（部分钉钉版本直接发 msgtype=reply）
      // 优先从 data.text 取引用容器，取不到再从 content 取
      const replyContainer = data.text || resolveContent(data);
      const bodyText = data.text?.content?.trim() || "";
      const quotedText = extractQuotedMsgText(replyContainer, 3);
      const text = quotedText ? `${bodyText}\n${quotedText}` : bodyText || "[引用消息]";

      // 提取引用中的媒体附件
      const repliedMsg = data.text?.repliedMsg || resolveContent(data)?.repliedMsg;
      const { imageUrls, downloadCodes, fileNames } = extractRepliedMsgMediaAttachments(repliedMsg);

      return {
        text,
        messageType: "reply",
        imageUrls,
        downloadCodes,
        fileNames,
        atDingtalkIds: [],
        atMobiles: [],
      };
    }
    default:
      return {
        text: data.text?.content?.trim() || `[${msgtype}消息]`,
        messageType: msgtype,
        imageUrls: [],
        downloadCodes: [],
        fileNames: [],
        atDingtalkIds: [],
        atMobiles: [],
      };
  }
}

// ============ 卡片链接路由 system prompt ============

/**
 * 从文本内容中提取第一个 HTTP/HTTPS URL。
 * 用于处理引用消息文本里直接粘贴链接的场景（如引用一条含 alidocs 链接的文本消息）。
 */
function extractFirstUrlFromText(text: string): string | null {
  const urlMatch = text.match(/https?:\/\/[^\s\u3000\u3001\uff0c\u3002\uff01\uff1f"'<>]+/);
  return urlMatch ? urlMatch[0].trim() : null;
}

/**
 * 根据消息中的 interactiveCardUrl / actionCardUrl 构建链接路由 system prompt。
 * 对齐 Rust agent_support.rs 的 build_link_routing_prompt 逻辑：
 * - alidocs.dingtalk.com → 使用 dws skill 的 doc 能力读取
 * - 其他 URL → 使用 read_url 读取
 * 返回 null 表示无需注入额外 prompt。
 */
function buildLinkRoutingPrompt(content: ExtractedMessage): string | null {
  const interactiveCardUrl = content.interactiveCardUrl?.trim();
  const actionCardUrl = content.actionCardUrl?.trim();

  const linkUrl = interactiveCardUrl || actionCardUrl;
  if (!linkUrl) return null;

  const cardKind = interactiveCardUrl ? "interactive card" : "action card";

  let host: string | null = null;
  try {
    host = new URL(linkUrl).hostname;
  } catch {
    // URL 解析失败，当作普通链接处理
  }

  if (host === "alidocs.dingtalk.com") {
    return [
      `The inbound DingTalk message is an ${cardKind} with a document link.`,
      `Linked URL: ${linkUrl}`,
      `This URL is hosted on \`alidocs.dingtalk.com\`.`,
      `You MUST inspect and summarize it via the \`dws\` skill using its \`doc\` product capability.`,
      `If \`dws\` is not already visible in the skill snapshot, call \`search_skills\` to locate it, then call \`use_skill\` with the exact id.`,
      `Never switch to browser-based reading for this link. Browser incompatibility or markdown export limitations are not final answers.`,
      `Do not use \`read_url\` for this link.`,
      `Reply to the DingTalk user with a concise summary of the linked document content.`,
    ].join("\n");
  }

  return [
    `The inbound DingTalk message is an ${cardKind} with a link.`,
    `Linked URL: ${linkUrl}`,
    `For this URL, you MUST use \`read_url\` to inspect the linked content before answering.`,
    `Do not use the \`dws\` skill for this link.`,
    `Reply to the DingTalk user with a concise summary of the linked content.`,
  ].join("\n");
}

// ============ 图片下载 ============

export async function downloadImageToFile(
  downloadUrl: string,
  agentWorkspaceDir: string,
  log?: any,
): Promise<string | null> {
  try {
    log?.info?.(`开始下载图片: ${downloadUrl.slice(0, 100)}...`);
    const resp = await dingtalkHttp.get(downloadUrl, {
      proxy: false, // 禁用代理，避免 PAC 文件影响

      headers: {
        "Content-Type": undefined, // 删除默认的 Content-Type 请求头，让 OSS 签名验证通过
      },
      responseType: "arraybuffer",
      timeout: 30_000,
    });

    const buffer = Buffer.from(resp.data);
    const contentType = resp.headers["content-type"] || "image/jpeg";
    const ext = contentType.includes("png")
      ? ".png"
      : contentType.includes("gif")
        ? ".gif"
        : contentType.includes("webp")
          ? ".webp"
          : ".jpg";
    // 使用 Agent 工作空间路径
    const mediaDir = path.join(agentWorkspaceDir, "media", "inbound");
    fs.mkdirSync(mediaDir, { recursive: true });
    const tmpFile = path.join(
      mediaDir,
      `openclaw-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
    );
    fs.writeFileSync(tmpFile, buffer);

    log?.info?.(`图片下载成功: size=${buffer.length} bytes, type=${contentType}, path=${tmpFile}`);
    return tmpFile;
  } catch (err: any) {
    log?.error?.(`图片下载失败: ${err.message}`);
    return null;
  }
}

export async function downloadMediaByCode(
  downloadCode: string,
  config: DingtalkConfig,
  agentWorkspaceDir: string,
  log?: any,
): Promise<string | null> {
  try {
    const token = await getAccessToken(config);
    log?.info?.(`通过 downloadCode 下载媒体: ${downloadCode.slice(0, 30)}...`);

    const resp = await dingtalkHttp.post(
      `${DINGTALK_API}/v1.0/robot/messageFiles/download`,
      { downloadCode, robotCode: String(config.clientId) },
      {
        headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
        timeout: 30_000,
      },
    );

    const downloadUrl = resp.data?.downloadUrl;
    if (!downloadUrl) {
      log?.warn?.(`downloadCode 换取 downloadUrl 失败: ${JSON.stringify(resp.data)}`);
      return null;
    }

    return downloadImageToFile(downloadUrl, agentWorkspaceDir, log);
  } catch (err: any) {
    log?.error?.(`downloadCode 下载失败: ${err.message}`);
    return null;
  }
}

export async function getFileDownloadUrl(
  downloadCode: string,
  fileName: string,
  config: DingtalkConfig,
  log?: any,
): Promise<string | null> {
  try {
    const token = await getAccessToken(config);
    log?.info?.(`获取文件下载链接: ${fileName}`);

    const resp = await dingtalkHttp.post(
      `${DINGTALK_API}/v1.0/robot/messageFiles/download`,
      { downloadCode, robotCode: String(config.clientId) },
      {
        headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
        timeout: 30_000,
      },
    );

    const downloadUrl = resp.data?.downloadUrl;
    if (!downloadUrl) {
      log?.warn?.(`downloadCode 换取 downloadUrl 失败: ${JSON.stringify(resp.data)}`);
      return null;
    }

    log?.info?.(`获取下载链接成功: ${fileName}`);
    return downloadUrl;
  } catch (err: any) {
    log?.error?.(`获取下载链接失败: ${err.message}`);
    return null;
  }
}

// ============ 文件下载和解析 ============

/**
 * 下载文件到本地
 */
export async function downloadFileToLocal(
  downloadUrl: string,
  fileName: string,
  agentWorkspaceDir: string,
  log?: any,
): Promise<string | null> {
  try {
    log?.info?.(`开始下载文件: ${fileName}`);
    const resp = await dingtalkHttp.get(downloadUrl, {
      proxy: false, // 禁用代理，避免 PAC 文件影响
      headers: {
        "Content-Type": undefined, // 删除默认的 Content-Type 请求头，让 OSS 签名验证通过
      },
      responseType: "arraybuffer",
      timeout: 60_000, // 文件可能较大，增加超时时间
    });

    const buffer = Buffer.from(resp.data);
    const mediaDir = path.join(agentWorkspaceDir, "media", "inbound");
    fs.mkdirSync(mediaDir, { recursive: true });

    // 安全过滤文件名
    const sanitizeFileName = (name: string): string => {
      // 移除路径分隔符，防止目录遍历攻击
      let safe = name.replace(/[/\\]/g, "_");
      // 移除或替换危险字符
      safe = safe.replace(/[<>:"|?*\x00-\x1f]/g, "_");
      // 移除开头的点，防止隐藏文件
      safe = safe.replace(/^\.+/, "");
      // 限制长度
      if (safe.length > 200) {
        const ext = path.extname(safe);
        const base = path.basename(safe, ext);
        safe = base.substring(0, 200 - ext.length) + ext;
      }
      // 如果处理后为空，使用默认名称
      if (!safe) {
        safe = "unnamed_file";
      }
      return safe;
    };

    // 保留原始文件名，但添加时间戳避免冲突
    const ext = path.extname(fileName);
    const baseName = path.basename(fileName, ext);
    const timestamp = Date.now();
    const safeBaseName = sanitizeFileName(baseName);
    const safeFileName = `${safeBaseName}-${timestamp}${ext}`;
    const localPath = path.join(mediaDir, safeFileName);

    fs.writeFileSync(localPath, buffer);
    log?.info?.(`文件下载成功: ${fileName}, size=${buffer.length} bytes, path=${localPath}`);
    return localPath;
  } catch (err: any) {
    log?.error?.(`downloadFileToLocal 异常: ${err.message}\n${err.stack}`);
    return null;
  }
}

/**
 * 解析 Word 文档 (.docx)
 */
async function parseDocxFile(filePath: string, log?: any): Promise<string | null> {
  try {
    log?.info?.(`开始解析 Word 文档: ${filePath}`);

    let mammoth: any;
    try {
      mammoth = (await import("mammoth")).default;
    } catch {
      log?.warn?.("mammoth 库未安装，无法解析 .docx 文件。请运行: npm install mammoth");
      return null;
    }

    const buffer = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();

    if (text) {
      log?.info?.(`Word 文档解析成功: ${filePath}, 文本长度=${text.length}`);
      return text;
    } else {
      log?.warn?.(`Word 文档解析结果为空: ${filePath}`);
      return null;
    }
  } catch (err: any) {
    log?.error?.(`Word 文档解析失败: ${filePath}, error=${err.message}`);
    return null;
  }
}

/**
 * 解析 PDF 文档
 */
async function parsePdfFile(filePath: string, log?: any): Promise<string | null> {
  try {
    log?.info?.(`开始解析 PDF 文档: ${filePath}`);

    let pdfParseV1: any;
    let pdfParseV2: any;
    try {
      const mod = await import("pdf-parse");
      if (mod.PDFParse) {
        pdfParseV2 = mod.PDFParse; // v2.x API
      } else if (mod.default) {
        pdfParseV1 = mod.default; // v1.x API
      } else {
        throw new Error("pdf-parse module format not recognized");
      }
    } catch {
      log?.warn?.("pdf-parse 库未安装，无法解析 .pdf 文件。请运行: npm install pdf-parse");
      return null;
    }

    const buffer = fs.readFileSync(filePath);
    let text: string;
    let numPages: number | undefined;

    if (pdfParseV2) {
      const parser = new pdfParseV2({ data: buffer });
      const result = await parser.getText();
      text = (result.text ?? "").trim();
      numPages = result.total;
      parser.destroy?.();
    } else {
      const data = await pdfParseV1(buffer);
      text = (data.text ?? "").trim();
      numPages = data.numpages;
    }

    if (text) {
      log?.info?.(`PDF 文档解析成功: ${filePath}, 文本长度=${text.length}, 页数=${numPages}`);
      return text;
    } else {
      log?.warn?.(`PDF 文档解析结果为空: ${filePath}`);
      return null;
    }
  } catch (err: any) {
    log?.error?.(`PDF 文档解析失败: ${filePath}, error=${err.message}`);
    return null;
  }
}

/**
 * 读取纯文本文件
 */
async function readTextFile(filePath: string, log?: any): Promise<string | null> {
  try {
    log?.info?.(`开始读取文本文件: ${filePath}`);
    const text = fs.readFileSync(filePath, "utf-8").trim();

    if (text) {
      log?.info?.(`文本文件读取成功: ${filePath}, 文本长度=${text.length}`);
      return text;
    } else {
      log?.warn?.(`文本文件内容为空: ${filePath}`);
      return null;
    }
  } catch (err: any) {
    log?.error?.(`文本文件读取失败: ${filePath}, error=${err.message}`);
    return null;
  }
}

/**
 * 根据文件类型解析文件内容
 */
async function parseFileContent(
  filePath: string,
  fileName: string,
  log?: any,
): Promise<{ content: string | null; type: "text" | "binary" }> {
  const ext = path.extname(fileName).toLowerCase();

  // Word 文档
  if ([".docx", ".doc"].includes(ext)) {
    const content = await parseDocxFile(filePath, log);
    return { content, type: "text" };
  }

  // PDF 文档
  if (ext === ".pdf") {
    const content = await parsePdfFile(filePath, log);
    return { content, type: "text" };
  }

  // 纯文本文件
  if (
    [
      ".txt",
      ".md",
      ".json",
      ".xml",
      ".yaml",
      ".yml",
      ".csv",
      ".log",
      ".js",
      ".ts",
      ".py",
      ".java",
      ".c",
      ".cpp",
      ".h",
      ".sh",
      ".bat",
    ].includes(ext)
  ) {
    const content = await readTextFile(filePath, log);
    return { content, type: "text" };
  }

  // 二进制文件（不解析）
  return { content: null, type: "binary" };
}

// ============ 消息处理 ============

interface HandleMessageParams {
  accountId: string;
  config: DingtalkConfig;
  data: any;
  sessionWebhook: string;
  runtime?: RuntimeEnv;
  log?: any;
  cfg: ClawdbotConfig;
  /** 队列繁忙时已在入队阶段提前贴上了思考中表情，内部处理时跳过重复贴表情 */
  emotionAlreadyAdded?: boolean;
}

/**
 * 内部消息处理函数（实际执行消息处理逻辑）
 */
export async function handleDingTalkMessageInternal(params: HandleMessageParams): Promise<void> {
  const { accountId, config, data, sessionWebhook, runtime, cfg } = params;

  const log = createLoggerFromConfig(config, `DingTalk:${accountId}`);

  const content = extractMessageContent(data);
  if (!content.text && content.imageUrls.length === 0 && content.downloadCodes.length === 0) return;

  const isDirect = data.conversationType === "1";
  const senderId = data.senderStaffId || data.senderId;
  const senderName = data.senderNick || "Unknown";

  // ===== DM Policy 检查 =====
  if (isDirect) {
    const dmPolicy = config.dmPolicy || "open";
    const allowFrom: (string | number)[] = config.allowFrom || [];

    // 处理 pairing 策略（暂不支持，当作 open 处理并记录警告）
    if (dmPolicy === "pairing") {
      log?.warn?.(`dmPolicy="pairing" 暂不支持，将按 "open" 策略处理`);
      // 继续执行，不拦截
    }

    // 处理 allowlist 策略
    if (dmPolicy === "allowlist") {
      if (!senderId) {
        log?.warn?.(`DM 被拦截: senderId 为空`);
        return;
      }

      // 规范化 senderId 和 allowFrom 进行比较（支持 string 和 number 类型）
      const normalizedSenderId = String(senderId);
      const normalizedAllowFrom = allowFrom.map((id) => String(id));

      // 白名单为空时拦截所有（虽然 Schema 验证会阻止这种情况，但代码层面也要防御）
      if (normalizedAllowFrom.length === 0) {
        log?.warn?.(`[DingTalk] DM 被拦截: allowFrom 白名单为空，拒绝所有请求`);

        try {
          await sendProactive(
            config,
            { userId: senderId },
            "抱歉，此机器人的访问白名单配置有误。请联系管理员检查配置。",
            {
              msgType: "text",
              useAICard: false,
              fallbackToNormal: true,
              log,
            },
          );
        } catch (err: any) {
          log?.error?.(`[DingTalk] 发送 DM 配置错误提示失败: ${err.message}`);
        }
        return;
      }

      // 检查是否在白名单中
      if (!normalizedAllowFrom.includes(normalizedSenderId)) {
        log?.warn?.(`DM 被拦截: senderId=${senderId} (${senderName}) 不在白名单中`);

        try {
          await sendProactive(
            config,
            { userId: senderId },
            "抱歉，您暂无权限使用此机器人。如需开通权限，请联系管理员。",
            {
              msgType: "text",
              useAICard: false,
              fallbackToNormal: true,
              log,
            },
          );
        } catch (err: any) {
          log?.error?.(`发送 DM 拦截提示失败: ${err.message}`);
        }
        return;
      }
    }
  }

  // ===== 群聊 Policy 检查 =====
  if (!isDirect) {
    const groupPolicy = config.groupPolicy || "open";
    const conversationId = data.conversationId;
    const groupAllowFrom: (string | number)[] = config.groupAllowFrom || [];

    // 处理 disabled 策略
    if (groupPolicy === "disabled") {
      log?.warn?.(`群聊被拦截: groupPolicy=disabled`);

      try {
        await sendProactive(
          config,
          { openConversationId: conversationId },
          "抱歉，此机器人暂不支持群聊功能。",
          {
            msgType: "text",
            useAICard: false,
            fallbackToNormal: true,
            log,
          },
        );
      } catch (err: any) {
        log?.error?.(`发送群聊 disabled 提示失败: ${err.message}`);
      }
      return;
    }

    // 处理 allowlist 策略
    if (groupPolicy === "allowlist") {
      if (!conversationId) {
        log?.warn?.(`群聊被拦截: conversationId 为空`);
        return;
      }

      // 规范化 conversationId 和 groupAllowFrom 进行比较（支持 string 和 number 类型）
      const normalizedConversationId = String(conversationId);
      const normalizedGroupAllowFrom = groupAllowFrom.map((id) => String(id));

      // 白名单为空时拦截所有（虽然 Schema 验证会阻止这种情况，但代码层面也要防御）
      if (normalizedGroupAllowFrom.length === 0) {
        log?.warn?.(`群聊被拦截: groupAllowFrom 白名单为空，拒绝所有请求`);

        try {
          await sendProactive(
            config,
            { openConversationId: conversationId },
            "抱歉，此机器人的群组访问白名单配置有误。请联系管理员检查配置。",
            {
              msgType: "text",
              useAICard: false,
              fallbackToNormal: true,
              log,
            },
          );
        } catch (err: any) {
          log?.error?.(`发送群聊配置错误提示失败: ${err.message}`);
        }
        return;
      }

      // 检查是否在白名单中
      if (!normalizedGroupAllowFrom.includes(normalizedConversationId)) {
        log?.warn?.(`群聊被拦截: conversationId=${conversationId} 不在 groupAllowFrom 白名单中`);

        try {
          await sendProactive(
            config,
            { openConversationId: conversationId },
            "抱歉，此群组暂无权限使用此机器人。如需开通权限，请联系管理员。",
            {
              msgType: "text",
              useAICard: false,
              fallbackToNormal: true,
              log,
            },
          );
        } catch (err: any) {
          log?.error?.(`发送群聊 allowlist 提示失败: ${err.message}`);
        }
        return;
      }
    }
  }

  // 构建会话上下文
  const sessionContext = buildSessionContext({
    accountId,
    senderId,
    senderName,
    conversationType: data.conversationType,
    conversationId: data.conversationId,
    groupSubject: data.conversationTitle,
    separateSessionByConversation: config.separateSessionByConversation,
    groupSessionScope: config.groupSessionScope,
    sharedMemoryAcrossConversations: config.sharedMemoryAcrossConversations,
  });

  // ===== 解析 agentId 和工作空间路径（在 sessionContext 之后，确保 chatType 与会话隔离策略一致）=====
  // 使用 sessionContext.peerId 进行匹配（真实的 conversationId/senderId，与 match.peer.id 语义一致）。
  // 注意：不能使用 sessionContext.sessionPeerId，它受 sharedMemoryAcrossConversations 等配置影响，
  // 可能被设为 accountId，导致不同群/用户的消息匹配到同一个 binding，路由错误。
  let matchedAgentId: string | null = null;
  if (cfg.bindings && cfg.bindings.length > 0) {
    for (const binding of cfg.bindings) {
      const match = binding.match;
      if (match.channel && match.channel !== "dingtalk") continue;
      if (match.accountId && match.accountId !== accountId) continue;
      if (match.peer) {
        if (match.peer.kind && match.peer.kind !== sessionContext.chatType) continue;
        if (match.peer.id && match.peer.id !== "*" && match.peer.id !== sessionContext.peerId)
          continue;
      }
      matchedAgentId = binding.agentId;
      break;
    }
  }
  if (!matchedAgentId) {
    matchedAgentId = cfg.defaultAgent || "main";
  }

  // 获取 Agent 工作空间路径
  const agentWorkspaceDir = resolveAgentWorkspaceDir(cfg, matchedAgentId);
  log?.info?.(`Agent 工作空间路径: ${agentWorkspaceDir}`);

  // 构建消息内容
  // ✅ 使用 normalizeSlashCommand 归一化新会话命令
  const rawText = content.text || "";

  // 归一化命令（将 /reset、/clear、新会话 等别名统一为 /new）
  const normalizedText = normalizeSlashCommand(rawText);
  let userContent = normalizedText || (content.imageUrls.length > 0 ? "请描述这张图片" : "");

  // ===== 图片下载到本地文件 =====
  const imageLocalPaths: string[] = [];

  log?.info?.(
    `处理消息: accountId=${accountId}, data= ${JSON.stringify(data, null, 2)}, sender=${senderName}, text=${content.text.slice(0, 50)}...`,
  );

  // 处理 imageUrls（来自富文本消息）
  for (let i = 0; i < content.imageUrls.length; i++) {
    const url = content.imageUrls[i];
    try {
      log?.info?.(`处理图片 ${i + 1}/${content.imageUrls.length}: ${url.slice(0, 50)}...`);

      if (url.startsWith("downloadCode:")) {
        const code = url.slice("downloadCode:".length);
        const localPath = await downloadMediaByCode(code, config, agentWorkspaceDir, log);
        if (localPath) {
          imageLocalPaths.push(localPath);
          log?.info?.(`图片下载成功 ${i + 1}/${content.imageUrls.length}`);
        } else {
          log?.warn?.(`图片下载失败 ${i + 1}/${content.imageUrls.length}`);
        }
      } else {
        const localPath = await downloadImageToFile(url, agentWorkspaceDir, log);
        if (localPath) {
          imageLocalPaths.push(localPath);
          log?.info?.(`图片下载成功 ${i + 1}/${content.imageUrls.length}`);
        } else {
          log?.warn?.(`图片下载失败 ${i + 1}/${content.imageUrls.length}`);
        }
      }
    } catch (err: any) {
      log?.error?.(`图片下载异常 ${i + 1}/${content.imageUrls.length}: ${err.message}`);
    }
  }

  // 处理 downloadCodes（来自 picture 消息，fileNames 为空的是图片）
  for (let i = 0; i < content.downloadCodes.length; i++) {
    const code = content.downloadCodes[i];
    const fileName = content.fileNames[i];
    if (!fileName) {
      try {
        log?.info?.(`处理 downloadCode 图片 ${i + 1}/${content.downloadCodes.length}`);
        const localPath = await downloadMediaByCode(code, config, agentWorkspaceDir, log);
        if (localPath) {
          imageLocalPaths.push(localPath);
          log?.info?.(`downloadCode 图片下载成功 ${i + 1}/${content.downloadCodes.length}`);
        } else {
          log?.warn?.(`downloadCode 图片下载失败 ${i + 1}/${content.downloadCodes.length}`);
        }
      } catch (err: any) {
        log?.error?.(
          `downloadCode 图片下载异常 ${i + 1}/${content.downloadCodes.length}: ${err.message}`,
        );
      }
    }
  }

  log?.info?.(
    `图片下载完成: 成功=${imageLocalPaths.length}, 总数=${content.imageUrls.length + content.downloadCodes.filter((_, i) => !content.fileNames[i]).length}`,
  );

  // ===== 文件附件处理：自动下载并解析内容 =====
  const fileContentParts: string[] = [];
  for (let i = 0; i < content.downloadCodes.length; i++) {
    const code = content.downloadCodes[i];
    const fileName = content.fileNames[i];
    if (!fileName) continue;

    try {
      log?.info?.(`处理文件附件 ${i + 1}/${content.downloadCodes.length}: ${fileName}`);

      // 获取下载链接
      const downloadUrl = await getFileDownloadUrl(code, fileName, config, log);
      if (!downloadUrl) {
        fileContentParts.push(`⚠️ 文件获取失败: ${fileName}`);
        continue;
      }

      // 下载文件到本地
      const localPath = await downloadFileToLocal(downloadUrl, fileName, agentWorkspaceDir, log);
      if (!localPath) {
        fileContentParts.push(`⚠️ 文件下载失败: ${fileName}\n🔗 [点击下载](${downloadUrl})`);
        continue;
      }

      // 识别文件类型
      const ext = path.extname(fileName).toLowerCase();
      let fileType = "文件";

      if ([".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".webm"].includes(ext)) {
        fileType = "视频";
      } else if ([".mp3", ".wav", ".aac", ".ogg", ".m4a", ".flac", ".wma"].includes(ext)) {
        fileType = "音频";
      } else if ([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"].includes(ext)) {
        fileType = "图片";
      } else if (
        [
          ".txt",
          ".md",
          ".json",
          ".xml",
          ".yaml",
          ".yml",
          ".csv",
          ".log",
          ".js",
          ".ts",
          ".py",
          ".java",
          ".c",
          ".cpp",
          ".h",
          ".sh",
          ".bat",
        ].includes(ext)
      ) {
        fileType = "文本文件";
      } else if ([".docx", ".doc"].includes(ext)) {
        fileType = "Word 文档";
      } else if (ext === ".pdf") {
        fileType = "PDF 文档";
      } else if ([".xlsx", ".xls"].includes(ext)) {
        fileType = "Excel 表格";
      } else if ([".pptx", ".ppt"].includes(ext)) {
        fileType = "PPT 演示文稿";
      } else if ([".zip", ".rar", ".7z", ".tar", ".gz"].includes(ext)) {
        fileType = "压缩包";
      }

      // 解析文件内容
      const parseResult = await parseFileContent(localPath, fileName, log);

      if (parseResult.type === "text" && parseResult.content) {
        // 文本类文件：将内容注入到上下文（即使解析成功也给出文件路径）
        const contentPreview =
          parseResult.content.length > 200
            ? parseResult.content.slice(0, 200) + "..."
            : parseResult.content;

        fileContentParts.push(
          `📄 **${fileType}**: ${fileName}\n` +
            `✅ 已解析文件内容（${parseResult.content.length} 字符）\n` +
            `💾 已保存到本地: ${localPath}\n` +
            `📝 内容预览:\n\`\`\`\n${contentPreview}\n\`\`\`\n\n` +
            `📋 完整内容:\n${parseResult.content}`,
        );
        log?.info?.(`文件解析成功: ${fileName}, 内容长度=${parseResult.content.length}`);
      } else if (parseResult.type === "text" && !parseResult.content) {
        // 文本类文件但解析失败
        fileContentParts.push(
          `📄 **${fileType}**: ${fileName}\n` +
            `⚠️ 文件解析失败，已保存到本地\n` +
            `💾 本地路径: ${localPath}\n` +
            `🔗 [点击下载](${downloadUrl})`,
        );
        log?.warn?.(`文件解析失败: ${fileName}`);
      } else {
        // 二进制文件：只保存到磁盘
        // 特殊处理音频文件的语音识别文本
        if (fileType === "音频" && content.text && content.text !== "[语音消息]") {
          fileContentParts.push(
            `🎤 **${fileType}**: ${fileName}\n` +
              `📝 语音识别: ${content.text}\n` +
              `💾 已保存到本地: ${localPath}\n` +
              `🔗 [点击下载](${downloadUrl})`,
          );
        } else {
          fileContentParts.push(
            `📎 **${fileType}**: ${fileName}\n` +
              `💾 已保存到本地: ${localPath}\n` +
              `🔗 [点击下载](${downloadUrl})`,
          );
        }
        log?.info?.(`二进制文件已保存: ${fileName}, path=${localPath}`);
      }
    } catch (err: any) {
      log?.error?.(`文件处理异常: ${fileName}, error=${err.message}`);
      fileContentParts.push(`⚠️ 文件处理失败: ${fileName}`);
    }
  }

  if (fileContentParts.length > 0) {
    const fileText = fileContentParts.join("\n\n");
    userContent = userContent ? `${userContent}\n\n${fileText}` : fileText;
  }

  if (!userContent && imageLocalPaths.length === 0) return;

  // ===== 贴处理中表情 =====
  // 若队列繁忙时已在入队阶段提前贴过表情，此处跳过，避免重复贴
  if (!params.emotionAlreadyAdded) {
    addEmotionReply(config, data, log).catch((err) => {
      log?.warn?.(`贴表情失败: ${err.message}`);
    });
  }

  // ===== 异步模式：立即回执 + 后台执行 + 主动推送结果 =====
  const asyncMode = config.asyncMode === true;
  log?.info?.(`asyncMode 检测: config.asyncMode=${config.asyncMode}, asyncMode=${asyncMode}`);

  const proactiveTarget = isDirect
    ? { userId: senderId }
    : { openConversationId: data.conversationId };

  if (asyncMode) {
    log?.info?.(`进入异步模式分支`);
    const ackText = config.ackText || "🫡 任务已接收，处理中...";
    try {
      await sendProactive(config, proactiveTarget, ackText, {
        msgType: "text",
        useAICard: false,
        fallbackToNormal: true,
        log,
      });
    } catch (ackErr: any) {
      log?.warn?.(`Failed to send acknowledgment: ${ackErr?.message || ackErr}`);
    }
  }

  // ===== 使用 SDK 的 dispatchReplyFromConfig =====
  try {
    const core = getDingtalkRuntime();

    // 构建消息体（添加图片）
    let finalContent = userContent;
    if (imageLocalPaths.length > 0) {
      const imageMarkdown = imageLocalPaths.map((p) => `![image](file://${p})`).join("\n");
      finalContent = finalContent ? `${finalContent}\n\n${imageMarkdown}` : imageMarkdown;
    }

    // 构建 envelope 格式的消息
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const envelopeFrom = isDirect ? senderId : `${data.conversationId}:${senderId}`;

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "DingTalk",
      from: envelopeFrom,
      timestamp: new Date(),
      envelope: envelopeOptions,
      body: finalContent,
    });

    // matchedAgentId 已在 sessionContext 构建之后通过 bindings 匹配确定，此处直接使用
    const matchedBy = matchedAgentId !== (cfg.defaultAgent || "main") ? "binding" : "default";

    // ✅ 使用 SDK 标准方法构建 sessionKey，符合 OpenClaw 规范
    // 格式：agent:{agentId}:{channel}:{peerKind}:{sessionPeerId}
    // ✅ 使用 sessionContext.sessionPeerId 构建 sessionKey，确保会话隔离配置生效
    // ✅ 关键修复：传递 dmScope 参数，让 SDK 使用配置文件中的 session.dmScope 设置
    const dmScope = cfg.session?.dmScope || "per-channel-peer";
    log?.info?.(
      `🔍 构建 sessionKey 前的参数: agentId=${matchedAgentId}, channel=dingtalk, accountId=${accountId}, chatType=${sessionContext.chatType}, sessionPeerId=${sessionContext.sessionPeerId}, dmScope=${dmScope}`,
    );
    const sessionKey = core.channel.routing.buildAgentSessionKey({
      agentId: matchedAgentId,
      channel: "dingtalk", // ✅ 使用 'dingtalk' 而不是 'dingtalk'
      accountId: accountId,
      peer: {
        kind: sessionContext.chatType, // ✅ 使用 sessionContext.chatType
        id: sessionContext.sessionPeerId, // ✅ 使用 sessionContext.sessionPeerId（包含会话隔离逻辑）
      },
      dmScope: dmScope, // ✅ 传递 dmScope 参数，确保生成完整格式的 sessionKey
    });
    log?.info?.(
      `路由解析完成: agentId=${matchedAgentId}, sessionKey=${sessionKey}, matchedBy=${matchedBy}`,
    );

    // 构建 inbound context，使用解析后的 sessionKey
    log?.info?.(`开始构建 inbound context...`);

    // ✅ 计算正确的 To 字段
    const toField = isDirect ? senderId : data.conversationId;
    log?.info?.(
      `构建 inbound context: isDirect=${isDirect}, senderId=${senderId}, conversationId=${data.conversationId}, To=${toField}`,
    );

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: finalContent,
      RawBody: userContent,
      CommandBody: userContent,
      From: senderId,
      To: toField, // ✅ 修复：单聊用 senderId，群聊用 conversationId
      SessionKey: sessionKey, // ✅ 使用手动匹配的 sessionKey
      AccountId: accountId,
      ChatType: sessionContext.chatType,
      GroupSubject: isDirect ? undefined : data.conversationTitle,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "dingtalk" as const,
      Surface: "dingtalk" as const,
      MessageSid: data.msgId,
      Timestamp: Date.now(),
      CommandAuthorized: true,
      OriginatingChannel: "dingtalk" as const,
      OriginatingTo: toField, // ✅ 修复：应该使用 toField，而不是 accountId
      // 当前机器人的加密身份（用于多机器人协作时让上层 Agent 引用 / 互相 @）
      BotChatbotUserId: data.chatbotUserId,
      BotChatbotCorpId: data.chatbotCorpId,
    } as any);

    // 创建 reply dispatcher，使用解析后的 agentId
    const { dispatcher, replyOptions, markDispatchIdle, getAsyncModeResponse } =
      createDingtalkReplyDispatcher({
        cfg,
        agentId: matchedAgentId, // ✅ 使用手动匹配的 agentId
        runtime: runtime as RuntimeEnv,
        conversationId: data.conversationId,
        senderId,
        isDirect,
        accountId,
        messageCreateTimeMs: Date.now(),
        sessionWebhook: data.sessionWebhook,
        asyncMode,
      });

    // ===== 注入当前 bot 的 clientId（用于 dws CLI --client-id 参数） =====
    // 多 bot 场景下，AI 需要知道当前对话属于哪个 bot，以便在调用
    // dws chat message send-by-bot 时传入正确的 --client-id，避免消息串台。
    if (config.clientId) {
      const botIdentityHint = `[DingTalk Bot Context] Current bot clientId: ${String(config.clientId)}. When executing \`dws chat message send-by-bot\`, always pass \`--client-id ${String(config.clientId)}\` to ensure messages are sent from the correct bot.`;
      finalContent = finalContent ? `${finalContent}\n\n${botIdentityHint}` : botIdentityHint;
    }

    // ===== 构建卡片链接路由指令（对齐 Rust agent_support.rs build_link_routing_prompt）=====
    // 识别 interactiveCard / actionCard 消息中的 URL，根据 host 注入不同的 AI 指令：
    // - alidocs.dingtalk.com → 使用 dingtalk-workspace skill 读取（同时尝试 doc 和 AI table workflow）
    // - 其他 URL → 使用 read_url 读取
    // 注：SDK 的 replyOptions 不支持 extraSystemPrompt，改为追加到消息内容中传递给 AI
    const linkRoutingPrompt = buildLinkRoutingPrompt(content);
    if (linkRoutingPrompt) {
      finalContent = finalContent ? `${finalContent}\n\n${linkRoutingPrompt}` : linkRoutingPrompt;
      log?.info?.(`注入卡片链接路由指令: ${linkRoutingPrompt.slice(0, 100)}...`);
    }

    // 使用 SDK 的 dispatchReplyFromConfig
    const dispatchResult = await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => {
        markDispatchIdle();
      },
      run: async () => {
        const result = await core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions,
        });
        return result;
      },
    });

    const { queuedFinal, counts } = dispatchResult;

    log.info?.(
      `[DingTalk][dispatch] dispatchReplyFromConfig 完成: queuedFinal=${queuedFinal}, counts=${JSON.stringify(counts)}`,
    );

    // ===== 异步模式：主动推送最终结果 =====
    if (asyncMode) {
      try {
        const fullResponse = getAsyncModeResponse();
        const oapiToken = await getOapiAccessToken(config);
        let finalText = fullResponse;

        if (oapiToken) {
          finalText = await processLocalImages(finalText, oapiToken, log);

          const mediaTarget: AICardTarget = isDirect
            ? { type: "user", userId: senderId }
            : { type: "group", openConversationId: data.conversationId };

          // ✅ 处理 Markdown 标记格式的媒体文件
          finalText = await processVideoMarkers(
            finalText,
            "",
            config,
            oapiToken,
            log,
            true, // ✅ 使用主动 API 模式
            mediaTarget,
          );
          finalText = await processAudioMarkers(
            finalText,
            "",
            config,
            oapiToken,
            log,
            true, // ✅ 使用主动 API 模式
            mediaTarget,
          );
          finalText = await uploadAndReplaceFileMarkers(
            finalText,
            "",
            config,
            oapiToken,
            log,
            true, // ✅ 使用主动 API 模式
            mediaTarget,
          );

          // ✅ 处理裸露的本地文件路径（绕过 OpenClaw SDK 的 bug）
          const { processRawMediaPaths } = await import("../services/media");
          finalText = await processRawMediaPaths(finalText, config, oapiToken, log, mediaTarget);
        }

        const textToSend = finalText.trim() || "✅ 任务执行完成（无文本输出）";
        const title =
          textToSend
            .split("\n")[0]
            ?.replace(/^[#*\s\->]+/, "")
            .trim() || "消息";
        await sendProactive(config, proactiveTarget, textToSend, {
          msgType: "markdown",
          title,
          useAICard: false,
          fallbackToNormal: true,
          log,
        });
      } catch (asyncErr: any) {
        const errMsg = `⚠️ 任务执行失败: ${asyncErr?.message || asyncErr}`;
        try {
          await sendProactive(config, proactiveTarget, errMsg, {
            msgType: "text",
            useAICard: false,
            fallbackToNormal: true,
            log,
          });
        } catch (sendErr: any) {
          log?.error?.(`错误通知发送失败: ${sendErr?.message || sendErr}`);
        }
      }
    }
  } catch (err: any) {
    log?.error?.(`SDK dispatch 失败: ${err.message}`);

    // 降级：发送错误消息
    try {
      const token = await getAccessToken(config);
      const body: any = {
        msgtype: "text",
        text: { content: `抱歉，处理请求时出错: ${err.message}` },
      };
      if (!isDirect) body.at = { atUserIds: [senderId], isAtAll: false };

      await dingtalkHttp.post(sessionWebhook, body, {
        headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      });
    } catch (fallbackErr: any) {
      log?.error?.(`错误消息发送也失败: ${fallbackErr.message}`);
    }
  }

  // ===== 撤回处理中表情 =====
  // 使用 await 确保表情撤销完成后再结束函数
  try {
    await recallEmotionReply(config, data, log);
  } catch (err: any) {
    log?.warn?.(`撤回表情异常: ${err.message}`);
  }
}

/**
 * 消息处理入口函数（带队列管理）
 * 确保同一会话+agent的消息按顺序处理，避免并发冲突
 */
export async function handleDingTalkMessage(params: HandleMessageParams): Promise<void> {
  const { accountId, config, data, log, cfg } = params;

  // 使用 buildSessionContext 构建会话标识，与 handleDingTalkMessageInternal 保持一致
  // 确保 queueKey 的隔离策略（groupSessionScope、sharedMemoryAcrossConversations）与 sessionKey 一致
  const isDirect = data.conversationType === "1";
  const senderId = data.senderStaffId || data.senderId;
  const conversationId = data.conversationId;

  const queueSessionContext = buildSessionContext({
    accountId,
    senderId,
    conversationType: data.conversationType,
    conversationId,
    separateSessionByConversation: config.separateSessionByConversation,
    groupSessionScope: config.groupSessionScope,
    sharedMemoryAcrossConversations: config.sharedMemoryAcrossConversations,
  });

  const baseSessionId = queueSessionContext.sessionPeerId;

  if (!baseSessionId) {
    log?.warn?.("无法构建会话标识，跳过队列管理");
    return handleDingTalkMessageInternal(params);
  }

  // 解析 agentId：使用 queueSessionContext.peerId（真实 peer 标识）进行匹配
  // 与 handleDingTalkMessageInternal 中的匹配逻辑保持一致。
  // 必须使用 peerId 而非 sessionPeerId，原因：sharedMemoryAcrossConversations=true 时
  // sessionPeerId 被设为 accountId，导致不同群的消息匹配到同一个 binding。
  let matchedAgentId: string | null = null;
  if (cfg.bindings && cfg.bindings.length > 0) {
    for (const binding of cfg.bindings) {
      const match = binding.match;
      if (match.channel && match.channel !== "dingtalk") continue;
      if (match.accountId && match.accountId !== accountId) continue;
      if (match.peer) {
        if (match.peer.kind && match.peer.kind !== queueSessionContext.chatType) continue;
        if (match.peer.id && match.peer.id !== "*" && match.peer.id !== queueSessionContext.peerId)
          continue;
      }
      matchedAgentId = binding.agentId;
      break;
    }
  }
  if (!matchedAgentId) {
    matchedAgentId = cfg.defaultAgent || "main";
  }

  // 构建队列标识：会话 peerId + agentId
  // queueKey 与 sessionKey 使用相同的 peerId，确保隔离策略一致：
  // - groupSessionScope: 'group_sender' 时，同群不同用户的消息可并行处理
  // - sharedMemoryAcrossConversations: true 时，所有消息共享同一队列
  const queueKey = `${baseSessionId}:${matchedAgentId}`;

  try {
    // 更新会话活跃时间
    sessionLastActivity.set(queueKey, Date.now());

    // 检测队列是否繁忙（入队前检查，此时 previousTask 尚未被当前消息覆盖）
    const isQueueBusy = sessionQueues.has(queueKey);

    // 获取该会话+agent的上一个处理任务
    const previousTask = sessionQueues.get(queueKey) || Promise.resolve();

    if (isQueueBusy) {
      const ackPhrases = QUEUE_BUSY_ACK_PHRASES;
      const ackText = ackPhrases[Math.floor(Math.random() * ackPhrases.length)];

      try {
        await sendProactive(config, { openConversationId: data.conversationId }, ackText, {
          msgType: "text",
          useAICard: false,
          fallbackToNormal: true,
        });
        log?.info?.(`[队列] 队列繁忙，已发送文本 ACK`);
      } catch (ackErr: any) {
        log?.warn?.(`[队列] 发送 ACK 失败: ${ackErr?.message || ackErr}`);
      }
    }

    const currentTask = previousTask
      .then(async () => {
        log?.info?.(`[队列] 开始处理消息，queueKey=${queueKey}`);
        await handleDingTalkMessageInternal({ ...params, emotionAlreadyAdded: isQueueBusy });
        log?.info?.(`[队列] 消息处理完成，queueKey=${queueKey}`);
      })
      .catch((err: any) => {
        log?.error?.(`[队列] 消息处理异常，queueKey=${queueKey}, error=${err.message}`);
        // 不抛出错误，避免阻塞后续消息
      })
      .finally(() => {
        // 如果当前任务是队列中的最后一个任务，清理队列
        if (sessionQueues.get(queueKey) === currentTask) {
          sessionQueues.delete(queueKey);
          log?.info?.(`[队列] 队列已清空，queueKey=${queueKey}`);
        }
      });

    // 更新队列
    sessionQueues.set(queueKey, currentTask);

    // 不等待任务完成，立即返回，不阻塞 WebSocket 消息接收
    // 消息处理在后台异步执行，队列保证同一会话+agent的消息串行处理
  } catch (err: any) {
    log?.error?.(`[队列] 队列管理异常，直接处理: ${err.message}`);
    // 如果队列管理失败，直接调用内部处理函数（不阻塞）
    void handleDingTalkMessageInternal(params);
  }
}

// handleDingTalkMessage 已在函数定义处直接导出
