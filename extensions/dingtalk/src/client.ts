import dingtalk from "@alicloud/dingtalk";
import * as $OpenApi from "@alicloud/openapi-client";
import * as $Util from "@alicloud/tea-util";
import { logger } from "./logger.js";
import type { ResolvedDingTalkAccount, WebhookResponse, MarkdownReplyBody } from "./types.js";

const { oauth2_1_0, robot_1_0 } = dingtalk;

// SDK 客户端类型
type OAuth2Client = InstanceType<typeof oauth2_1_0.default>;
type RobotClient = InstanceType<typeof robot_1_0.default>;

// ======================= Access Token 缓存 =======================

interface TokenCache {
  token: string;
  expireTime: number;
}

const tokenCacheMap = new Map<string, TokenCache>();

/**
 * 创建 OAuth2 客户端
 */
function createOAuth2Client(): OAuth2Client {
  const config = new $OpenApi.Config({});
  config.protocol = "https";
  config.regionId = "central";
  return new oauth2_1_0.default(config);
}

/**
 * 创建 Robot 客户端
 */
function createRobotClient(): RobotClient {
  const config = new $OpenApi.Config({});
  config.protocol = "https";
  config.regionId = "central";
  return new robot_1_0.default(config);
}

/**
 * 获取钉钉 access_token
 */
export async function getAccessToken(account: ResolvedDingTalkAccount): Promise<string> {
  const cacheKey = `${account.clientId}`;
  const cached = tokenCacheMap.get(cacheKey);

  // 检查缓存的 token 是否有效（提前5分钟过期）
  if (cached && Date.now() < cached.expireTime - 5 * 60 * 1000) {
    return cached.token;
  }

  const oauth2Client = createOAuth2Client();
  const request = new oauth2_1_0.GetAccessTokenRequest({
    appKey: account.clientId,
    appSecret: account.clientSecret,
  });

  const response = await oauth2Client.getAccessToken(request);

  if (response.body?.accessToken) {
    const token = response.body.accessToken;
    const expireTime = Date.now() + (response.body.expireIn ?? 7200) * 1000;
    tokenCacheMap.set(cacheKey, { token, expireTime });
    return token;
  }

  throw new Error("获取 access_token 失败: 返回结果为空");
}

// ======================= 发送消息 =======================

export interface SendMessageOptions {
  account: ResolvedDingTalkAccount;
  verbose?: boolean;
}

export interface SendMessageResult {
  messageId: string;
  chatId: string;
}

/**
 * 通过 sessionWebhook 回复消息（markdown 格式）
 */
