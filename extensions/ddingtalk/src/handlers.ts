import type { DingTalkMessageData, ResolvedDingTalkAccount, AudioContent, VideoContent, FileContent, PictureContent, RichTextContent, RichTextElement, RichTextPictureElement } from "./types.js";
import type { MediaItem, InboundMediaContext } from "./media.js";
import { downloadAndSaveMedia, getErrorMessage } from "./media.js";
import { logger } from "./logger.js";

// ============================================================================
// 消息处理器类型定义
// ============================================================================

/** 消息处理结果 */
export interface MessageHandleResult {
  /** 是否成功处理 */
  success: boolean;
  /** 媒体上下文（支持多媒体混排） */
  media?: InboundMediaContext;
  /** 错误信息 */
  errorMessage?: string;
  /** 是否需要跳过后续处理 */
  skipProcessing?: boolean;
}

/** 消息处理器接口 */
export interface MessageHandler {
  /** 是否能处理该消息类型 */
  canHandle(data: DingTalkMessageData): boolean;
  /** 获取消息预览（用于日志） */
  getPreview(data: DingTalkMessageData): string;
  /** 校验消息 */
  validate(data: DingTalkMessageData): { valid: boolean; errorMessage?: string };
  /** 处理消息 */
  handle(data: DingTalkMessageData, account: ResolvedDingTalkAccount): Promise<MessageHandleResult>;
}

// ============================================================================
// 消息处理器实现
// ============================================================================

/** 文本消息处理器 */
const textMessageHandler: MessageHandler = {
  canHandle: (data) => data.msgtype === "text",

  getPreview: (data) => {
    const text = data.text?.content?.trim() ?? "";
    return text.slice(0, 50) + (text.length > 50 ? "..." : "");
  },

  validate: (data) => {
    const text = data.text?.content?.trim() ?? "";
    if (!text) {
      return { valid: false, errorMessage: undefined }; // 空消息静默忽略，不需要回复错误
    }
    return { valid: true };
  },

  handle: async () => {
    // 文本消息不需要预处理，直接返回成功
    return { success: true };
  },
};

/** 图片消息处理器 */
const pictureMessageHandler: MessageHandler = {
  canHandle: (data) => data.msgtype === "picture",

  getPreview: () => "[图片]",

  validate: (data) => {
    const content = data.content as PictureContent | undefined;
    const downloadCode = content?.downloadCode ?? content?.pictureDownloadCode;
    if (!downloadCode) {
      return { valid: false, errorMessage: "图片处理失败：缺少下载码" };
    }
    return { valid: true };
  },

  handle: async (data, account) => {
    const content = data.content as PictureContent;
    const downloadCode = (content?.downloadCode ?? content?.pictureDownloadCode)!;

    try {
      const saved = await downloadAndSaveMedia({
        downloadCode,
        account,
        mediaKind: "picture",
        extension: content?.extension,
      });

      const mediaItem: MediaItem = {
        kind: "picture",
        path: saved.path,
        contentType: saved.contentType,
        fileSize: saved.fileSize,
      };

      return {
        success: true,
        media: { items: [mediaItem], primary: mediaItem },
      };
    } catch (err) {
      logger.error("图片处理失败：", err);
      return { success: false, errorMessage: `图片处理失败：${getErrorMessage(err)}` };
    }
  },
};

/** 语音消息处理器 */
const audioMessageHandler: MessageHandler = {
  canHandle: (data) => data.msgtype === "audio",

  getPreview: (data) => {
    const content = data.content as AudioContent | undefined;
    const duration = content?.duration;
    return duration ? `[语音 ${(duration / 1000).toFixed(1)}s]` : "[语音]";
  },

  validate: (data) => {
    const content = data.content as AudioContent | undefined;
    if (!content?.downloadCode) {
      return { valid: false, errorMessage: "语音处理失败：缺少下载码" };
    }
    return { valid: true };
  },

  handle: async (data, account) => {
    const content = data.content as AudioContent;
    const downloadCode = content.downloadCode!;

    try {
      const saved = await downloadAndSaveMedia({
        downloadCode,
        account,
        mediaKind: "audio",
        extension: content.extension ?? "amr",
      });

      const mediaItem: MediaItem = {
        kind: "audio",
        path: saved.path,
        contentType: saved.contentType,
        fileSize: saved.fileSize,
        duration: content.duration ? content.duration / 1000 : undefined,
      };

      return {
        success: true,
        media: { items: [mediaItem], primary: mediaItem },
      };
    } catch (err) {
      logger.error("语音处理失败：", err);
      return { success: false, errorMessage: `语音处理失败：${getErrorMessage(err)}` };
    }
  },
};

