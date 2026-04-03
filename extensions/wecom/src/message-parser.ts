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
    corpid?: string;
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
  event?: {
    eventtype?: string;
    template_card_event?: {
      card_type?: string;
      event_key?: string;
      task_id?: string;
      selected_items?: {
        selected_item?: Array<{
          question_key?: string;
          option_ids?: {
            option_id?: string[];
          };
        }>;
      };
    };
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
 * 将模板卡片事件回调格式化为可继续路由给大模型的文本。
 *
 * 这样后续 Agent 可以直接从 question_key / option_id 中理解用户的真实选择。
 */
function buildTemplateCardEventText(body: MessageBody): string | undefined {
  const templateCardEvent = body.event?.template_card_event;
  if (
    body.msgtype !== "event" ||
    body.event?.eventtype !== "template_card_event" ||
    !templateCardEvent
  ) {
    return undefined;
  }

  const selectedItems = templateCardEvent.selected_items?.selected_item ?? [];
  const selectedLines = selectedItems.map((item) => {
    const questionKey = item.question_key?.trim() || "unknown_question";
    const optionIds = item.option_ids?.option_id?.filter(Boolean) ?? [];
    return `- ${questionKey}: ${optionIds.length > 0 ? optionIds.join(", ") : "(未选择)"}`;
  });

  const senderUserId = body.from?.userid || "";
  const senderCorpId = body.from?.corpid || "";
  const chatId = body.chatid || senderUserId;

  return [
    "[企业微信模板卡片回调]",
    `event_type(事件类型): template_card_event`,
    body.msgid ? `msgid(消息 id): ${body.msgid}` : undefined,
    body.aibotid ? `aibotid(机器人 id): ${body.aibotid}` : undefined,
    body.chattype ? `chat_type(会话类型): ${body.chattype}` : undefined,
    chatId ? `chat_id(会话 id): ${chatId}` : undefined,
    senderCorpId ? `from.corpid(企业 id): ${senderCorpId}` : undefined,
    senderUserId ? `from.userid(发送人 id): ${senderUserId}` : undefined,
    senderUserId ? `sender_userid(发送人 id): ${senderUserId}` : undefined,
    templateCardEvent.card_type ? `card_type(卡片类型): ${templateCardEvent.card_type}` : undefined,
    templateCardEvent.event_key ? `event_key(事件 key): ${templateCardEvent.event_key}` : undefined,
    templateCardEvent.task_id ? `task_id(任务 id): ${templateCardEvent.task_id}` : undefined,
    selectedLines.length > 0 ? "selected_items(选择项):" : "selected_items(选择项): []",
    ...selectedLines,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/**
 * 解析消息内容（支持单条消息、图文混排、事件回调和引用消息）
 * @returns 提取的文本数组、图片URL数组和引用消息内容
 */
export function parseMessageContent(body: MessageBody): ParsedMessageContent {
  const textParts: string[] = [];
  const imageUrls: string[] = [];
  const imageAesKeys = new Map<string, string>();
  const fileUrls: string[] = [];
  const fileAesKeys = new Map<string, string>();
  let quoteContent: string | undefined;

  // 处理模板卡片事件回调
  
  if (body.msgtype === "event") {
    const eventText = buildTemplateCardEventText(body);
    if (eventText) {
      textParts.push(eventText);
    }
    return { textParts, imageUrls, imageAesKeys, fileUrls, fileAesKeys, quoteContent };
  }

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