export async function replyViaWebhook(
  webhook: string,
  content: string,
  options?: {
    atUserIds?: string[];
    isAtAll?: boolean;
  },
): Promise<WebhookResponse> {
  const contentPreview = content.slice(0, 50).replace(/\n/g, " ");
  logger.log(`[回复消息] via Webhook | ${contentPreview}${content.length > 50 ? "..." : ""}`);

  const title = content.slice(0, 10).replace(/\n/g, " ");
  const body: MarkdownReplyBody = {
    msgtype: "markdown",
    markdown: {
      title,
      text: content,
    },
    at: {
      atUserIds: options?.atUserIds ?? [],
      isAtAll: options?.isAtAll ?? false,
    },
  };

  const response = await fetch(webhook, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const result = (await response.json()) as WebhookResponse;

  if (result.errcode === 0) {
    logger.log(`[回复消息] 发送成功`);
  } else {
    logger.error(`[回复消息] 发送失败: ${result.errmsg ?? JSON.stringify(result)}`);
  }

  return result;
}

// ======================= 主动发送消息（BatchSendOTO） =======================

/**
 * 钉钉机器人消息类型（msgKey）
 * @see https://open.dingtalk.com/document/orgapp/types-of-messages-sent-by-enterprise-robots
 */
export type DingTalkMsgKey =
  | "sampleText" // 文本
  | "sampleMarkdown" // Markdown
  | "sampleImageMsg" // 图片
  | "sampleLink" // 链接
  | "sampleAudio" // 语音
  | "sampleVideo" // 视频
  | "sampleFile" // 文件
  | "sampleActionCard" // 卡片
  | "sampleActionCard2" // 卡片（独立跳转）
  | "sampleActionCard3" // 卡片（竖向按钮）
  | "sampleActionCard4" // 卡片（横向按钮）
  | "sampleActionCard5" // 卡片（横向2按钮）
  | "sampleActionCard6"; // 卡片（横向3按钮）

/**
 * 底层通用方法：主动发送单聊消息（BatchSendOTO）
 * 所有 sendXxxMessage 方法都基于此方法实现
 */
async function sendOTOMessage(
  userId: string,
  msgKey: DingTalkMsgKey,
  msgParam: Record<string, unknown>,
  options: SendMessageOptions,
): Promise<SendMessageResult> {
  const accessToken = await getAccessToken(options.account);
  const robotClient = createRobotClient();

  const headers = new robot_1_0.BatchSendOTOHeaders({
    xAcsDingtalkAccessToken: accessToken,
  });

  const request = new robot_1_0.BatchSendOTORequest({
    robotCode: options.account.clientId,
    userIds: [userId],
    msgKey,
    msgParam: JSON.stringify(msgParam),
  });

  const response = await robotClient.batchSendOTOWithOptions(
    request,
    headers,
    new $Util.RuntimeOptions({}),
  );

  const processQueryKey = response.body?.processQueryKey ?? `dingtalk-${Date.now()}`;

  return {
    messageId: processQueryKey,
    chatId: userId,
  };
}

/**
 * 发送文本消息（markdown 格式）
 */
export async function sendTextMessage(
  userId: string,
  content: string,
  options: SendMessageOptions,
): Promise<SendMessageResult> {
  const contentPreview = content.slice(0, 50).replace(/\n/g, " ");
  logger.log(
    `[主动发送] 文本消息 | to: ${userId} | ${contentPreview}${content.length > 50 ? "..." : ""}`,
  );

  const title = content.slice(0, 10).replace(/\n/g, " ");
  const result = await sendOTOMessage(userId, "sampleMarkdown", { title, text: content }, options);

  logger.log(`[主动发送] 文本消息发送成功 | messageId: ${result.messageId}`);
  return result;
}

/**
 * 发送图片消息
 * @param photoURL - 图片的公网可访问 URL
 */
export async function sendImageMessage(
  userId: string,
  photoURL: string,
  options: SendMessageOptions,
): Promise<SendMessageResult> {
  logger.log(`[主动发送] 图片消息 | to: ${userId} | photoURL: ${photoURL.slice(0, 80)}...`);

  const result = await sendOTOMessage(userId, "sampleImageMsg", { photoURL }, options);

  logger.log(`[主动发送] 图片消息发送成功 | messageId: ${result.messageId}`);
  return result;
}

/**
 * 发送语音消息
 * @param mediaId - 语音文件的 mediaId（通过 uploadMedia 获取）
 * @param duration - 语音时长（秒），可选
 */
export async function sendAudioMessage(
  userId: string,
  mediaId: string,
  options: SendMessageOptions & {
    duration?: string;
  },
): Promise<SendMessageResult> {
  logger.log(
    `[主动发送] 语音消息 | to: ${userId} | mediaId: ${mediaId} | duration: ${options.duration ?? "未知"}`,
  );

  // 构建 msgParam，只包含有值的字段
  const msgParam: Record<string, string> = { mediaId };
  if (options.duration) {
    msgParam.duration = options.duration;
  }

  const result = await sendOTOMessage(userId, "sampleAudio", msgParam, options);

  logger.log(`[主动发送] 语音消息发送成功 | messageId: ${result.messageId}`);
  return result;
}

/**
 * 发送视频消息
 * @param videoMediaId - 视频文件的 mediaId（通过 uploadMedia 获取）
 * @param options.duration - 视频时长（毫秒），可选
 * @param options.picMediaId - 视频封面图的 mediaId，可选
 * @param options.width - 视频宽度（像素），可选
 * @param options.height - 视频高度（像素），可选
 */
export async function sendVideoMessage(
  userId: string,
  videoMediaId: string,
  options: SendMessageOptions & {
    duration?: string;
    picMediaId?: string;
    width?: string;
    height?: string;
  },
): Promise<SendMessageResult> {
  logger.log(`[主动发送] 视频消息 | to: ${userId} | videoMediaId: ${videoMediaId}`);

  // 构建 msgParam，只包含有值的字段
  const msgParam: Record<string, string> = {
    videoMediaId,
    videoType: "mp4",
  };
  if (options.duration) {
    msgParam.duration = options.duration;
  }
  if (options.picMediaId) {
    msgParam.picMediaId = options.picMediaId;
  }
  if (options.width) {
    msgParam.width = options.width;
  }
  if (options.height) {
    msgParam.height = options.height;
  }

  const result = await sendOTOMessage(userId, "sampleVideo", msgParam, options);

  logger.log(`[主动发送] 视频消息发送成功 | messageId: ${result.messageId}`);
  return result;
}

/**
 * 发送文件消息
 * @param mediaId - 文件的 mediaId（通过 uploadMedia 获取）
 * @param fileName - 文件名
 * @param fileType - 文件扩展名（如 pdf、doc 等）
 */
export async function sendFileMessage(
  userId: string,
  mediaId: string,
  fileName: string,
  fileType: string,
  options: SendMessageOptions,
): Promise<SendMessageResult> {
  logger.log(`[主动发送] 文件消息 | to: ${userId} | fileName: ${fileName} | fileType: ${fileType}`);

  const result = await sendOTOMessage(
    userId,
    "sampleFile",
    { mediaId, fileName, fileType },
    options,
  );

  logger.log(`[主动发送] 文件消息发送成功 | messageId: ${result.messageId}`);
  return result;
}

/**
 * 发送链接消息
 * @param title - 链接标题
 * @param text - 链接描述
 * @param messageUrl - 点击后跳转的 URL
 * @param picUrl - 图片 URL（可选）
 */
export async function sendLinkMessage(
  userId: string,
  options: SendMessageOptions & {
    title: string;
    text: string;
    messageUrl: string;
    picUrl?: string;
  },
): Promise<SendMessageResult> {
  logger.log(`[主动发送] 链接消息 | to: ${userId} | title: ${options.title}`);

  const result = await sendOTOMessage(
    userId,
    "sampleLink",
    {
      title: options.title,
      text: options.text,
      messageUrl: options.messageUrl,
      picUrl: options.picUrl ?? "",
    },
    options,
  );

  logger.log(`[主动发送] 链接消息发送成功 | messageId: ${result.messageId}`);
  return result;
}

// ======================= 探测 Bot =======================

export interface DingTalkProbeResult {
  ok: boolean;
  bot?: {
    name?: string;
    robotCode?: string;
  };
  error?: string;
}

/**
 * 探测钉钉机器人状态
 */
export async function probeDingTalkBot(
  account: ResolvedDingTalkAccount,
  _timeoutMs?: number,
): Promise<DingTalkProbeResult> {
  try {
    // 尝试获取 access_token 来验证凭据是否有效
    await getAccessToken(account);
    return {
      ok: true,
      bot: {
        robotCode: account.clientId,
        name: account.name,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ======================= 图片处理 =======================

/**
 * 获取钉钉文件下载链接
 * @param downloadCode - 文件下载码
 * @param account - 钉钉账户配置
 * @returns 下载链接
 */
export async function getFileDownloadUrl(
  downloadCode: string,
  account: ResolvedDingTalkAccount,
): Promise<string> {
  const accessToken = await getAccessToken(account);
  const robotClient = createRobotClient();

  const headers = new robot_1_0.RobotMessageFileDownloadHeaders({
    xAcsDingtalkAccessToken: accessToken,
  });

  const request = new robot_1_0.RobotMessageFileDownloadRequest({
    downloadCode,
    robotCode: account.clientId,
  });

  const response = await robotClient.robotMessageFileDownloadWithOptions(
    request,
    headers,
    new $Util.RuntimeOptions({}),
  );

  if (response.body?.downloadUrl) {
    return response.body.downloadUrl;
  }

  throw new Error("获取下载链接失败: 返回结果为空");
}

/**
 * 从 URL 下载文件
 * @param url - 下载链接
 * @returns 文件内容 Buffer
 */
export async function downloadFromUrl(url: string): Promise<Buffer> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`下载文件失败: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ======================= 媒体文件上传 =======================

/**
 * 钉钉支持的媒体类型（media/upload 接口）
 * - image: 图片，最大 20MB，支持 jpg/gif/png/bmp
 * - voice: 语音，最大 2MB，支持 amr/mp3/wav
 * - video: 视频，最大 20MB，支持 mp4
 * - file: 普通文件，最大 20MB，支持 doc/docx/xls/xlsx/ppt/pptx/zip/pdf/rar
 */
export type DingTalkMediaType = "image" | "voice" | "video" | "file";

export interface UploadMediaResult {
  mediaId: string;
  /** 图片类型返回公网可访问 URL，其他类型返回空字符串 */
  url: string;
  /** 媒体类型 */
  type: DingTalkMediaType;
}

/**
 * 根据 MIME 类型推断钉钉媒体类型
 */
export function inferMediaType(mimeType: string): DingTalkMediaType {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("audio/")) {
    return "voice";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  return "file";
}

/**
 * 根据媒体类型获取对应的 Content-Type
 */
function getContentType(type: DingTalkMediaType, mimeType?: string): string {
  if (mimeType) {
    return mimeType;
  }
  switch (type) {
    case "image":
      return "image/png";
    case "voice":
      return "audio/amr";
    case "video":
      return "video/mp4";
    case "file":
    default:
      return "application/octet-stream";
  }
}

/**
 * 上传媒体文件到钉钉（使用旧版 oapi 接口）
 * @param fileBuffer - 文件 Buffer
 * @param fileName - 文件名
 * @param account - 钉钉账户配置
 * @param options - 上传选项
 * @returns 包含 media_id 和公网可访问 URL 的对象
 */
export async function uploadMedia(
  fileBuffer: Buffer,
  fileName: string,
  account: ResolvedDingTalkAccount,
  options?: {
    /** 媒体类型，不传则根据 mimeType 自动推断 */
    type?: DingTalkMediaType;
    /** MIME 类型，用于推断媒体类型和设置 Content-Type */
    mimeType?: string;
  },
): Promise<UploadMediaResult> {
  const mimeType = options?.mimeType;
  const type = options?.type ?? (mimeType ? inferMediaType(mimeType) : "image");
  const contentType = getContentType(type, mimeType);

  logger.log(`[上传媒体] type: ${type} | fileName: ${fileName} | size: ${fileBuffer.length} bytes`);

  const accessToken = await getAccessToken(account);

  // 使用 FormData 上传
  const formData = new FormData();
  const uint8Array = new Uint8Array(fileBuffer);
  const blob = new Blob([uint8Array], { type: contentType });
  formData.append("media", blob, fileName);
  formData.append("type", type);

  const response = await fetch(
    `https://oapi.dingtalk.com/media/upload?access_token=${accessToken}`,
    {
      method: "POST",
      body: formData,
    },
  );

  const result = (await response.json()) as {
    errcode?: number;
    errmsg?: string;
    media_id?: string;
  };

  if (result.errcode === 0 && result.media_id) {
    logger.log(`[上传媒体] 上传成功 | mediaId: ${result.media_id}`);

    // 只有图片类型才构造公网可访问的 URL
    const url =
      type === "image"
        ? `https://oapi.dingtalk.com/media/downloadFile?access_token=${accessToken}&media_id=${result.media_id}`
        : "";

    return {
      mediaId: result.media_id,
      url,
      type,
    };
  }

  logger.error(`[上传媒体] 上传失败: ${result.errmsg ?? JSON.stringify(result)}`);
  throw new Error(`上传媒体文件失败: ${result.errmsg ?? JSON.stringify(result)}`);
}