/** 视频消息处理器 */
const videoMessageHandler: MessageHandler = {
  canHandle: (data) => data.msgtype === "video",

  getPreview: (data) => {
    const content = data.content as VideoContent | undefined;
    const duration = content?.duration;
    return duration ? `[视频 ${(duration / 1000).toFixed(1)}s]` : "[视频]";
  },

  validate: (data) => {
    const content = data.content as VideoContent | undefined;
    if (!content?.downloadCode) {
      return { valid: false, errorMessage: "视频处理失败：缺少下载码" };
    }
    return { valid: true };
  },

  handle: async (data, account) => {
    const content = data.content as VideoContent;
    const downloadCode = content.downloadCode!;

    try {
      const saved = await downloadAndSaveMedia({
        downloadCode,
        account,
        mediaKind: "video",
        extension: content.extension ?? "mp4",
      });

      const mediaItem: MediaItem = {
        kind: "video",
        path: saved.path,
        contentType: saved.contentType,
        fileSize: saved.fileSize,
        duration: content.duration ? content.duration / 1000 : undefined,
      };

      return {
        success: true,
        media: { items: [mediaItem], primary: mediaItem },
      };
    } catch (err) {
      logger.error("视频处理失败：", err);
      return { success: false, errorMessage: `视频处理失败：${getErrorMessage(err)}` };
    }
  },
};

/** 文件消息处理器 */
const fileMessageHandler: MessageHandler = {
  canHandle: (data) => data.msgtype === "file",

  getPreview: (data) => {
    const content = data.content as FileContent | undefined;
    const fileName = content?.fileName;
    return fileName ? `[文件] ${fileName}` : "[文件]";
  },

  validate: (data) => {
    const content = data.content as FileContent | undefined;
    if (!content?.downloadCode) {
      return { valid: false, errorMessage: "文件处理失败：缺少下载码" };
    }
    return { valid: true };
  },

  handle: async (data, account) => {
    const content = data.content as FileContent;
    const downloadCode = content.downloadCode!;

    try {
      const saved = await downloadAndSaveMedia({
        downloadCode,
        account,
        mediaKind: "file",
        extension: content.extension,
        fileName: content.fileName,
      });

      const mediaItem: MediaItem = {
        kind: "file",
        path: saved.path,
        contentType: saved.contentType,
        fileSize: saved.fileSize,
        fileName: content.fileName,
      };

      return {
        success: true,
        media: { items: [mediaItem], primary: mediaItem },
      };
    } catch (err) {
      logger.error("文件处理失败：", err);
      return { success: false, errorMessage: `文件处理失败：${getErrorMessage(err)}` };
    }
  },
};

// ============================================================================
// 富文本消息处理辅助函数
// ============================================================================

/** 判断富文本元素是否为图片 */
function isRichTextPicture(element: RichTextElement): element is RichTextPictureElement {
  return element.type === "picture";
}

/** 从富文本元素中提取下载码 */
function getRichTextPictureDownloadCode(element: RichTextPictureElement): string | undefined {
  return element.downloadCode ?? element.pictureDownloadCode;
}

/** 解析富文本内容，提取文本和图片信息 */
function parseRichTextContent(content: RichTextContent): {
  textParts: string[];
  imageInfos: Array<{
    downloadCode: string;
    width?: number;
    height?: number;
    extension?: string;
  }>;
} {
  const textParts: string[] = [];
  const imageInfos: Array<{
    downloadCode: string;
    width?: number;
    height?: number;
    extension?: string;
  }> = [];

  for (const element of content.richText) {
    if (isRichTextPicture(element)) {
      // 图片元素
      const downloadCode = getRichTextPictureDownloadCode(element);
      if (downloadCode) {
        imageInfos.push({
          downloadCode,
          width: element.width,
          height: element.height,
          extension: element.extension,
        });
      }
    } else {
      // 文本元素（type 为 undefined 或 "text"）
      if (element.text) {
        textParts.push(element.text);
      }
    }
  }

  return { textParts, imageInfos };
}

