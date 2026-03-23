/**
 * 出站消息投递模块
 *
 * 从 gateway deliver 回调中提取的两大发送管线：
 * 1. parseAndSendMediaTags — 解析 <qqimg/qqvoice/qqvideo/qqfile/qqmedia> 标签并按顺序发送
 * 2. sendPlainReply — 处理不含媒体标签的普通回复（markdown 图片/纯文本+图片）
 */

import {
  sendC2CMessage,
  sendGroupMessage,
  sendChannelMessage,
  sendC2CImageMessage,
  sendGroupImageMessage,
} from "./api.js";
import { chunkText, TEXT_CHUNK_LIMIT } from "./channel.js";
import {
  sendPhoto,
  sendVoice,
  sendVideoMsg,
  sendDocument,
  sendMedia as sendMediaAuto,
  type MediaTargetContext,
} from "./outbound.js";
import { getQQBotRuntime } from "./runtime.js";
import type { ResolvedQQBotAccount } from "./types.js";
import { getImageSize, formatQQBotMarkdownImage, hasQQBotImageSize } from "./utils/image-size.js";
import { normalizeMediaTags } from "./utils/media-tags.js";
import { normalizePath, isLocalPath as isLocalFilePath } from "./utils/platform.js";
import { filterInternalMarkers } from "./utils/text-parsing.js";

// ============ 类型定义 ============

export interface DeliverEventContext {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  messageId: string;
  channelId?: string;
  groupOpenid?: string;
  msgIdx?: string;
}

