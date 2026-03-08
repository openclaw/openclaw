/**
 * 企业微信消息内容解析模块
 *
 * 负责从 WsFrame 中提取文本、图片、引用等内容
 */

// ============================================================================
// 消息体类型（来自 SDK WsFrame.body）
// ============================================================================

export interface MessageBody {
  msgid: string;
  aibotid?: string;
  chatid?: string;
  chattype: "single" | "group";
  from: {
    userid: string;
  };
  response_url?: string;
  msgtype: string;
  text?: {
    content: string;
  };
  image?: {
    url?: string;
    aeskey?: string;
  };
  voice?: {
    content?: string;
  };
  mixed?: {
    msg_item: Array<{
      msgtype: "text" | "image";
      text?: { content: string };
      image?: { url?: string; aeskey?: string };
    }>;
  };
  file?: {
    url?: string;
    aeskey?: string;
  };
  quote?: {
    msgtype: string;
    text?: { content: string };
    voice?: { content: string };
    image?: { url?: string; aeskey?: string };
    file?: { url?: string; aeskey?: string };
  };
}

// ============================================================================
// 解析结果类型
// ============================================================================

export interface ParsedMessageContent {
  textParts: string[];
  imageUrls: string[];
  imageAesKeys: Map<string, string>;
  fileUrls: string[];
  fileAesKeys: Map<string, string>;
  quoteContent: string | undefined;
}

// ============================================================================
// 解析函数
// ============================================================================

/**
 * 解析消息内容（支持单条消息、图文混排和引用消息）
 * @returns 提取的文本数组、图片URL数组和引用消息内容
 */
export function parseMessageContent(body: MessageBody): ParsedMessageContent {
  const textParts: string[] = [];
  const imageUrls: string[] = [];
  const imageAesKeys = new Map<string, string>();
  const fileUrls: string[] = [];
  const fileAesKeys = new Map<string, string>();
  let quoteContent: string | undefined;

  // 处理图文混排消息
  if (body.msgtype === "mixed" && body.mixed?.msg_item) {
    for (const item of body.mixed.msg_item) {
      if (item.msgtype === "text" && item.text?.content) {
        textParts.push(item.text.content);
      } else if (item.msgtype === "image" && item.image?.url) {
        imageUrls.push(item.image.url);
        if (item.image.aeskey) {
          imageAesKeys.set(item.image.url, item.image.aeskey);
        }
      }
    }
  } else {
    // 处理单条消息
    if (body.text?.content) {
      textParts.push(body.text.content);
    }
    // 处理语音消息（语音转文字后的文本内容）
    if (body.msgtype === "voice" && body.voice?.content) {
      textParts.push(body.voice.content);
    }
    if (body.image?.url) {
      imageUrls.push(body.image.url);
      if (body.image.aeskey) {
        imageAesKeys.set(body.image.url, body.image.aeskey);
      }
    }
    // 处理文件消息
    if (body.msgtype === "file" && body.file?.url) {
      fileUrls.push(body.file.url);
      if (body.file.aeskey) {
        fileAesKeys.set(body.file.url, body.file.aeskey);
      }
    }
  }

  // 处理引用消息
  if (body.quote) {
    if (body.quote.msgtype === "text" && body.quote.text?.content) {
      quoteContent = body.quote.text.content;
    } else if (body.quote.msgtype === "voice" && body.quote.voice?.content) {
      quoteContent = body.quote.voice.content;
    } else if (body.quote.msgtype === "image" && body.quote.image?.url) {
      // 引用的图片消息：将图片 URL 加入下载列表
      imageUrls.push(body.quote.image.url);
      if (body.quote.image.aeskey) {
        imageAesKeys.set(body.quote.image.url, body.quote.image.aeskey);
      }
    } else if (body.quote.msgtype === "file" && body.quote.file?.url) {
      // 引用的文件消息：将文件 URL 加入下载列表
      fileUrls.push(body.quote.file.url);
      if (body.quote.file.aeskey) {
        fileAesKeys.set(body.quote.file.url, body.quote.file.aeskey);
      }
    }
  }

  return { textParts, imageUrls, imageAesKeys, fileUrls, fileAesKeys, quoteContent };
}