/** 富文本消息处理器 */
const richTextMessageHandler: MessageHandler = {
  canHandle: (data) => data.msgtype === "richText",

  getPreview: (data) => {
    const content = data.content as RichTextContent | undefined;
    if (!content?.richText) return "[富文本]";

    const { textParts, imageInfos } = parseRichTextContent(content);
    const textPreview = textParts.join(" ").slice(0, 30);
    const imageCount = imageInfos.length;

    if (textPreview && imageCount > 0) {
      return `[图文] ${textPreview}${textParts.join(" ").length > 30 ? "..." : ""} +${imageCount}图`;
    } else if (textPreview) {
      return `[富文本] ${textPreview}${textParts.join(" ").length > 30 ? "..." : ""}`;
    } else if (imageCount > 0) {
      return `[图文] ${imageCount}张图片`;
    }
    return "[富文本]";
  },

  validate: (data) => {
    const content = data.content as RichTextContent | undefined;
    if (!content?.richText || !Array.isArray(content.richText)) {
      return { valid: false, errorMessage: "富文本消息格式错误" };
    }
    // 至少要有文本或图片
    const { textParts, imageInfos } = parseRichTextContent(content);
    if (textParts.length === 0 && imageInfos.length === 0) {
      return { valid: false, errorMessage: undefined }; // 空消息静默忽略
    }
    return { valid: true };
  },

  handle: async (data, account) => {
    const content = data.content as RichTextContent;
    const { textParts, imageInfos } = parseRichTextContent(content);

    try {
      const mediaItems: MediaItem[] = [];

      // 下载并保存所有图片
      for (let i = 0; i < imageInfos.length; i++) {
        const imgInfo = imageInfos[i];
        logger.log(`处理富文本图片 ${i + 1}/${imageInfos.length}...`);

        const saved = await downloadAndSaveMedia({
          downloadCode: imgInfo.downloadCode,
          account,
          mediaKind: "picture",
          extension: imgInfo.extension,
        });

        mediaItems.push({
          kind: "picture",
          path: saved.path,
          contentType: saved.contentType,
          fileSize: saved.fileSize,
        });
      }

      // 构建媒体上下文
      // 对于图文混排，将文本内容存入 data.text 以便后续处理
      // 这里通过修改 data 对象来传递文本内容
      const combinedText = textParts.join("\n").trim();
      if (combinedText) {
        // 将富文本中的文本内容写入 text 字段，以便后续流程使用
        data.text = { content: combinedText };
      }

      const media: InboundMediaContext | undefined = mediaItems.length > 0
        ? { items: mediaItems, primary: mediaItems[0] }
        : undefined;

      return {
        success: true,
        media,
      };
    } catch (err) {
      logger.error("富文本消息处理失败：", err);
      return { success: false, errorMessage: `富文本消息处理失败：${getErrorMessage(err)}` };
    }
  },
};

/** 不支持的消息类型处理器 */
const unsupportedMessageHandler: MessageHandler = {
  canHandle: () => true, // 作为兜底处理器

  getPreview: (data) => `[${data.msgtype}]`,

  validate: () => ({
    valid: false,
    errorMessage: "暂不支持该类型消息，请发送文本、图片、语音、视频、文件或图文混排消息。",
  }),

  handle: async () => {
    return { success: false, skipProcessing: true };
  },
};

/** 消息处理器注册表（按优先级排序） */
const messageHandlers: MessageHandler[] = [
  textMessageHandler,
  pictureMessageHandler,
  audioMessageHandler,
  videoMessageHandler,
  fileMessageHandler,
  richTextMessageHandler,
  unsupportedMessageHandler, // 兜底处理器必须放在最后
];

/** 获取消息处理器 */
export function getMessageHandler(data: DingTalkMessageData): MessageHandler {
  return messageHandlers.find((h) => h.canHandle(data))!;
}