export interface DeliverAccountContext {
  account: ResolvedQQBotAccount;
  qualifiedTarget: string;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/** token 重试包装 */
export type SendWithRetryFn = <T>(sendFn: (token: string) => Promise<T>) => Promise<T>;

/** 一次性消费引用 ref */
export type ConsumeQuoteRefFn = () => string | undefined;

// ============ 1. 媒体标签解析 + 发送 ============

/**
 * 解析回复文本中的媒体标签并按顺序发送。
 *
 * @returns true 如果检测到媒体标签并已处理；false 表示无媒体标签，调用方继续走普通文本管线
 */
export async function parseAndSendMediaTags(
  replyText: string,
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
): Promise<{ handled: boolean; normalizedText: string }> {
  const { account, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;

  // 预处理：纠正小模型常见的标签拼写错误和格式问题
  const text = normalizeMediaTags(replyText);

  const mediaTagRegex =
    /<(qqimg|qqvoice|qqvideo|qqfile|qqmedia)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|qqmedia|img)>/gi;
  const mediaTagMatches = [...text.matchAll(mediaTagRegex)];

  if (mediaTagMatches.length === 0) {
    return { handled: false, normalizedText: text };
  }

  const tagCounts = mediaTagMatches.reduce(
    (acc, m) => {
      const t = m[1]!.toLowerCase();
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  log?.info(
    `${prefix} Detected media tags: ${Object.entries(tagCounts)
      .map(([k, v]) => `${v} <${k}>`)
      .join(", ")}`,
  );

  // 构建发送队列
  type QueueItem = {
    type: "text" | "image" | "voice" | "video" | "file" | "media";
    content: string;
  };
  const sendQueue: QueueItem[] = [];

  let lastIndex = 0;
  const regex2 =
    /<(qqimg|qqvoice|qqvideo|qqfile|qqmedia)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|qqmedia|img)>/gi;
  let match;

  while ((match = regex2.exec(text)) !== null) {
    const textBefore = text
      .slice(lastIndex, match.index)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (textBefore) {
      sendQueue.push({ type: "text", content: filterInternalMarkers(textBefore) });
    }

    const tagName = match[1]!.toLowerCase();
    let mediaPath = decodeMediaPath(match[2]?.trim() ?? "", log, prefix);

    if (mediaPath) {
      const typeMap: Record<string, QueueItem["type"]> = {
        qqmedia: "media",
        qqvoice: "voice",
        qqvideo: "video",
        qqfile: "file",
      };
      const itemType = typeMap[tagName] ?? "image";
      sendQueue.push({ type: itemType, content: mediaPath });
      log?.info(`${prefix} Found ${itemType} in <${tagName}>: ${mediaPath}`);
    }

    lastIndex = match.index + match[0].length;
  }

  const textAfter = text
    .slice(lastIndex)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (textAfter) {
    sendQueue.push({ type: "text", content: filterInternalMarkers(textAfter) });
  }

  log?.info(`${prefix} Send queue: ${sendQueue.map((item) => item.type).join(" -> ")}`);

  // 按顺序发送
  const mediaTarget: MediaTargetContext = {
    targetType: event.type === "c2c" ? "c2c" : event.type === "group" ? "group" : "channel",
    targetId:
      event.type === "c2c"
        ? event.senderId
        : event.type === "group"
          ? event.groupOpenid!
          : event.channelId!,
    account,
    replyToId: event.messageId,
    logPrefix: prefix,
  };

  for (const item of sendQueue) {
    if (item.type === "text") {
      await sendTextChunks(item.content, event, actx, sendWithRetry, consumeQuoteRef);
    } else if (item.type === "image") {
      const result = await sendPhoto(mediaTarget, item.content);
      if (result.error) log?.error(`${prefix} sendPhoto error: ${result.error}`);
    } else if (item.type === "voice") {
      await sendVoiceWithTimeout(mediaTarget, item.content, account, log, prefix);
    } else if (item.type === "video") {
      const result = await sendVideoMsg(mediaTarget, item.content);
      if (result.error) log?.error(`${prefix} sendVideoMsg error: ${result.error}`);
    } else if (item.type === "file") {
      const result = await sendDocument(mediaTarget, item.content);
      if (result.error) log?.error(`${prefix} sendDocument error: ${result.error}`);
    } else if (item.type === "media") {
      const result = await sendMediaAuto({
        to: actx.qualifiedTarget,
        text: "",
        mediaUrl: item.content,
        accountId: account.accountId,
        replyToId: event.messageId,
        account,
      });
      if (result.error) log?.error(`${prefix} sendMedia(auto) error: ${result.error}`);
    }
  }

  return { handled: true, normalizedText: text };
}

// ============ 2. 非结构化消息发送（普通文本 + 图片） ============

export interface PlainReplyPayload {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
}

/**
 * 发送不含媒体标签的普通回复。
 * 处理 markdown 图片嵌入、Base64 富媒体、纯文本分块、本地媒体自动路由。
 */
export async function sendPlainReply(
  payload: PlainReplyPayload,
  replyText: string,
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
  toolMediaUrls: string[],
): Promise<void> {
  const { account, qualifiedTarget, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;

  const collectedImageUrls: string[] = [];
  const localMediaToSend: string[] = [];

  const collectImageUrl = (url: string | undefined | null): boolean => {
    if (!url) return false;
    const isHttpUrl = url.startsWith("http://") || url.startsWith("https://");
    const isDataUrl = url.startsWith("data:image/");
    if (isHttpUrl || isDataUrl) {
      if (!collectedImageUrls.includes(url)) {
        collectedImageUrls.push(url);
        log?.info(
          `${prefix} Collected ${isDataUrl ? "Base64" : "media URL"}: ${isDataUrl ? `(length: ${url.length})` : url.slice(0, 80) + "..."}`,
        );
      }
      return true;
    }
    if (isLocalFilePath(url)) {
      if (!localMediaToSend.includes(url)) {
        localMediaToSend.push(url);
        log?.info(`${prefix} Collected local media for auto-routing: ${url}`);
      }
      return true;
    }
    return false;
  };

  if (payload.mediaUrls?.length) {
    for (const url of payload.mediaUrls) collectImageUrl(url);
  }
  if (payload.mediaUrl) collectImageUrl(payload.mediaUrl);

  // 提取 markdown 图片
  const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/gi;
  const mdMatches = [...replyText.matchAll(mdImageRegex)];
  for (const m of mdMatches) {
    const url = m[2]?.trim();
    if (url && !collectedImageUrls.includes(url)) {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        collectedImageUrls.push(url);
        log?.info(`${prefix} Extracted HTTP image from markdown: ${url.slice(0, 80)}...`);
      } else if (isLocalFilePath(url)) {
        if (!localMediaToSend.includes(url)) {
          localMediaToSend.push(url);
          log?.info(`${prefix} Collected local media from markdown for auto-routing: ${url}`);
        }
      }
    }
  }

  // 提取裸 URL 图片
  const bareUrlRegex =
    /(?<![(\["'])(https?:\/\/[^\s)"'<>]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s"'<>]*)?)/gi;
  const bareUrlMatches = [...replyText.matchAll(bareUrlRegex)];
  for (const m of bareUrlMatches) {
    const url = m[1];
    if (url && !collectedImageUrls.includes(url)) {
      collectedImageUrls.push(url);
      log?.info(`${prefix} Extracted bare image URL: ${url.slice(0, 80)}...`);
    }
  }

  const useMarkdown = account.markdownSupport === true;
  log?.info(`${prefix} Markdown mode: ${useMarkdown}, images: ${collectedImageUrls.length}`);

  let textWithoutImages = filterInternalMarkers(replyText);

  if (useMarkdown) {
    await sendMarkdownReply(
      textWithoutImages,
      collectedImageUrls,
      mdMatches,
      bareUrlMatches,
      event,
      actx,
      sendWithRetry,
      consumeQuoteRef,
    );
  } else {
    await sendPlainTextReply(
      textWithoutImages,
      collectedImageUrls,
      mdMatches,
      bareUrlMatches,
      event,
      actx,
      sendWithRetry,
      consumeQuoteRef,
    );
  }

  // 发送本地媒体（由 payload.mediaUrl 或 markdown 本地路径触发）
  if (localMediaToSend.length > 0) {
    log?.info(
      `${prefix} Sending ${localMediaToSend.length} local media via sendMedia auto-routing`,
    );
    for (const mediaPath of localMediaToSend) {
      try {
        const result = await sendMediaAuto({
          to: qualifiedTarget,
          text: "",
          mediaUrl: mediaPath,
          accountId: account.accountId,
          replyToId: event.messageId,
          account,
        });
        if (result.error)
          log?.error(`${prefix} sendMedia(auto) error for ${mediaPath}: ${result.error}`);
        else log?.info(`${prefix} Sent local media: ${mediaPath}`);
      } catch (err) {
        log?.error(`${prefix} sendMedia(auto) failed for ${mediaPath}: ${err}`);
      }
    }
  }

  // 转发 tool 阶段收集的媒体
  if (toolMediaUrls.length > 0) {
    log?.info(
      `${prefix} Forwarding ${toolMediaUrls.length} tool-collected media URL(s) after block deliver`,
    );
    for (const mediaUrl of toolMediaUrls) {
      try {
        const result = await sendMediaAuto({
          to: qualifiedTarget,
          text: "",
          mediaUrl,
          accountId: account.accountId,
          replyToId: event.messageId,
          account,
        });
        if (result.error) log?.error(`${prefix} Tool media forward error: ${result.error}`);
        else log?.info(`${prefix} Forwarded tool media: ${mediaUrl.slice(0, 80)}...`);
      } catch (err) {
        log?.error(`${prefix} Tool media forward failed: ${err}`);
      }
    }
    toolMediaUrls.length = 0;
  }
}

// ============ 内部辅助函数 ============

/** 解码媒体路径：剥离 MEDIA: 前缀、展开 ~、修复转义 */
function decodeMediaPath(raw: string, log: DeliverAccountContext["log"], prefix: string): string {
  let mediaPath = raw;
  if (mediaPath.startsWith("MEDIA:")) {
    mediaPath = mediaPath.slice("MEDIA:".length);
  }
  mediaPath = normalizePath(mediaPath);
  mediaPath = mediaPath.replace(/\\\\/g, "\\");

  try {
    const hasOctal = /\\[0-7]{1,3}/.test(mediaPath);
    const hasNonASCII = /[\u0080-\u00FF]/.test(mediaPath);

    if (hasOctal || hasNonASCII) {
      log?.debug?.(`${prefix} Decoding path with mixed encoding: ${mediaPath}`);
      let decoded = mediaPath.replace(/\\([0-7]{1,3})/g, (_: string, octal: string) => {
        return String.fromCharCode(parseInt(octal, 8));
      });
      const bytes: number[] = [];
      for (let i = 0; i < decoded.length; i++) {
        const code = decoded.charCodeAt(i);
        if (code <= 0xff) {
          bytes.push(code);
        } else {
          const charBytes = Buffer.from(decoded[i], "utf8");
          bytes.push(...charBytes);
        }
      }
      const buffer = Buffer.from(bytes);
      const utf8Decoded = buffer.toString("utf8");
      if (!utf8Decoded.includes("\uFFFD") || utf8Decoded.length < decoded.length) {
        mediaPath = utf8Decoded;
        log?.debug?.(`${prefix} Successfully decoded path: ${mediaPath}`);
      }
    }
  } catch (decodeErr) {
    log?.error(`${prefix} Path decode error: ${decodeErr}`);
  }

  return mediaPath;
}

/** 发送文本分块（共用逻辑） */
async function sendTextChunks(
  text: string,
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
): Promise<void> {
  const { account, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;
  const chunks = getQQBotRuntime().channel.text.chunkMarkdownText(text, TEXT_CHUNK_LIMIT);
  for (const chunk of chunks) {
    try {
      await sendWithRetry(async (token) => {
        const ref = consumeQuoteRef();
        if (event.type === "c2c") {
          return await sendC2CMessage(
            account.appId,
            token,
            event.senderId,
            chunk,
            event.messageId,
            ref,
          );
        } else if (event.type === "group" && event.groupOpenid) {
          return await sendGroupMessage(
            account.appId,
            token,
            event.groupOpenid,
            chunk,
            event.messageId,
          );
        } else if (event.channelId) {
          return await sendChannelMessage(token, event.channelId, chunk, event.messageId);
        }
      });
      log?.info(
        `${prefix} Sent text chunk (${chunk.length}/${text.length} chars): ${chunk.slice(0, 50)}...`,
      );
    } catch (err) {
      log?.error(`${prefix} Failed to send text chunk: ${err}`);
    }
  }
}

/** 语音发送（带 45s 超时保护） */
async function sendVoiceWithTimeout(
  target: MediaTargetContext,
  voicePath: string,
  account: ResolvedQQBotAccount,
  log: DeliverAccountContext["log"],
  prefix: string,
): Promise<void> {
  const uploadFormats =
    account.config?.audioFormatPolicy?.uploadDirectFormats ??
    account.config?.voiceDirectUploadFormats;
  const transcodeEnabled = account.config?.audioFormatPolicy?.transcodeEnabled !== false;
  const voiceTimeout = 45000;
  try {
    const result = await Promise.race([
      sendVoice(target, voicePath, uploadFormats, transcodeEnabled),
      new Promise<{ channel: string; error: string }>((resolve) =>
        setTimeout(
          () => resolve({ channel: "qqbot", error: "语音发送超时，已跳过" }),
          voiceTimeout,
        ),
      ),
    ]);
    if (result.error) log?.error(`${prefix} sendVoice error: ${result.error}`);
  } catch (err) {
    log?.error(`${prefix} sendVoice unexpected error: ${err}`);
  }
}

/** Markdown 模式发送 */
async function sendMarkdownReply(
  textWithoutImages: string,
  imageUrls: string[],
  mdMatches: RegExpMatchArray[],
  bareUrlMatches: RegExpMatchArray[],
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
): Promise<void> {
  const { account, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;

  // 分离图片：公网 URL vs Base64
  const httpImageUrls: string[] = [];
  const base64ImageUrls: string[] = [];
  for (const url of imageUrls) {
    if (url.startsWith("data:image/")) base64ImageUrls.push(url);
    else if (url.startsWith("http://") || url.startsWith("https://")) httpImageUrls.push(url);
  }
  log?.info(
    `${prefix} Image classification: httpUrls=${httpImageUrls.length}, base64=${base64ImageUrls.length}`,
  );

  // 发送 Base64 图片
  if (base64ImageUrls.length > 0) {
    log?.info(`${prefix} Sending ${base64ImageUrls.length} image(s) via Rich Media API...`);
    for (const imageUrl of base64ImageUrls) {
      try {
        await sendWithRetry(async (token) => {
          if (event.type === "c2c") {
            await sendC2CImageMessage(
              account.appId,
              token,
              event.senderId,
              imageUrl,
              event.messageId,
            );
          } else if (event.type === "group" && event.groupOpenid) {
            await sendGroupImageMessage(
              account.appId,
              token,
              event.groupOpenid,
              imageUrl,
              event.messageId,
            );
          } else if (event.channelId) {
            log?.info(`${prefix} Channel does not support rich media, skipping Base64 image`);
          }
        });
        log?.info(
          `${prefix} Sent Base64 image via Rich Media API (size: ${imageUrl.length} chars)`,
        );
      } catch (imgErr) {
        log?.error(`${prefix} Failed to send Base64 image via Rich Media API: ${imgErr}`);
      }
    }
  }

  // 处理公网 URL 图片
  const existingMdUrls = new Set(mdMatches.map((m) => m[2]));
  const imagesToAppend: string[] = [];

  for (const url of httpImageUrls) {
    if (!existingMdUrls.has(url)) {
      try {
        const size = await getImageSize(url);
        imagesToAppend.push(formatQQBotMarkdownImage(url, size));
        log?.info(
          `${prefix} Formatted HTTP image: ${size ? `${size.width}x${size.height}` : "default size"} - ${url.slice(0, 60)}...`,
        );
      } catch (err) {
        log?.info(`${prefix} Failed to get image size, using default: ${err}`);
        imagesToAppend.push(formatQQBotMarkdownImage(url, null));
      }
    }
  }

  // 补充已有 markdown 图片的尺寸信息
  let result = textWithoutImages;
  for (const m of mdMatches) {
    const fullMatch = m[0];
    const imgUrl = m[2];
    const isHttpUrl = imgUrl.startsWith("http://") || imgUrl.startsWith("https://");
    if (isHttpUrl && !hasQQBotImageSize(fullMatch)) {
      try {
        const size = await getImageSize(imgUrl);
        result = result.replace(fullMatch, formatQQBotMarkdownImage(imgUrl, size));
        log?.info(
          `${prefix} Updated image with size: ${size ? `${size.width}x${size.height}` : "default"} - ${imgUrl.slice(0, 60)}...`,
        );
      } catch (err) {
        log?.info(`${prefix} Failed to get image size for existing md, using default: ${err}`);
        result = result.replace(fullMatch, formatQQBotMarkdownImage(imgUrl, null));
      }
    }
  }

  // 移除裸 URL 图片
  for (const m of bareUrlMatches) {
    result = result.replace(m[0], "").trim();
  }

  // 追加图片
  if (imagesToAppend.length > 0) {
    result = result.trim();
    result = result ? result + "\n\n" + imagesToAppend.join("\n") : imagesToAppend.join("\n");
  }

  // 发送 markdown 文本
  if (result.trim()) {
    const mdChunks = chunkText(result, TEXT_CHUNK_LIMIT);
    for (const chunk of mdChunks) {
      try {
        await sendWithRetry(async (token) => {
          const ref = consumeQuoteRef();
          if (event.type === "c2c") {
            return await sendC2CMessage(
              account.appId,
              token,
              event.senderId,
              chunk,
              event.messageId,
              ref,
            );
          } else if (event.type === "group" && event.groupOpenid) {
            return await sendGroupMessage(
              account.appId,
              token,
              event.groupOpenid,
              chunk,
              event.messageId,
            );
          } else if (event.channelId) {
            return await sendChannelMessage(token, event.channelId, chunk, event.messageId);
          }
        });
        log?.info(
          `${prefix} Sent markdown chunk (${chunk.length}/${result.length} chars) with ${httpImageUrls.length} HTTP images (${event.type})`,
        );
      } catch (err) {
        log?.error(`${prefix} Failed to send markdown message chunk: ${err}`);
      }
    }
  }
}

/** 普通文本模式发送 */
async function sendPlainTextReply(
  textWithoutImages: string,
  imageUrls: string[],
  mdMatches: RegExpMatchArray[],
  bareUrlMatches: RegExpMatchArray[],
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
): Promise<void> {
  const { account, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;

  const imgMediaTarget: MediaTargetContext = {
    targetType: event.type === "c2c" ? "c2c" : event.type === "group" ? "group" : "channel",
    targetId:
      event.type === "c2c"
        ? event.senderId
        : event.type === "group"
          ? event.groupOpenid!
          : event.channelId!,
    account,
    replyToId: event.messageId,
    logPrefix: prefix,
  };

  let result = textWithoutImages;
  for (const m of mdMatches) result = result.replace(m[0], "").trim();
  for (const m of bareUrlMatches) result = result.replace(m[0], "").trim();

  // 群聊 URL 点号过滤
  if (result && event.type !== "c2c") {
    result = result.replace(/([a-zA-Z0-9])\.([a-zA-Z0-9])/g, "$1_$2");
  }

  try {
    for (const imageUrl of imageUrls) {
      try {
        const imgResult = await sendPhoto(imgMediaTarget, imageUrl);
        if (imgResult.error) log?.error(`${prefix} Failed to send image: ${imgResult.error}`);
        else log?.info(`${prefix} Sent image via sendPhoto: ${imageUrl.slice(0, 80)}...`);
      } catch (imgErr) {
        log?.error(`${prefix} Failed to send image: ${imgErr}`);
      }
    }

    if (result.trim()) {
      const plainChunks = chunkText(result, TEXT_CHUNK_LIMIT);
      for (const chunk of plainChunks) {
        await sendWithRetry(async (token) => {
          const ref = consumeQuoteRef();
          if (event.type === "c2c") {
            return await sendC2CMessage(
              account.appId,
              token,
              event.senderId,
              chunk,
              event.messageId,
              ref,
            );
          } else if (event.type === "group" && event.groupOpenid) {
            return await sendGroupMessage(
              account.appId,
              token,
              event.groupOpenid,
              chunk,
              event.messageId,
            );
          } else if (event.channelId) {
            return await sendChannelMessage(token, event.channelId, chunk, event.messageId);
          }
        });
        log?.info(
          `${prefix} Sent text chunk (${chunk.length}/${result.length} chars) (${event.type})`,
        );
      }
    }
  } catch (err) {
    log?.error(`${prefix} Send failed: ${err}`);
  }
}
